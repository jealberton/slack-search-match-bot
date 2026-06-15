# Cost Tracking

Every LLM API call is logged automatically. This document explains what is tracked, how to read the data, and how to use it to optimize costs.

---

## Why track costs

Token costs compound fast with high adoption. A bot used by 20 people making 10 queries per day can generate several of API calls per month. Without observability, you won't know:

- Which query types are expensive (broad searches inject more context)
- Whether costs are growing as adoption grows
- Whether the investment is justified relative to the time saved

Logging from day one gives you the data to answer all of these — and makes the case for scaling to production much easier.

---

## What is logged

| Field | Description |
|---|---|
| `timestamp` | When the request was made |
| `question` | User's query, truncated to 100 characters |
| `context_chars` | Character count of the warehouse data injected into the prompt |
| `input_tokens` | Tokens consumed by the prompt (question + context + system prompt) |
| `output_tokens` | Tokens returned by the LLM |
| `estimated_cost_usd` | Calculated cost in USD based on model pricing |

---

## Where it is stored

Cost data is appended to a Google Sheet (`LOG_SHEET_ID` in Script Properties) under a tab named **Cost Log**. The sheet and header row are created automatically on first run. Obs: It can be stored elsewhere if prefereed. Sheet was chosen  here for MVP purposes.

---

## Cost calculation

For **Gemini 2.5 Flash** (default model):

```
Input cost  = (input_tokens  / 1,000,000) × $0.075
Output cost = (output_tokens / 1,000,000) × $0.30
Total cost  = input_cost + output_cost
```

Update these multipliers in `logCost()` inside `Code.gs` if you switch models.

**Reference estimated pricing for common models:**

| Model | Input ($/1M tokens) | Output ($/1M tokens) |
|---|---|---|
| Gemini 2.5 Flash | $0.075 | $0.30 |
| GPT-4o mini | $0.15 | $0.60 |
| GPT-4o | $2.50 | $10.00 |
| Claude Haiku 3.5 | $0.80 | $4.00 |
| Claude Sonnet 4 | $3.00 | $15.00 |

*Prices change — always verify against the provider's current pricing page.*

---

## What drives cost

The biggest cost driver is **context size** — the amount of warehouse data injected into every prompt. This grows with:

- Number of records in your tables
- Number of fields per record
- Length of text fields (bios, descriptions, skill summaries)

The `context_chars` field lets you track this directly and spot when a table is growing in ways that affect cost.

**Optimization strategies:**

- **Filter at query time** — only fetch active records, exclude archived data
- **Truncate long text fields** — the SQL already does `SUBSTR(text, 1, 300)` on description fields; reduce further if needed
- **Drop low-value fields** — every field you fetch adds tokens; audit your SELECT regularly
- **Add query-specific filtering** — if the user's query specifies a location or role type, filter BigQuery accordingly before injecting context

---

## Interpreting the data

A few patterns to look for in the Cost Log sheet:

**High `context_chars` with low `output_tokens`**
The prompt is large but the answer is short — common with broad queries. Consider filtering the warehouse data more aggressively before injection.

**Growing `context_chars` over time**
Your tables are growing. At some point, context injection will hit the model's context window limit. Plan for a retrieval layer (embeddings + semantic search) before this becomes a problem.

**High `output_tokens`**
The LLM is writing long responses. Add "be concise" instructions to the system prompt, or cap response length.

**Spikes on specific days**
Correlate with Slack activity — team meetings, planning cycles, or training program launches often drive query spikes.