# Prompt Guide

The system prompt is the core of the bot's intelligence. A well-written prompt makes the difference between a bot that's occasionally useful and one that gets adopted organically.

This guide walks through how to structure it.

---

## Prompt structure

The prompt lives in the `SYSTEM_PROMPT` constant inside `callLLM()` in `Code.gs`. It is sent to the LLM on every request, along with the warehouse context data.

Structure it in three sections:

---

### Section 1 — About the data

Describe what each table contains and what the key fields mean. The LLM has no prior knowledge of your schema — every field that matters must be explained.

**Template:**
```
ABOUT THE DATA:
- "[TABLE NAME]" contains [what it stores]. Key fields:
  • [field_name] — [what it means]
  • [field_name] — [what it means]
  Cross-reference this table with [other table] when [condition].

- "[TABLE NAME]" contains [what it stores]. Note: records here
  will not appear in [other table] — treat them separately.
```

**Tips:**
- Mention how tables relate to each other (join keys, overlaps)
- Flag fields with special meaning (e.g. `status`)
- Note any fields that are arrays, JSON, or require special handling
- If a field's values are a controlled vocabulary (e.g. role types: `Good`, `Bad`, `Medium`), define them

---

### Section 2 — Your goal

Tell the LLM what it is optimizing for. Be specific about what a "good match" means in your context.

**Template:**
```
YOUR GOAL:
Search across all available data sources and return the best matches
for the user's query, ranked by [primary criteria].

Always cross-reference [TABLE A] with [TABLE B] for every result.
If a record appears in multiple tables, flag it explicitly.
```

**Tips:**
- Define the ranking criteria (ratings, availability, recency)
- Specify how to handle ambiguous queries (ask one clarifying question)
- Describe what to do when no match exists (explain the gap, suggest alternatives)

---

### Section 3 — Behavior rules

Define output format, edge cases, and export behavior.

**Template:**
```
BEHAVIOR RULES:
- Use Slack markdown: *bold*, bullet points with -
- Exclude records where [field] = [value]
- If the query is vague, ask ONE clarifying question before answering
- Never fabricate data — only use what exists in the repository
- For CSV export requests, respond ONLY with the EXPORT_CSV block (no conversational text)
```

**Tips:**
- Be explicit about what fields to show per result (name, email, profile URL, rating...)
- Define the default export columns
- Specify any fields to always exclude from responses (e.g. internal IDs, salary data)

---

## Export behavior

The bot supports CSV exports via a structured tag protocol. The LLM wraps CSV data in:

```
EXPORT_CSV_START
name,email,profile_url
Alice Smith,alice@example.com,https://...
Bob Jones,bob@example.com,https://...
EXPORT_CSV_END
EXPORT_FILENAME: results_2024.csv
```

Apps Script parses this block, saves the file to Google Drive, and posts a shareable link to Slack.

**Prompt rules to add for exports:**

```
EXPORT RULES:
- Only generate a CSV when the user explicitly asks for a file, export, or download.
- Default columns: name, email, profile_url (unless the user requests others).
- Include a "source" column when combining records from multiple tables.
- Do not add conversational text inside or around the CSV block.
- If approaching output limits, strip to name + email only and continue — a complete
  list with fewer columns is better than a truncated list with all columns.
```

---


## Tuning tips

| Issue | Fix |
|---|---|
| Bot returns too many results | Add "return the top N matches only" |
| Bot invents data | Add "never fabricate — if a field is missing, omit it silently" |
| Bot ignores one table | Add "always search ALL tables before responding" |
| Exports are truncated | Increase `maxOutputTokens` in `callLLM()` |
| Responses are too verbose | Add "be concise — 2–3 lines per result maximum" |
| Bot asks too many questions | Add "make your best guess if only one field is ambiguous" |