// ============================================================
//  Slack Search & Match Bot — Google Apps Script
//  
//  A serverless Slack bot that accepts natural language queries,
//  fetches context from BigQuery, and returns LLM-ranked matches.
//
//  Setup:
//  1. Add Script Properties (Project Settings → Script Properties):
//     - SLACK_BOT_TOKEN      : Bot User OAuth Token from api.slack.com
//     - SLACK_SIGNING_SECRET : Signing Secret from your Slack app
//     - LLM_API_KEY          : Your LLM API key (Gemini used here)
//     - BQ_PROJECT_ID        : Your Google Cloud project ID
//     - LOG_SHEET_ID         : ID of the Google Sheet for cost logging
//  2. Enable BigQuery Advanced Service (Services → BigQuery API)
//  3. Deploy as Web App (Execute as: Me, Access: Anyone)
//  4. Paste the Web App URL into Slack Event Subscriptions
// ============================================================


// ─────────────────────────────────────────────
// CONFIG — reads all required properties at startup
// Throws early if any required key is missing
// ─────────────────────────────────────────────
function getConfig() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var required = ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET", "LLM_API_KEY", "BQ_PROJECT_ID"];
  required.forEach(function(key) {
    if (!props[key]) throw new Error("Missing required script property: " + key);
  });
  return props;
}


// ─────────────────────────────────────────────
// 1. ENTRY POINT
// Slack sends all events here via webhook.
// Handles: URL verification challenge, message events, app_mention events.
// Returns HTTP 200 immediately to avoid Slack retries.
// ─────────────────────────────────────────────
function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);

    // Slack sends a one-time verification challenge when you first connect the webhook
    if (payload.type === "url_verification") {
      return ContentService
        .createTextOutput(payload.challenge)
        .setMimeType(ContentService.MimeType.TEXT);
    }

    var event = payload.event;

    // Ignore bot messages, message edits/deletions, and empty events
    if (!event || event.bot_id || event.subtype) return ok();

    // Ignore Slack retry attempts — the original request is still being processed
    if (payload.retry_num && payload.retry_num > 0) return ok();

    // Process direct messages and @mentions
    if (event.type === "app_mention" || event.type === "message") {
      triggerAsync(event);
    }

    return ok();

  } catch(err) {
    Logger.log("doPost error: " + err.message);
    return ContentService
      .createTextOutput("ok")
      .setMimeType(ContentService.MimeType.TEXT);
  }
}

// Simple 200 OK response — Slack requires this within 3 seconds
function ok() {
  return ContentService
    .createTextOutput("ok")
    .setMimeType(ContentService.MimeType.TEXT);
}


