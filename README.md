# Customer Intelligence Brain

> Built on [GBrain](https://github.com/garrytan/gbrain), an open-source AI agent memory system by Garry Tan.

A self-wiring knowledge graph that synthesizes customer pain points, feature requests, and feedback across Gong calls, Salesforce, Zendesk, User Voice, and JIRA. Data lives in Snowflake. The brain makes it queryable in natural language — without writing SQL joins.

Built for product managers who need to find signal from noise. Works for anyone who touches customer data.

## Use cases for product managers

**"What are the top pain points for Enterprise customers?"** — The brain clusters feedback across Zendesk tickets, Gong calls, and User Voice requests. You get themes ranked by frequency and severity, not a spreadsheet you have to pivot yourself.

**"Show me everything about Acme Corp"** — One query pulls their support history, feature requests, Gong call summaries, renewal status, and escalations. No switching between five tabs.

**"Which features have the most customer requests?"** — Feature pages automatically link to every customer and ticket that mentioned them. The graph shows demand, not just a vote count.

**"Prep me for my QBR with Acme next Tuesday"** — Pulls the account dossier, recent tickets, open feature requests, last call summary, renewal date, and any escalation history. You walk in knowing what they care about.

**"What changed since last sprint across all teams?"** — JIRA status reports consolidated into one view. No chasing PMs in three different channels.

**"Are customers actually asking for what we're building?"** — Cross-reference your roadmap against real customer requests, call transcripts, and ticket trends. Validate priorities with data, not gut feel.

## Why this exists

Customer signal is scattered. A Gong call mentions a pain point. A Zendesk ticket describes the same problem differently. A User Voice request captures the feature ask. A Salesforce record has the account context. A JIRA ticket tracks the status. Today, connecting these requires knowing which Snowflake tables to join and how. This brain does it automatically.

When a Zendesk ticket from Acme Corp gets ingested, the brain automatically links it to Acme's account page, the person who filed it, any features they requested, and every prior Gong call with that account. No SQL required.

## What we get from GBrain

This is a fork of [garrytan/gbrain](https://github.com/garrytan/gbrain), which provides the entire foundation:

- **Hybrid search** — vector embeddings + BM25 keyword search + Reciprocal Rank Fusion. Benchmarked at P@5 49.1%, R@5 97.9%.
- **Self-wiring knowledge graph** — every page write extracts entity references and creates typed links with zero LLM calls. Deterministic regex, not prompt engineering.
- **Pluggable storage** — PGLite (embedded Postgres, zero config) or Supabase for production.
- **Minions job queue** — Postgres-native background jobs for cron syncs. Durable, resumable, $0 token cost for deterministic work.
- **MCP server** — 30+ tools exposed via stdio for Claude Code, Cursor, or any MCP client.
- **Dream cycle** — overnight maintenance that fixes citations, consolidates memory, and enriches entities while you sleep.

We stay synced with upstream weekly to pull engine improvements, bug fixes, and new capabilities. Our changes are additive — new relationship types, page types, and skills layered on top.

## Skills that apply to us

GBrain ships 29 skills. Many are directly useful for customer intelligence work out of the box.

### Always-on

| Skill | What it does for us |
|-------|---|
| **signal-detector** | Fires on every message. Captures entity mentions (customers, accounts, features) and original thinking on autopilot. |
| **brain-ops** | Brain-first lookup before any external call. The read-enrich-write loop that makes every response draw on what the brain already knows. |

### Content ingestion

| Skill | What it does for us |
|-------|---|
| **ingest** | Routes incoming data to the right ingestion skill. Zendesk export, Gong transcript, JIRA dump — it detects and delegates. |
| **media-ingest** | Gong call recordings, PDF reports, slide decks from customers. Transcripts, entity extraction, backlink propagation. |
| **meeting-ingestion** | Customer call transcripts become brain pages. Every attendee gets enriched. Every account gets a timeline entry. |
| **idea-ingest** | Product ideas, competitive intel links, and analyst reports become brain pages with cross-linking. |

### Brain operations

| Skill | What it does for us |
|-------|---|
| **enrich** | Tiered enrichment. A customer mentioned once gets a stub page. After multiple tickets and calls, full enrichment kicks in automatically. The brain learns who matters. |
| **query** | 3-layer search with synthesis and citations. Asks "the brain doesn't have info on X" instead of hallucinating. |
| **maintain** | Periodic health: stale pages, orphans, dead links, citation audit. Keeps the customer data graph clean. |
| **data-research** | Structured data extraction with YAML recipes. Build recipes for pulling metrics from Salesforce exports, parsing NPS responses, extracting ARR/MRR from account data. |
| **citation-fixer** | Ensures every insight traces back to a source — which ticket, which call, which request. |

### Operational

| Skill | What it does for us |
|-------|---|
| **reports** | Timestamped reports with keyword routing. Generate and retrieve customer health reports, sprint summaries, pain point analyses. |
| **cron-scheduler** | Schedule Snowflake syncs, JIRA pulls, and account health checks. Timezone-aware with quiet hours. |
| **daily-task-prep** | Morning prep with context. What customer meetings are today? What's the latest on their accounts? |
| **minion-orchestrator** | Background sync jobs. Pull from Snowflake, re-index Gong transcripts, refresh Salesforce data — all durable, all resumable. |
| **webhook-transforms** | Zendesk webhook fires when a ticket is created? Automatically becomes a brain page with entity extraction. |

### Setup and identity

| Skill | What it does for us |
|-------|---|
| **setup** | Auto-provision the brain. PGLite for local dev, Supabase for production. |
| **soul-audit** | Configure the agent's identity and access policy. Tell it what data sources matter, what's sensitive, how to behave. |
| **cross-modal-review** | Quality gate via a second model. Important when synthesizing customer feedback — catches hallucinated pain points. |

## What we changed

### Customer-domain relationship types

GBrain ships with VC/startup relationships (`invested_in`, `works_at`, `founded`, `advises`). We added customer intelligence relationships:

| Relationship | What it captures |
|---|---|
| `filed_ticket` | Customer filed a support ticket, bug report, or case |
| `requested_feature` | Customer requested a feature or enhancement |
| `had_call` | Gong call, QBR, discovery call, or customer meeting |
| `is_customer_of` | Account/customer ownership from Salesforce |
| `escalated` | Support escalation, P0/P1 incidents, executive escalations |
| `churned` | Customer cancelled, didn't renew, or switched away |
| `renewed` | Contract renewal, upsell, expansion |

These are inferred deterministically from content — same zero-LLM-call approach as the original. When a page says "Acme Corp filed a P1 ticket about SSO failures," the brain automatically creates `filed_ticket` and `escalated` links.

### Customer-domain page types

| Page type | Source | Example slug |
|---|---|---|
| `ticket` | Zendesk, JIRA | `tickets/zd-12345` |
| `feature` | User Voice, internal | `features/sso-support` |
| `call` | Gong | `calls/2026-04-15-acme-qbr` |
| `status` | JIRA | `status/2026-w16-platform-team` |

### Data flow

```
Snowflake (source of truth)
    ↓ cron sync via Minions (weekly/daily)
    ↓ SELECT from curated views
    ↓
Brain pages (one per ticket, call, feature request, account)
    ↓ signal-detector auto-extracts entities + relationships
    ↓
Knowledge graph
    Customer ─── filed_ticket ──→ Ticket ZD-12345
    Customer ─── had_call ──────→ Gong Call (2026-04-15 QBR)
    Customer ─── requested_feature → Feature: SSO Support
    Ticket   ─── escalated ─────→ VP Engineering
    ↓
"What are the top pain points for Enterprise customers?"
```

## Planned skills (not yet built)

| Skill | Purpose |
|---|---|
| **snowflake-sync** | Cron recipe pulling from Snowflake views into brain pages |
| **jira-sync** | Pull JIRA status updates for report consolidation |
| **customer-360** | "Tell me everything about Acme Corp" across all sources |
| **pain-point-radar** | Cluster feedback across customers, rank by frequency and severity |
| **status-roll-up** | Consolidate JIRA status reports by team/epic/sprint |

## Quick start

```bash
git clone git@github.com:willcheung/gbrain.git && cd gbrain
bun install && bun link
gbrain init                     # local brain, ready in 2 seconds
```

## Upstream

This fork syncs weekly with [garrytan/gbrain](https://github.com/garrytan/gbrain) master. Our changes are additive and in files that rarely conflict:
- `src/core/link-extraction.ts` — added regex patterns and frontmatter mappings
- `src/core/types.ts` — extended PageType union
- `src/core/markdown.ts` — added directory-to-type inference
- `src/commands/extract.ts` — added directory-based relationship inference

For the complete GBrain documentation — engine architecture, MCP setup, search internals, Minions job queue, voice, skillify, and more — see the [upstream README](https://github.com/garrytan/gbrain).

## License

MIT — same as upstream GBrain.
