# BigQuery Setup

This document describes how to structure your BigQuery tables
for the bot, with example schemas based on a client intelligence
use case (the T-Rex demo).

Adapt table names, fields, and SQL to match your own schema.

---

## Table structure

The bot queries three logical data sources on every request
and injects the results as context into the LLM prompt.

---

### Table 1 — Client roster

Your primary client table. One row per client. Should contain
identifiers, revenue data, account health, and any fields
useful for ranking or filtering.

**Example schema:**

CREATE TABLE `your_dataset.your_clients_table` (
  client_id            STRING,
  client_name          STRING,
  account_owner_email  STRING,
  country              STRING,
  segment              STRING,   -- "enterprise", "mid-market", "smb"
  status               STRING,   -- "active", "churned", "at-risk"
  revenue_current_month  FLOAT64,
  revenue_last_month     FLOAT64,
  total_revenue_ytd      FLOAT64,
  last_purchase_dt       DATE,
  last_login_dt          DATE,
  churn_risk_score       FLOAT64, -- 0 to 1
  profile_url            STRING
);

**Recommended query:**
Only fetch active clients. Avoid pulling churned or archived
records unless specifically needed — it reduces context size
and improves match quality.

---

### Table 2 — Client activity & interaction log

Behavioral and qualitative data per client. Typically sourced
from CRM notes, support tickets, NPS responses, or call logs.
Multiple rows per client — one per interaction.

**Example schema:**

CREATE TABLE `your_dataset.your_interactions_table` (
  client_id         STRING,
  client_name       STRING,
  interaction_type  STRING,  -- "support_ticket", "nps", "call", "email"
  interaction_date  DATE,
  notes             STRING
);

**Recommended query:**
Filter to the last 90 days to keep context relevant and lean.
Truncate the notes field to avoid inflating the prompt size.

---

### Table 3 — Pipeline / prospects

Leads and prospects not yet active. These won't appear in
Table 1 — include them separately so the bot can answer
questions about incoming business too.

**Example schema:**

CREATE TABLE `your_dataset.your_pipeline_table` (
  lead_id               STRING,
  full_name             STRING,
  company               STRING,
  account_owner_email   STRING,
  pipeline_stage        STRING,  -- "prospecting", "proposal", "negotiation"
  estimated_value       FLOAT64,
  first_contact_dt      DATE,
  expected_close_dt     DATE
);

**Recommended query:**
Exclude closed_lost records to keep the context clean.

---

## Context window estimates

The bot injects all three query results into every prompt.
Keep total context lean — filter aggressively in SQL.

| Clients | Fields | Approx. tokens | Fits? |
|---------|--------|----------------|-------|
| 500     | 10     | ~40k tokens    | ✅    |
| 1,000   | 12     | ~90k tokens    | ✅    |
| 2,000   | 12     | ~180k tokens   | ✅    |
| 5,000   | 12     | ~450k tokens   | ⚠️    |
| 10,000+ | any    | >1M tokens     | ❌    |

If approaching limits:
- Filter by segment, region, or account owner
- Reduce the 90-day window in Table 2
- Drop low-value fields from the SELECT
- Move to a retrieval layer (embeddings + vector search)

---

## Access configuration

The Apps Script project must be linked to a Google Cloud
project with access to your BigQuery dataset.

1. Apps Script editor → Project Settings → Google Cloud
   Platform project → enter your GCP project number
2. Enable the BigQuery Advanced Service:
   Services → BigQuery API
3. Ensure the Apps Script service account has:
   - BigQuery Data Viewer
   - BigQuery Job User