// ─────────────────────────────────────────────
// 2. ASYNC PROCESSING
// Handles deduplication and orchestrates the full flow:
// fetch data → build prompt → call LLM → post to Slack
// ─────────────────────────────────────────────
function triggerAsync(event) {

  // Script-level lock prevents concurrent duplicate processing.
  // Slack retries failed webhooks — without this, the same message
  // would be processed multiple times.
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(3000);
  } catch(e) {
    Logger.log("Could not acquire lock for event: " + event.ts);
    return;
  }

  try {
    // Deduplication key: unique per message + channel combination
    var dedup = "bot_" + event.ts + "_" + event.channel;
    var props = PropertiesService.getScriptProperties();

    // If we've already processed this event, skip it
    if (props.getProperty(dedup)) {
      lock.releaseLock();
      return;
    }

    // Mark this event as processed before releasing the lock
    props.setProperty(dedup, "1");
    lock.releaseLock();

    var config = getConfig();

    // Strip the bot mention (@BotName) from the message text
    var userMessage = event.text
      .replace(/<@[A-Z0-9]+>/g, "")
      .trim();

    if (!userMessage) return;

    // 1. Fetch context data from BigQuery
    var warehouseData = readFromBigQuery(config.BQ_PROJECT_ID);

    // 2. Send to LLM with context injected into the prompt
    var answer = callLLM(userMessage, warehouseData, config.LLM_API_KEY);

    // 3. Handle CSV export requests
    // The LLM wraps CSV output in EXPORT_CSV_START / EXPORT_CSV_END tags
    if (answer.toUpperCase().indexOf("EXPORT_CSV_START") !== -1) {
      var parts = answer.split(/EXPORT_CSV_START/i);

      if (parts.length > 1) {
        var rawContent = parts[1];
        var csvContent = "";
        var isFallback = false;

        if (rawContent.toUpperCase().indexOf("EXPORT_CSV_END") !== -1) {
          csvContent = rawContent.split(/EXPORT_CSV_END/i)[0].trim();
        } else {
          // Fallback: LLM hit token limit before closing the tag
          csvContent = rawContent.split(/EXPORT_FILENAME:/i)[0].trim();
          isFallback = true;
        }

        var filenameMatch = answer.match(/EXPORT_FILENAME:\s*(.+)/i);
        var filename = filenameMatch ? filenameMatch[1].trim() : "export.csv";

        // Save CSV to Google Drive and get a shareable link
        var driveUrl = saveCSVToDrive(csvContent, filename);

        answer = "✅ *Export ready!*";
        if (isFallback) {
          answer += "\n⚠️ _Note: the list was truncated due to output size limits._";
        }
        answer += "\n\n📎 *Download:*\n" + driveUrl + "\n\n_Open → File → Download → CSV_";
      }
    }

    // 4. Post the answer back to the same Slack thread
    postToSlack(event.channel, answer, event.thread_ts || event.ts, config.SLACK_BOT_TOKEN);

  } catch(err) {
    if (lock.hasLock()) lock.releaseLock();
    Logger.log("triggerAsync error: " + err.message);

    // Notify the user in Slack if something goes wrong
    var config2 = PropertiesService.getScriptProperties().getProperties();
    if (config2.SLACK_BOT_TOKEN) {
      postToSlack(
        event.channel,
        ":warning: Something went wrong. Please try again or contact the admin.",
        event.thread_ts || event.ts,
        config2.SLACK_BOT_TOKEN
      );
    }
  }
}


// ─────────────────────────────────────────────
// 3. READ FROM BIGQUERY
// Fetches context data from three tables and formats it as text.
// The LLM receives this as part of the prompt context.
//
// Adapt the SQL queries below to match your schema.
// The goal is to return the most relevant fields for matching —
// avoid fetching large text columns or columns the LLM doesn't need.
// ─────────────────────────────────────────────
function readFromBigQuery(projectId) {

// ── TABLE 1: Client roster ──────────────────────────────────────
// Main client table. Include identifiers, segment, status,
// account health, and any fields useful for matching or ranking.
var query1 = `
  SELECT
    client_id,
    client_name,
    account_owner_email,
    country,
    segment,
    status,
    revenue_current_month,
    revenue_last_month,
    total_revenue_ytd,
    last_purchase_dt,
    last_login_dt,
    churn_risk_score,
    profile_url
  FROM \`your_dataset.your_clients_table\`
  WHERE status = 'active'
`;

// ── TABLE 2: Client activity & interaction log ──────────────────
// Qualitative and behavioral data — support tickets, NPS responses,
// call notes, feedback forms. Truncate long text to keep the
// context window manageable.
var query2 = `
  SELECT
    client_id,
    client_name,
    interaction_type,
    interaction_date,
    SUBSTR(notes, 1, 300) AS notes
  FROM \`your_dataset.your_interactions_table\`
  WHERE interaction_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)
`;

// ── TABLE 3: Pipeline / prospects ──────────────────────────────
// Leads and prospects not yet active. Won't appear in TABLE 1 —
// important to include separately for full coverage.
var query3 = `
  SELECT
    lead_id,
    full_name,
    company,
    account_owner_email,
    pipeline_stage,
    estimated_value,
    first_contact_dt,
    expected_close_dt
  FROM \`your_dataset.your_pipeline_table\`
  WHERE pipeline_stage != 'closed_lost'
`;

  var context = "";
  var queries = {
    "MAIN RECORDS": query1,
    "DETAILED INFO": query2,
    "PIPELINE": query3
  };

  // Execute each query and format as plain text for the prompt
  Object.keys(queries).forEach(function(label) {
    try {
      var response = BigQuery.Jobs.query(
        { query: queries[label], useLegacySql: false },
        projectId
      );

      var rows = (response.rows || []).map(function(row) {
        return response.schema.fields
          .map(function(f, i) {
            return f.name + ": " + (row.f[i].v || "");
          })
          .join(" | ");
      });

      context += "=== " + label + " ===\n" + rows.join("\n") + "\n\n";

    } catch(e) {
      Logger.log("BigQuery error [" + label + "]: " + e.message);
      context += "Error reading " + label + ": " + e.message + "\n\n";
    }
  });

  return context;
}


