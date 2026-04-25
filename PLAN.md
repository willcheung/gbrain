# Customer Intelligence Brain — Project Plan

## What this is

A fork of [garrytan/gbrain](https://github.com/garrytan/gbrain) repurposed as a customer intelligence platform for product managers. The brain ingests data from multiple customer-facing systems, automatically builds a knowledge graph connecting customers to their tickets, calls, feature requests, and account status, and lets PMs query it in natural language.

**Repo:** github.com/willcheung/gbrain (private)
**Local path:** /Users/wcheung/dev/gbrain
**Branch:** main
**Upstream:** garrytan/gbrain (synced weekly via launchd, Mondays 9am)

## Who this is for

Built for product managers who need to find signal from noise across customer data. The primary use cases:

- "What are the top pain points for Enterprise customers?"
- "Show me everything about Acme Corp"
- "Which features have the most customer requests?"
- "Prep me for my QBR with Acme next Tuesday"
- "What changed since last sprint across all teams?"
- "Are customers actually asking for what we're building?"

Anyone who touches customer data can use it, but PMs are the primary audience.

## What's done

### 1. Fork and infrastructure
- Forked garrytan/gbrain to willcheung/gbrain (private)
- Default branch set to `main`
- Weekly upstream sync via launchd (script: `scripts/sync-upstream.sh`)
- Bun installed, dependencies installed, 2416 tests passing

### 2. Local Postgres + pgvector
- Postgres 17 installed via Homebrew (runs at login via `brew services`)
- pgvector 0.8.2 installed
- Database: `postgresql://wcheung@localhost/gbrain`
- All 20 schema migrations applied, health score 90/100
- Subagents and Minions job queue ready
- `~/.bun/bin` needs to be on PATH (`gbrain` CLI linked there)
- `DATABASE_URL` needs to be set in `~/.zshrc`

### 3. Customer-domain relationship types
Added 7 new relationship types with deterministic regex inference (zero LLM calls):

| Relationship | What it captures | Regex pattern |
|---|---|---|
| `filed_ticket` | Support tickets, bug reports, cases | FILED_TICKET_RE |
| `requested_feature` | Feature requests, enhancement proposals | REQUESTED_FEATURE_RE |
| `had_call` | Gong calls, QBRs, customer meetings | HAD_CALL_RE |
| `is_customer_of` | Account/customer ownership | IS_CUSTOMER_RE |
| `escalated` | P0/P1 incidents, executive escalations | ESCALATED_RE |
| `churned` | Cancellations, non-renewals, switches | CHURNED_RE |
| `renewed` | Contract renewals, upsells, expansions | RENEWED_RE |

### 3. Customer-domain page types
Added 4 new page types: `ticket`, `feature`, `call`, `status`

### 5. Files modified
- `src/core/link-extraction.ts` — regex patterns, inferLinkType, FRONTMATTER_LINK_MAP, DIR_PATTERN
- `src/core/types.ts` — PageType union extended
- `src/core/markdown.ts` — inferType for new directories
- `src/commands/extract.ts` — inferTypeByDir for directory-based inference

### 6. README rewritten
Reframed for PM use case with customer intelligence focus, gbrain attribution, applicable upstream skills documented, and concrete PM use cases.

## What's next — in priority order

### Phase 1: Confluence ingestion
**Why first:** Internal specs, past PRDs, architectural decisions, and product documentation live here. This is the "building context" that PMs need alongside customer signal. The Atlassian MCP server is already configured in Claude Code settings.

**What to build:**
- Integration recipe that pulls Confluence pages into brain pages
- Entity extraction on ingest (people, projects, features mentioned in docs)
- Map Confluence spaces to brain directories
- Incremental sync (only pull changed pages)

### Phase 2: Snowflake sync
**Why second:** This is the bulk historical customer data — Gong transcripts, Zendesk tickets, User Voice requests, Salesforce accounts. The knowledge graph is only as good as the data in it. Without this, the customer-domain relationship types we built have nothing to link.

**What to build:**
- `snowflake-sync` integration recipe (cron job via Minions)
- Curated Snowflake views that pre-join relevant tables
- One brain page per: ticket, call transcript, feature request, customer account
- Signal-detector auto-extracts entities and builds the graph on each page write
- Schedule: daily or more frequent for tickets/calls, weekly for account data

**Data flow:**
```
Snowflake views → Minions cron job → brain pages → signal-detector → knowledge graph
```

**Key design decision:** Snowflake stays as source of truth. The brain is the semantic/relationship layer. Don't try to replace Snowflake — query it for analytics (counts, trends, cohorts) and the brain for synthesis ("what are Acme's pain points across all touchpoints?").

### Phase 3: Slack 🧠 emoji reaction ingestion
**Why third:** Real-time signal from the team. But only works well once the brain already has historical data to connect to.

**The approach:** "Forward to brain" mode, not full channel ingest. Slack is too noisy for bulk ingest. Instead:
- Anyone reacts to a Slack message with 🧠
- A Slack workflow/bot forwards the full thread to a webhook
- gbrain's webhook-transforms skill creates a brain page
- Signal-detector extracts entities and links to existing graph

**Three implementation options (prefer option 1):**
1. **Emoji reaction trigger** (recommended) — zero friction, use Slack Workflow Builder
2. **Message shortcut** — "Send to Brain" in the `...` menu on any message
3. **Dedicated channel** — `#brain-feed` where anyone pastes/forwards threads

**Key challenge:** Entity resolution on vague Slack messages. "Big customer is unhappy about auth" has no company name. Two mitigations:
- Enrich at ingest time using the poster's account ownership (Sarah from CS owns Acme → probably about Acme)
- Let the graph fill in over time (tomorrow's Gong call will have the company name)

### Phase 4: JIRA sync
**What to build:**
- `jira-sync` integration recipe
- Pull status updates, sprint data, epic progress
- Create `status/` brain pages for report consolidation

### Phase 5: Customer intelligence skills
These are the PM-facing query skills that make the brain useful:

**customer-360** — "Tell me everything about Acme Corp"
- Traverses the graph from `companies/acme-corp`
- Synthesizes across all linked tickets, calls, feature requests, Slack threads
- Shows renewal status, escalation history, key contacts, pain points
- Outputs a structured dossier

**pain-point-radar** — "What are the top pain points for Enterprise customers?"
- Periodic skill (cron or on-demand)
- Clusters recent feedback across all customers by theme
- Ranks by frequency (how many customers) and severity (escalations, churn risk)
- This is the "signal from noise" skill

**status-roll-up** — "What changed since last sprint?"
- Pulls from JIRA brain pages
- Consolidates by team/epic/sprint
- Replaces chasing PMs across channels for status updates

### Phase 6: Email ingestion (backlog — needs IT approval)
Email ingestion would enable forwarding Granola meeting notes, customer emails, and internal context to the brain. gbrain's email-to-brain recipe uses Gmail API via OAuth (credential-gateway recipe). Requires IT to whitelist the OAuth app.

**Use cases:**
- Forward Granola meeting notes after customer calls
- Forward customer emails (feature requests, complaints, executive escalations)
- Forward internal emails with decisions/approvals worth preserving

**Workaround until approved:** Slack 🧠 reaction covers the same use case — people paste emails into Slack and react with 🧠. Confluence "Brain Feed" space is another fallback.

**When IT approves:** Set up `brain@yourcompany.com` as a shared inbox. Anyone on the team can forward to it. gbrain's existing email-to-brain recipe polls and ingests.

### Phase 7: Nightly curation agent (inspired by Stash's sleep agent)
Inspired by [Fergana-Labs/stash](https://github.com/Fergana-Labs/stash)'s "sleep agent" pattern — a background agent that periodically reviews and improves the knowledge base.

**What it does (runs nightly as a Minions cron job):**
- Clusters related tickets/calls/feature requests by theme → creates/updates pain point summary pages
- Deduplicates entity pages (merges "Acme Corp" / "Acme Corporation" / "ACME" into one)
- Flags stale information (customer churned but still marked active, resolved tickets still linked as open)
- Generates weekly "what changed" digest for PMs
- This is essentially `pain-point-radar` running on a cron, not just on-demand

**Implementation:** Subagent job with `traverse_graph`, `search`, `get_page`, `put_page` tools. Runs during off-hours via cron-scheduler skill with quiet hours.

### Phase 8: Temporal relationships (inspired by Graphiti)
Inspired by [getzep/graphiti](https://github.com/getzep/graphiti)'s temporal knowledge graph — edges have validity windows.

**Problem:** "Acme is_customer_of us" is true from 2024-01-15 but they churned on 2026-03-01. Without temporal edges, the graph says they're still a customer. Same for: people who changed companies, features that shipped (no longer a "request"), resolved escalations.

**Implementation:** Add `valid_from` / `valid_until` to link frontmatter/context. Not a schema change — just metadata in the existing `context` field or page frontmatter. The nightly curation agent (Phase 7) would be responsible for updating these when it detects contradictions (e.g., a `churned` event should close the `is_customer_of` edge).

**Example:**
```
companies/acme-corp:
  is_customer_of: {valid_from: 2024-01-15, valid_until: 2026-03-01, reason: churned}
  renewed: {valid_from: 2024-01-15, valid_until: 2025-01-15}
  churned: {valid_from: 2026-03-01}
```

### Phase 9: PRD toolkit integration
Wire gbrain to PagerDuty/prd-toolkit so PRDs are grounded in real customer data.

**prd-prep skill** — generates a research package for any topic by querying the brain
- Input: topic or feature name
- Output: directory of markdown files (pain points, requesting customers, tickets, call excerpts, escalations, past PRDs, competitive mentions)
- Feed output to `/prd-create --research <dir>`

**post-PRD ingestion** — after a PRD is created, ingest it back into the brain
- PRD becomes a brain page linked to features, customers, tickets it references
- Enables "have we PRD'd this before?" and "what happened last time?" queries
- Closes the learning loop between PRDs and outcomes

## Data sources — full picture

### Connected or ready to connect
| Source | What it gives us | Status |
|---|---|---|
| Confluence | Internal specs, PRDs, decisions, architecture docs | MCP server configured, ready to ingest |
| User Voice | Feature requests, votes, customer feedback | In Snowflake, needs sync recipe |
| Zendesk | Support tickets, customer issues, escalations | In Snowflake, needs sync recipe |
| Gong | Call transcripts, customer conversations | In Snowflake, needs sync recipe |
| Salesforce | Accounts, contacts, ARR, renewal dates, deal stages | In Snowflake, needs sync recipe |
| JIRA | Status reports, sprint data, epic progress | Needs sync recipe |
| Slack | Real-time team signal, customer discussions | MCP server configured, needs 🧠 reaction setup |
| Snowflake | Warehouse for all structured/unstructured data above | Needs sync recipe (the main pipeline) |

### Identified as missing (future)
| Source | What it would give us | Why it matters for PRDs |
|---|---|---|
| Granola meeting notes | AI summaries + transcripts of customer calls | Richer than Gong alone; needs email ingestion (Phase 6) or Granola API (Business/Enterprise plan) |
| Email (Gmail) | Forwarded customer emails, Granola notes, internal decisions | Needs IT to whitelist Gmail OAuth app (Phase 6) |
| Product analytics (Amplitude/Mixpanel/Pendo) | Feature usage, adoption, drop-off funnels | "Are customers actually using what we built?" |
| Revenue/finance data | ARR by segment, expansion/churn correlation | "What's this feature worth?" for prioritization |
| Competitive intelligence (G2, Gartner, competitor changelogs) | What customers compare us to, market gaps | "What are alternatives doing?" |
| Figma | Design artifacts, past explorations, UX research | "What's been tried before?" for scoping |
| Engineering ADRs / code repos | Technical constraints, dependencies, tech debt | "What's feasible?" for scoping |
| Past PRD outcomes | PRD → delivery status → adoption → customer feedback | "We tried this before. What happened?" — the learning loop |

## PRD Toolkit integration

### What it is
[PagerDuty/prd-toolkit](https://github.com/PagerDuty/prd-toolkit) (private) is an interactive PRD creation tool that generates 18-27 output files (complete PRD, executive briefings, customer decks, risk registers, technical feasibility assessments) through an 11-step guided workflow with specialized AI agents (PM, designer, architect, engineer, tech writer). Costs $1.50-$3.00 per PRD. Supports feature, refactor, and architecture PRD types. Has PLM (Product Lifecycle Management) integration for strategic initiatives.

### Why combine them
prd-toolkit generates PRDs. gbrain provides the customer evidence to ground them. Without gbrain, the discovery phase relies on the PM's memory and web research. With gbrain, every step draws from real customer data:

| PRD step | Without gbrain | With gbrain |
|---|---|---|
| Problem exploration | PM describes from memory | Brain surfaces Zendesk ticket clusters, Gong call themes, escalation patterns |
| Personas | AI generates generic personas | Brain pulls actual customer profiles, segments by real behavior |
| Research | Web search for competitors | Brain has Gong calls where customers name competitors directly |
| Requirements | PM lists from memory | Brain shows what customers actually asked for, with frequency counts |
| Metrics | Generic KPIs | Brain shows current baselines (ticket volume, churn rate for this area) |
| Risks | Guesswork | Brain shows past PRDs that addressed similar problems and what happened |

### Integration approach — keep them separate
Don't merge the repos. Both evolve independently and get upstream updates. Wire them together via:

1. **gbrain as MCP server** — prd-toolkit's agents can query the brain during each step via MCP tools (`search`, `query`, `traverse_graph`, `get_page`)
2. **`prd-prep` skill in gbrain (build this)** — given a topic, queries the brain for all related customer signal (tickets, calls, feature requests, customer quotes, past PRDs) and dumps a research package into a directory
3. **Feed research to prd-toolkit** — `/prd-create "topic" --research <dir>` picks up the brain's research package as input context
4. **Post-PRD ingestion** — after the PRD is generated, ingest it back into the brain as a page linked to the features, customers, and tickets it references. Closes the loop for "past PRD outcomes" tracking.

### Workflow end to end
```
PM has a feature idea
    ↓
gbrain prd-prep "SSO support"
    → queries brain for all related signal
    → dumps research package to ./research/sso-support/
    ↓
/prd-create "enterprise SSO" --type feature --research ./research/sso-support/ --plm
    → 11-step guided workflow, grounded in real customer data
    → generates PRD + supporting docs + PLM planning
    ↓
gbrain ingest ./output/enterprise-sso-20260424/prd.md
    → PRD becomes a brain page
    → linked to features/sso-support, related tickets, requesting customers
    → next time someone asks "have we PRD'd SSO?" the brain knows
```

### New skill to build: prd-prep
A gbrain skill that generates a research package for prd-toolkit:

**Input:** a topic or feature name
**Output:** a directory of markdown files:
```
research/{topic}/
├── customer-pain-points.md    ← clustered feedback from Zendesk, Gong, User Voice
├── requesting-customers.md    ← accounts that asked for this, with ARR and context
├── related-tickets.md         ← support tickets mentioning this area
├── call-excerpts.md           ← relevant Gong call snippets
├── escalation-history.md      ← P0/P1 incidents related to this
├── past-prds.md               ← previous PRDs that touched this area
└── competitive-mentions.md    ← what customers said about alternatives
```

This skill should be built after Phase 5 (customer intelligence skills) since it depends on data being in the brain.

## Architecture decisions

### Snowflake is source of truth, brain is semantic layer
Don't replicate Snowflake. Query Snowflake for analytics (counts, trends, cohorts). Query the brain for synthesis (pain points, customer context, signal across sources). Sync selected data from Snowflake views into brain pages.

### Humans curate Slack signal
Full Slack ingest is noise. 🧠 emoji reaction lets anyone on the team contribute signal with zero friction. The human is the filter.

### Entity resolution is the hard problem
"Acme Corp" in Slack, "Acme Corporation" in Zendesk, "ACME" in Salesforce must resolve to `companies/acme-corp`. gbrain's enrich skill handles this via slug matching and tiered enrichment. May need custom normalization rules for your specific naming conventions.

### Additive changes only
We kept all original gbrain relationship types (`invested_in`, `works_at`, `founded`, `advises`) alongside our new customer types. Our changes are in a small number of files that rarely conflict with upstream. This makes weekly upstream syncs clean.

### link_type is a plain string, not an enum
Adding new relationship types is non-breaking. No schema migration needed.

## Existing gbrain skills we use

The README documents 18 of gbrain's 29 skills that apply to customer intelligence. Key ones:
- **signal-detector** — auto-captures entities on every message
- **brain-ops** — read-enrich-write loop
- **enrich** — tiered entity enrichment (stub → partial → full)
- **meeting-ingestion** — customer call transcripts with attendee enrichment
- **data-research** — structured extraction with YAML recipes
- **webhook-transforms** — external events to brain pages (Slack 🧠 reaction uses this)
- **cron-scheduler** — schedule Snowflake syncs
- **minion-orchestrator** — durable background jobs for sync pipelines
- **reports** — timestamped reports with keyword routing
- **query** — 3-layer search with synthesis and citations

## Open source projects we looked at

| Project | What it does | What we took from it |
|---|---|---|
| [garrytan/gbrain](https://github.com/garrytan/gbrain) | AI agent memory system with self-wiring knowledge graph | The entire foundation — forked it |
| [Fergana-Labs/stash](https://github.com/Fergana-Labs/stash) | Shared memory for coding agents, Karpathy-style wiki | Sleep agent / nightly curation pattern (Phase 7). Team shared knowledge concept. |
| [getzep/graphiti](https://github.com/getzep/graphiti) | Temporal knowledge graph for agents | Temporal edges with validity windows (Phase 8). Contradiction resolution. |
| [mem0ai/mem0](https://github.com/mem0ai/mem0) | Memory layer for AI agents | Ideas around memory scoring, relevance decay, conflict resolution. Not yet incorporated. |
| [run-llama/llama_index](https://github.com/run-llama/llama_index) | Property graph index, structured extraction | Structured extraction patterns for turning Gong transcripts into entities. Not yet incorporated. |
| [PagerDuty/prd-toolkit](https://github.com/PagerDuty/prd-toolkit) | Interactive PRD creation (private) | Integration target — brain provides research, prd-toolkit generates PRDs (Phase 9) |

## Known issues
- `build-llms` test fails because our README diverges from upstream's generator output. Expected, not worth fixing.
- 2 other pre-existing test failures unrelated to our changes (PGLite shell test, OpenClaw compat test).
- Bun is installed via Homebrew at `/opt/homebrew/bin/bun`. Must `source ~/.zshrc` before running bun commands in scripts.
- `gbrain` CLI is at `~/.bun/bin/gbrain` — needs `~/.bun/bin` on PATH.
- `DATABASE_URL=postgresql://wcheung@localhost/gbrain` must be set for Postgres mode.
- Postgres 17 runs as a Homebrew service (auto-starts at login). Stop with `brew services stop postgresql@17`.
- Org-wide Claude Code hook blocks `git push` to main/master. Must push manually via `! git push origin main`.
- Supabase not an option — sensitive customer data can't go to third-party cloud. Local Postgres only.
