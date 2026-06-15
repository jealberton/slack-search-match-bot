# Slack Search & Match Bot — LLM-powered assistant for data warehouse queries

A serverless Slack bot that lets business users search and match records from a data warehouse using natural language.
Built with Google Apps Script, BigQuery, and any LLM API (Gemini, OpenAI, Claude, etc.).

---

## The problem

Sometimes the business user just wants to answer a simple question (the real simple ones, not those little monsters that seem simple but aren't). The question is simple. The answer is simple. Getting to it is not. 
When hundreds of records are spread across a data warehouse and users' personal files, there's no single place to look. Teams resort to random data pulls and scattered knowledge that lives nowhere and everywhere at once. So instead of a quick search and match, someone ends up opening a dashboard they can barely interpret, exporting a CSV, or filing a ticket to the data team, slowing everything down. So here is a different approach to solve this friction. 


---

## What it does

- Accepts natural language queries directly in Slack
- Queries your BigQuery data warehouse in real time
- Injects the relevant context into an LLM prompt
- Returns ranked, readable matches in the Slack thread
- Exports results as a CSV to Google Drive on request, with a shareable link posted back to the channel
- Tracks token usage and cost per request for observability

---

## Architecture

```
Slack user
    │  natural language query (webhook)
    ▼
Google Apps Script
    │  reads context data
    ▼
BigQuery (your data warehouse)
    │  returns records
    ▼
Apps Script
    │  builds prompt + injects context
    ▼
LLM API (Gemini / OpenAI / Claude)
    │  returns ranked answer
    ▼
Apps Script
    │  posts answer to Slack thread
    ▼
Slack user

Optional: if user requests export →
LLM returns CSV block → Apps Script saves to Drive → shareable link posted to thread
```

---

## Stack

| Layer | Technology |
|---|---|
| Interface | Slack API (Events API + chat.postMessage) |
| Orchestration | Google Apps Script (serverless, no infra) |
| Data source | Google BigQuery |
| LLM | Gemini 2.5 Flash (swappable) |
| Export | Google Drive |
| Cost tracking | BigQuery log table (via Apps Script) |

---

## Prerequisites

- A Google Cloud project with BigQuery enabled
- A Slack workspace with permission to create apps
- An LLM API key (Gemini, OpenAI, or other)
- A Google Apps Script project (free)

---

## Setup

### 1. Create the Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app
2. Under **OAuth & Permissions**, add the following Bot Token scopes:
   - `chat:write`
   - `app_mentions:read`
   - `channels:history`
   - `im:history`
3. Install the app to your workspace and copy the **Bot User OAuth Token**
4. Under **Basic Information**, copy the **Signing Secret**
5. Under **Event Subscriptions**:
   - Enable events
   - Subscribe to `app_mention` and `message.im`
   - Set the Request URL to your Apps Script web app URL (see step 4)

### 2. Configure BigQuery

Ensure your data warehouse tables are accessible from the Google Cloud project linked to your Apps Script. The bot queries three tables by default — adapt the SQL in `readFromBigQuery()` to match your schema.

### 3. Create the Apps Script project

1. Go to [script.google.com](https://script.google.com) and create a new project
2. Enable the BigQuery Advanced Service: **Services → BigQuery API**
3. Paste the contents of `Code.gs` into the editor
4. Under **Project Settings → Script Properties**, add:

| Property | Value |
|---|---|
| `SLACK_BOT_TOKEN` | Your Slack Bot User OAuth Token |
| `SLACK_SIGNING_SECRET` | Your Slack app Signing Secret |
| `LLM_API_KEY` | Your LLM API key |
| `BQ_PROJECT_ID` | Your Google Cloud project ID |
| `LOG_SHEET_ID` | ID of the Google Sheet used for cost logging |

5. Deploy as a **Web App**:
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Copy the deployment URL

### 4. Connect Slack to Apps Script

Paste the Apps Script web app URL into the Slack Event Subscriptions **Request URL** field. Slack will send a verification challenge — the bot handles this automatically.

### 5. Customize the bot personality and prompt

Open `Code.gs` and find the `SYSTEM_PROMPT` constant. Replace it with a prompt that describes:
- What data sources are available and what they contain
- What kind of matching logic to apply
- How to format responses (Slack markdown: `*bold*`, bullet points with `-`)
- Any business rules or exclusions

See the [Prompt Guide](#prompt-guide) section below for tips.

---

## Prompt guide

The system prompt is the core of the bot's intelligence. A well-written prompt makes the difference between a bot that's occasionally useful and one that gets adopted organically.

Structure your prompt in three sections:

**1. About the data**
Describe each table: what it contains, what the key fields mean, and how tables relate to each other. Example:

```
- "clients" table: full client roster with identifiers, segment,
  revenue data, account health scores, and activity timestamps.
- "interactions" table: behavioral and qualitative data — CRM notes,
  support tickets, NPS responses, call logs. Multiple rows per client,
  one per interaction. Always cross-reference with the clients table
  by client_id.
- "pipeline" table: leads and prospects not yet active. Won't appear
  in the clients table — treat them as a separate group. Key fields:
  pipeline stage, estimated value, and expected close date.
```

**2. Your goal**
Tell the LLM what it's optimizing for.

```
Match the right record to the user's need based on all available data.
Cross-reference all tables before responding.
Never fabricate data — only use what exists in the repository.
```

**3. Behavior rules**
Define edge cases, output format, and export behavior. Example:

```
- Use Slack markdown: *bold*, bullet points with -
- If the query is vague, ask ONE clarifying question before answering
- For CSV export requests, respond ONLY with the EXPORT_CSV block
- Exclude records where status = 'inactive'
```

---

## Cost tracking

Every LLM API call logs the following to a BigQuery table (or Google Sheet):

| Field | Description |
|---|---|
| `timestamp` | When the request was made |
| `question` | The user's query (truncated to 100 chars) |
| `context_chars` | Size of the context injected into the prompt |
| `input_tokens` | Tokens sent to the LLM |
| `output_tokens` | Tokens returned by the LLM |
| `estimated_cost_usd` | Calculated cost based on model pricing |

**Why this matters:** token costs compound fast with high adoption. Logging from day one gives you visibility into which query patterns are expensive, and makes the case for scaling to production much easier.

**Gemini 2.5 Flash pricing reference** (at time of writing):
- Input: $0.075 / 1M tokens
- Output: $0.30 / 1M tokens

Update the cost calculation in `logCostToSheet()` if you switch models.

---

## LLM temperature

The bot uses `temperature: 0.3` by default. This keeps responses focused and consistent — appropriate for search and match tasks where factual accuracy matters more than creativity.

Increase to `0.5–0.7` if you want more varied or conversational responses. Keep below `0.3` for strict data retrieval tasks.

---

## CSV export

When a user asks for a file, download, or export, the LLM returns a structured CSV block wrapped in `EXPORT_CSV_START` / `EXPORT_CSV_END` tags. Apps Script parses the block, saves it to Google Drive, and posts the shareable link back to the Slack thread.

Default export columns: `name`, `email`, `profile_url`. Customizable via the prompt.

---

## Deduplication

Slack retries failed webhook deliveries. Without deduplication, the bot processes the same message multiple times. A script-level lock keyed on `event.ts + channel` prevents duplicate responses.

---

## Limitations

- **Context window**: the bot injects the full dataset into every prompt. This works well for datasets that fit within the model's context window (~500–2000 records depending on field verbosity). For larger datasets, consider moving to a retrieval layer (embeddings + semantic search).
- **Cold start**: Apps Script has a ~1–2s cold start. For time-sensitive use cases, consider a dedicated server.
- **Concurrency**: the script-level lock serializes requests. High-volume workloads may queue.

---

## Roadmap ideas

- [ ] Semantic search layer for larger datasets (embeddings + vector DB)
- [ ] Slash command support (`/search`)
- [ ] Multi-turn conversation memory per Slack thread
- [ ] Dashboard for cost and usage analytics
- [ ] Support for additional data sources (Snowflake, Postgres, etc.)

---

## License

Use freely, attribution appreciated.