// ─────────────────────────────────────────────
// 4. CALL LLM API
// Sends the user's question + warehouse context to the LLM.
// Uses Gemini 2.5 Flash — swap the endpoint/payload for other models.
//
// TEMPERATURE: set to 0.3 for focused, consistent search/match responses.
// Increase to 0.5–0.7 for more conversational outputs.
// Keep below 0.3 for strict data retrieval tasks.
// ─────────────────────────────────────────────
function callLLM(userQuestion, warehouseData, apiKey) {

  // ── LLM endpoint ──────────────────────────────────────────────
  // Gemini 2.5 Flash (default). Replace with your preferred model.
  var url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + apiKey;

  // ── SYSTEM PROMPT ─────────────────────────────────────────────
  // This is where you define the bot's behavior, matching logic,
  // data source descriptions, and output format.
  //
  // Structure your prompt in three sections:
  //   1. ABOUT THE DATA — describe each table and its key fields
  //   2. YOUR GOAL — what the LLM is optimizing for
  //   3. BEHAVIOR RULES — output format, edge cases, export logic
  //
  // See README.md → Prompt Guide for detailed instructions.
  // ─────────────────────────────────────────────────────────────
  var SYSTEM_PROMPT = `
You are an intelligent dinossaur assistant called T-Rex that helps teams search and match records from a data warehouse (..) continue with your context here

ABOUT THE DATA:
- "MAIN RECORDS" contains the primary roster: identifiers, ratings, availability, and status.
- "DETAILED INFO" contains richer qualitative data: feedbacks, form responses, etc.
  Always cross-reference this table when matching requests.
- "PIPELINE" contains client pipeline information, important dates.
  They will not appear in MAIN RECORDS — treat them as a separate group.

YOUR GOAL:
Search across all three data sources and return the best matches for the user's query,
ranked by relevance. Cross-reference tables where possible to enrich each result.

BEHAVIOR RULES:
- Be concise and conversational.
- Use Slack markdown: *bold*, bullet points with -
- Exclude any record where do_not_hire = TRUE.
- If the query is vague, ask ONE focused clarifying question before answering.
- If no strong match exists, explain what criteria could not be met and suggest alternatives.
- Never fabricate data — only use what is present in the repository.
- For CSV export requests (file, download, spreadsheet), respond ONLY with:
    EXPORT_CSV_START
    name,email,profile_url
    Row 1 data...
    Row 2 data...
    EXPORT_CSV_END
    EXPORT_FILENAME: descriptive_filename.csv
  No conversational text. No preamble. The CSV block must be your entire response.

REPOSITORY DATA:
` + warehouseData;

  // ── API request payload ───────────────────────────────────────
  var body = {
    contents: [{
      role: "user",
      parts: [{ text: SYSTEM_PROMPT + "\n\nUser question: " + userQuestion }]
    }],
    generationConfig: {
      temperature: 0.3,      // Low temperature = focused, consistent matching
      maxOutputTokens: 16000 // Increase if exports are being truncated
    }
  };

  var response = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
    deadline: 60
  });

  var result = JSON.parse(response.getContentText());

  // ── COST TRACKING ─────────────────────────────────────────────
  // Log token usage and estimated cost after every API call.
  // This gives visibility into expensive query patterns and
  // makes the case for scaling to production much easier.
  //
  // Pricing below is for Gemini 2.5 Flash (update if you switch models):
  //   Input:  $0.075 / 1M tokens
  //   Output: $0.30  / 1M tokens
  if (result.usageMetadata) {
    var inputTokens  = result.usageMetadata.promptTokenCount     || 0;
    var outputTokens = result.usageMetadata.candidatesTokenCount || 0;
    var inputCost    = (inputTokens  / 1_000_000) * 0.075;
    var outputCost   = (outputTokens / 1_000_000) * 0.30;
    var totalCost    = inputCost + outputCost;

    Logger.log("[TOKENS] in=" + inputTokens + " out=" + outputTokens);
    Logger.log("[COST] $" + totalCost.toFixed(6));

    logCost(inputTokens, outputTokens, totalCost, userQuestion, warehouseData.length);
  }

  if (result.candidates && result.candidates[0]) {
    return result.candidates[0].content.parts[0].text;
  }

  Logger.log("LLM raw response: " + response.getContentText());
  throw new Error("No valid response from LLM. Check logs for details.");
}


// ─────────────────────────────────────────────
// 5. POST TO SLACK
// Splits long responses into chunks to avoid Slack's message size limit.
// Posts all chunks to the same thread.
// ─────────────────────────────────────────────
function postToSlack(channel, text, threadTs, slackToken) {
  var MAX_CHARS = 3800; // Slack's practical limit per message

  if (text.length <= MAX_CHARS) {
    sendSlackMessage(channel, text, threadTs, slackToken);
    return;
  }

  // Split by line and batch into chunks under the limit
  var lines = text.split("\n");
  var chunk = "";

  lines.forEach(function(line) {
    if ((chunk + "\n" + line).length > MAX_CHARS) {
      if (chunk.trim()) {
        sendSlackMessage(channel, chunk.trim(), threadTs, slackToken);
        Utilities.sleep(800); // Brief pause between chunks
      }
      chunk = line;
    } else {
      chunk += "\n" + line;
    }
  });

  if (chunk.trim()) {
    sendSlackMessage(channel, chunk.trim(), threadTs, slackToken);
  }
}

function sendSlackMessage(channel, text, threadTs, slackToken) {
  UrlFetchApp.fetch("https://slack.com/api/chat.postMessage", {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + slackToken },
    payload: JSON.stringify({
      channel: channel,
      text: text,
      thread_ts: threadTs
    }),
    muteHttpExceptions: true
  });
}


// ─────────────────────────────────────────────
// 6. GOOGLE DRIVE — CSV EXPORT
// Saves a CSV string to the root of Google Drive.
// Sets sharing to "anyone with link can view".
// Returns the shareable URL.
// ─────────────────────────────────────────────
function saveCSVToDrive(csvContent, filename) {
  var folder = DriveApp.getRootFolder();
  var file = folder.createFile(filename, csvContent, MimeType.CSV);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getUrl();
}


// ─────────────────────────────────────────────
// 7. COST LOGGING
// Appends one row per LLM call to a Google Sheet.
// Creates the sheet and header row automatically on first run.
//
// Fields logged:
//   timestamp       — when the request was made
//   question        — user's query (truncated to 100 chars)
//   context_chars   — size of the warehouse context injected
//   input_tokens    — tokens sent to the LLM
//   output_tokens   — tokens returned by the LLM
//   estimated_cost  — calculated cost in USD
//
// Note: LOG_SHEET_ID is optional. If not set, logging is skipped silently.
// ─────────────────────────────────────────────
function logCost(inputTokens, outputTokens, costUsd, question, contextChars) {
  try {
    var logSheetId = PropertiesService.getScriptProperties().getProperty("LOG_SHEET_ID");
    if (!logSheetId) return; // Skip if not configured

    var ss  = SpreadsheetApp.openById(logSheetId);
    var log = ss.getSheetByName("Cost Log");

    // Create the sheet with headers on first run
    if (!log) {
      log = ss.insertSheet("Cost Log");
      log.appendRow([
        "Timestamp",
        "Question (truncated)",
        "Context size (chars)",
        "Input tokens",
        "Output tokens",
        "Est. cost (USD)"
      ]);
      log.setFrozenRows(1);
    }

    log.appendRow([
      new Date(),
      question.substring(0, 100),
      contextChars,
      inputTokens,
      outputTokens,
      costUsd
    ]);

  } catch(e) {
    Logger.log("Cost logging failed: " + e.message);
  }
}


// ─────────────────────────────────────────────
// UTILITY — run once to authorize all required Google services
// Execute this function manually from the Apps Script editor
// before deploying as a Web App.
// ─────────────────────────────────────────────
function authorize() {
  SpreadsheetApp.openById(
    PropertiesService.getScriptProperties().getProperty("LOG_SHEET_ID") || "dummy"
  );
  UrlFetchApp.fetch("https://www.google.com");
  CacheService.getScriptCache();
  DriveApp.getRootFolder();
  Logger.log("Authorization complete.");
}