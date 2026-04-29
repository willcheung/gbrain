# Data Engineering Guide

How to ingest data, wire graph edges, and extend the brain. Written so you can rebuild from scratch or add a new data source without reading prior conversation history.

## Current state

**23,197 pages** and **45,363 edges** across 4 data sources:

| Type | Count | Source | Slug pattern |
|------|-------|--------|--------------|
| idea | 6,606 | UserVoice | `ideas/uservoice/{id}` |
| ticket | 6,431 | JIRA | `tickets/jira/{key-lowercase}` |
| account | 5,065 | UserVoice (Salesforce IDs) | `accounts/salesforce/{sf-id}` |
| call | 4,254 | Gong wiki | `calls/gong/{call-id}` |
| feature (epic) | 691 | JIRA | `epics/jira/{key-lowercase}` |
| status | 70 | Confluence | `status/ocp/{team}-{date}` |
| company | 60 | Gong wiki (unmatched) | `companies/{slug}` |
| theme | 15 | Gong wiki | `themes/gong/{slug}` |
| concept | 3 | manual | `concepts/{slug}` |
| synthesis | 2 | Gong wiki | `wiki/gong/{slug}` |

## Graph edge types

| Edge type | Count | From → To | Created by |
|-----------|-------|-----------|------------|
| `voted_for` | 21,164 | account → idea | `ingest-uservoice.ts` |
| `belongs_to_theme` | 7,402 | call → theme | `ingest-gong-wiki.ts` Phase 4 |
| `mentions` | 4,486 | status → JIRA + body text links | `wire-cross-source-edges.ts` + `gbrain extract links` |
| `belongs_to_epic` | 4,144 | ticket → epic | `wire-cross-source-edges.ts` |
| `relates_to_theme` | 3,056 | idea → theme | `wire-cross-source-edges.ts` |
| `addresses_theme` | 1,491 | ticket/epic → theme | SQL (title keyword matching) |
| `blocks` | 1,232 | ticket → ticket | `wire-cross-source-edges.ts` |
| `had_call` | 1,183 | account → call | `ingest-gong-wiki.ts` Phase 4 + FRONTMATTER_LINK_MAP |
| `relates_to` | 1,002 | ticket ↔ ticket | `wire-cross-source-edges.ts` |
| `escalated` | 90 | body text | `gbrain extract links` |
| `renewed` | 71 | body text | `gbrain extract links` |
| + 5 more | 42 | various | auto-extract |

## The theme hub

Themes are the central node connecting all data sources. Every PM query traverses through themes:

```
account → had_call → call → belongs_to_theme → THEME ← addresses_theme ← JIRA ticket
                                                  ↑
                              idea → relates_to_theme
```

This means any new data source should connect to themes if it's about customer pain points or product areas.

## Ingestion order matters

Run ingestions in this order because later scripts match against earlier data:

1. **UserVoice** — creates 5,065 account pages (the customer reference set)
2. **Gong wiki** — matches its 60 customers against UV accounts by normalized name
3. **JIRA tickets** — standalone (no cross-references at ingest time)
4. **Confluence status reports** — standalone
5. **Cross-source edge wiring** — connects everything via frontmatter field resolution
6. **Auto-link extraction** — picks up body-text links and FRONTMATTER_LINK_MAP edges
7. **JIRA→theme SQL** — keyword-matches ticket titles to theme slugs

## Commands to rebuild from scratch

```bash
# Prerequisites
source ~/.zshrc
export DATABASE_URL="postgresql://wcheung@localhost/gbrain"

# 1. UserVoice (accounts + ideas + voted_for edges)
bun scripts/ingest-uservoice.ts ~/dev/data/user-voice.csv --no-embed

# 2. Gong wiki (calls + customers + themes + had_call + belongs_to_theme edges)
bun scripts/ingest-gong-wiki.ts ~/dev/data/wiki --no-embed

# 3. JIRA tickets + epics
bun scripts/ingest-jira-tickets.ts data/jira-tickets.json --no-embed

# 4. Confluence status reports
bun scripts/ingest-confluence-status.ts data/confluence-status-reports.json --no-embed

# 5. Cross-source edges (status→JIRA, ticket→epic, ticket↔ticket, idea→theme)
bun scripts/wire-cross-source-edges.ts

# 6. Auto-link extraction (body-text links + FRONTMATTER_LINK_MAP)
bun src/cli.ts extract links --source db

# 7. JIRA → theme edges (title keyword matching)
# See "JIRA→theme SQL" section below

# 8. Embeddings (takes a while on 23K pages, needs OPENAI_API_KEY)
bun src/cli.ts embed --stale
```

All scripts are idempotent. Re-running skips unchanged pages (content hash check) and duplicate edges (ON CONFLICT DO NOTHING).

## Data source details

### UserVoice (`scripts/ingest-uservoice.ts`)

**Input:** `~/dev/data/user-voice.csv` (42 MB, 24,634 rows)

**What it produces:**
- 6,606 idea pages at `ideas/uservoice/{id}` with frontmatter: forum, category, voters_count, total_revenue, voting_accounts, internal_status
- 5,065 account pages at `accounts/salesforce/{sf-id}` with frontmatter: account_name, arr, plan_name, segment, industry
- 21,164 `voted_for` edges (account → idea)

**Frontmatter fields for edges:**
- `voting_accounts` on ideas — company names that voted (used by ingest script for `voted_for` edges)

### Gong wiki (`scripts/ingest-gong-wiki.ts`)

**Input:** `~/dev/data/wiki/` directory containing:
- `sources/` — 4,254 call summary markdown files
- `customers/` — 60 customer profile markdown files
- `themes/` — 15 cross-customer theme analysis files (was 16 in spec, actual is 15)
- `overview.md`, `ml-opportunities.md` — synthesis pages

**What it produces:**
- 4,254 call pages at `calls/gong/{call-id}` with frontmatter: date, customer (resolved brain slug), tags, opportunity_stage
- 60 customer pages — 45 matched to existing `accounts/salesforce/*`, 15 created as `companies/{slug}`
- 15 theme pages at `themes/gong/{slug}` with frontmatter: category, customer_count, source_count, ml_relevant
- 2 synthesis pages at `wiki/gong/overview` and `wiki/gong/ml-opportunities`
- ~8,000 edges: `had_call` (account→call) + `belongs_to_theme` (call→theme)

**Customer entity resolution (Phase 1):**
The script normalizes company names (lowercase, strip Inc/LLC/Ltd/Corp/GmbH/NV/SA/Group/Holdings, strip parentheticals, collapse punctuation) and matches against UV account titles. Three matching passes:
1. Exact normalized name match
2. Starts-with fallback (min 4 chars)
3. Slash-separated alias match (e.g. "Musarubra / SkyHigh Security" tries "SkyHigh Security")

Match rate: 45/60 (75%). The remaining 15 are genuinely absent from UserVoice.

**Wikilink conversion:** Wiki uses `[[sources/123]]` format. The script converts to brain slugs: `[[sources/123]]` → `[Call 123](calls/gong/123)`, `[[customers/X]]` → resolved account slug, `[[themes/X]]` → `themes/gong/X`.

**Known issue:** `listPages` default limit was 100. Fixed to 10,000 in the script. If you add more than 10K accounts, bump this.

### JIRA (`scripts/ingest-jira-tickets.ts`)

**Input:** `data/jira-tickets.json` (10 MB, fetched via `scripts/fetch-ocp-data.ts`)

**What it produces:**
- 6,431 ticket pages at `tickets/jira/{key-lowercase}`
- 691 epic pages at `epics/jira/{key-lowercase}`
- Frontmatter: jira_key, status, priority, project, project_name, reporter, parent_epic, linked_issues, jira_url

**Key frontmatter fields for edges:**
- `parent_epic` — JIRA key of parent epic (resolved by `wire-cross-source-edges.ts`)
- `linked_issues` — array of `"relation: KEY"` strings like `"blocks: AUTH-2750"` or `"relates to: MNE-6605"`
- `jira_key` — the canonical JIRA key (used for slug resolution)

### Confluence status reports (`scripts/ingest-confluence-status.ts`)

**Input:** `data/confluence-status-reports.json` (536 KB, fetched via `scripts/fetch-ocp-data.ts`)

**What it produces:**
- 70 status pages at `status/ocp/{team}-{date}`
- 9 teams: NEXT, Mobile, Ingestion, AAX, DevEco, MnE, AppEx, AuthNZ, Integrations
- Date range: Dec 15, 2025 → Apr 24, 2026
- Frontmatter: team, team_key, date, jira_refs (array of JIRA keys), confluence_url

**Key frontmatter fields for edges:**
- `jira_refs` — JSON array of JIRA keys like `["FEAST-875", "FEP-304"]`. Resolved to ticket/epic slugs by `wire-cross-source-edges.ts`.

### Fetching fresh Confluence + JIRA data

```bash
# Requires Atlassian credentials
ATLASSIAN_EMAIL="your@email.com" \
ATLASSIAN_API_TOKEN="your-token" \
bun scripts/fetch-ocp-data.ts --all

# Or fetch only one:
bun scripts/fetch-ocp-data.ts --confluence
bun scripts/fetch-ocp-data.ts --jira
```

This writes `data/confluence-status-reports.json` and `data/jira-tickets.json`.

## Cross-source edge wiring (`scripts/wire-cross-source-edges.ts`)

This script creates edges between data sources that reference each other via non-slug identifiers (JIRA keys, company names, keywords). Run it after all ingestions.

| Edge type | Count | How it resolves |
|-----------|-------|-----------------|
| `mentions` (status→JIRA) | 1,318 | Builds JIRA key→slug index, resolves `jira_refs` array values |
| `belongs_to_epic` (ticket→epic) | 4,144 | Resolves `parent_epic` JIRA key to epic slug |
| `blocks` / `relates_to` (ticket↔ticket) | 2,236 | Parses `linked_issues` strings like `"blocks: KEY"` |
| `relates_to_theme` (idea→theme) | 3,056 | Keyword-matches idea `category` + `forum` fields against theme tags |

## JIRA→theme keyword matching

This is done via direct SQL because it's a one-time bulk operation. The SQL creates `addresses_theme` edges from JIRA tickets/epics whose titles contain theme-related keywords.

```sql
-- Run in psql after all ingestions
WITH theme_keywords AS (
  SELECT 'themes/gong/alert-noise-and-fatigue' as theme,
    unnest(ARRAY['alert noise', 'alert fatigue', 'noise reduction', 'suppression', 'dedup', 'flapping']) as keyword
  UNION ALL
  SELECT 'themes/gong/aiops-and-intelligent-grouping',
    unnest(ARRAY['intelligent grouping', 'aiops', 'ai ops', 'alert grouping', 'event grouping', 'correlation', 'machine learning'])
  UNION ALL
  SELECT 'themes/gong/automation-and-runbooks',
    unnest(ARRAY['runbook', 'automation', 'auto-remediation', 'automated', 'workflow', 'orchestration'])
  UNION ALL
  SELECT 'themes/gong/servicenow-integration-pain',
    unnest(ARRAY['servicenow', 'snow', 'itsm', 'cmdb'])
  UNION ALL
  SELECT 'themes/gong/event-orchestration-migration',
    unnest(ARRAY['event orchestration', 'orchestration', 'migration', 'event rule', 'routing rule'])
  UNION ALL
  SELECT 'themes/gong/grouping-accuracy-failures',
    unnest(ARRAY['grouping accuracy', 'false positive', 'mis-group', 'misgroup', 'merge', 'grouping'])
  UNION ALL
  SELECT 'themes/gong/status-pages-and-stakeholder-communication',
    unnest(ARRAY['status page', 'status update', 'stakeholder', 'communication', 'subscriber'])
  UNION ALL
  SELECT 'themes/gong/scheduling-complexity',
    unnest(ARRAY['schedule', 'scheduling', 'on-call', 'oncall', 'rotation', 'escalation policy'])
  UNION ALL
  SELECT 'themes/gong/stale-configuration-and-unused-services',
    unnest(ARRAY['stale', 'unused', 'cleanup', 'configuration', 'audit'])
  UNION ALL
  SELECT 'themes/gong/manual-triage-and-processes',
    unnest(ARRAY['triage', 'manual', 'toil', 'acknowledge', 'priorit'])
  UNION ALL
  SELECT 'themes/gong/churn-drivers',
    unnest(ARRAY['churn', 'cancel', 'competitor', 'switch', 'renewal'])
  UNION ALL
  SELECT 'themes/gong/competitive-pressure',
    unnest(ARRAY['opsgenie', 'datadog', 'splunk', 'grafana', 'competitor'])
  UNION ALL
  SELECT 'themes/gong/jelly-postmortem-gaps',
    unnest(ARRAY['postmortem', 'post-mortem', 'retrospective', 'jelly', 'review'])
  UNION ALL
  SELECT 'themes/gong/agentic-ai-adoption-blockers',
    unnest(ARRAY['agentic', 'copilot', 'ai agent', 'llm', 'generative'])
  UNION ALL
  SELECT 'themes/gong/non-iag-ml-opportunities',
    unnest(ARRAY['machine learning', 'prediction', 'anomaly', 'forecast', 'classify'])
),
matches AS (
  SELECT DISTINCT p.id as ticket_id, tp.id as theme_id, tk.keyword
  FROM theme_keywords tk
  JOIN pages p ON (p.type = 'ticket' OR p.type = 'feature')
    AND lower(p.title) LIKE '%' || tk.keyword || '%'
  JOIN pages tp ON tp.slug = tk.theme
)
INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source, origin_page_id, origin_field)
SELECT m.ticket_id, m.theme_id, 'addresses_theme', 'title keyword: ' || m.keyword, 'manual', m.ticket_id, 'title'
FROM matches m
ON CONFLICT DO NOTHING;
```

When adding new themes, add their keyword mappings to this SQL and re-run. ON CONFLICT DO NOTHING makes it safe.

## Auto-link extraction

`gbrain extract links --source db` scans all pages and creates edges from:

1. **Body-text markdown links** — `[Name](slug)` in page bodies → `mentions` edges
2. **FRONTMATTER_LINK_MAP** entries in `src/core/link-extraction.ts` — maps frontmatter fields to typed edges

Current FRONTMATTER_LINK_MAP entries relevant to our data:

```typescript
// Status reports
{ fields: ['jira_refs'], pageType: 'status', type: 'mentions', direction: 'outgoing', dirHint: 'tickets/jira' },
{ fields: ['customers'], pageType: 'status', type: 'is_customer_of', direction: 'outgoing', dirHint: ['accounts', 'companies'] },
{ fields: ['people_mentioned'], pageType: 'status', type: 'mentions', direction: 'outgoing', dirHint: 'people' },

// Call pages (Gong)
{ fields: ['customer'], pageType: 'call', type: 'had_call', direction: 'incoming', dirHint: ['companies', 'accounts'] },
```

**Important:** FRONTMATTER_LINK_MAP values must be brain slugs (e.g. `accounts/salesforce/001...`), not raw identifiers (e.g. `JIRA-123`). That's why `wire-cross-source-edges.ts` exists — to resolve non-slug references.

## How to add a new data source

### 1. Choose slug pattern and page type

Pick a slug pattern that follows existing conventions:

```
{plural-noun}/{source}/{id}
```

Examples: `calls/gong/{id}`, `tickets/jira/{key}`, `ideas/uservoice/{id}`, `accounts/salesforce/{id}`

If you need a new page type, add it to `src/core/types.ts:6` (the `PageType` union) and add inference to `src/core/markdown.ts` (`inferType` function).

### 2. Add directory prefix to DIR_PATTERN

In `src/core/link-extraction.ts:47`, add your new directory prefix to `DIR_PATTERN` so body-text auto-link extraction recognizes it:

```typescript
const DIR_PATTERN = '(?:people|companies|...|your-prefix)';
```

### 3. Write the ingestion script

Follow the pattern in `scripts/ingest-uservoice.ts` or `scripts/ingest-gong-wiki.ts`:

```typescript
import { importFromContent } from '../src/core/import-file.ts';
import * as db from '../src/core/db.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { LinkBatchInput } from '../src/core/engine.ts';

// 1. Parse your data source
// 2. Build page content with YAML frontmatter + markdown body
// 3. Call importFromContent(engine, slug, content, { noEmbed }) for each page
// 4. Batch-create edges via engine.addLinksBatch(edges)
```

Key API:
- `importFromContent(engine, slug, content, { noEmbed })` — idempotent via content hash. Returns `{ status: 'imported' | 'skipped' | 'error' }`
- `engine.addLinksBatch(edges)` — bulk edge creation with ON CONFLICT DO NOTHING. Pass arrays of `LinkBatchInput`
- `engine.listPages({ type, limit })` — for entity resolution. Default limit is 100, override for large sets

### 4. Connect to the theme hub

If your data relates to customer pain points or product areas, create edges to themes:
- **Frontmatter tags** → match against theme tag index (see `ingest-gong-wiki.ts` Phase 4)
- **Title keywords** → match against theme keyword list (see JIRA→theme SQL above)
- **Category/forum fields** → keyword match (see `wire-cross-source-edges.ts` section 4)

### 5. Add cross-source edges

If your data references other sources (JIRA keys, customer names, etc.), add a section to `wire-cross-source-edges.ts` to resolve those references to brain slugs and create edges.

### 6. Run post-ingestion

```bash
bun src/cli.ts extract links --source db    # auto-link from body text + FRONTMATTER_LINK_MAP
bun src/cli.ts embed --stale                # generate embeddings for search
```

## Link table schema

```
links(id, from_page_id, to_page_id, link_type, context, link_source, origin_page_id, origin_field, resolution_type, created_at)
```

- `link_source` must be one of: `'markdown'`, `'frontmatter'`, `'manual'`, or `NULL`
- `link_type` is free-form text (no enum constraint)
- ON CONFLICT is `(from_page_id, to_page_id, link_type)` — one edge per type per pair

## Useful queries

```bash
# Page counts by type
psql gbrain -c "SELECT type, count(*) FROM pages GROUP BY type ORDER BY count DESC;"

# Edge counts by type
psql gbrain -c "SELECT link_type, count(*) FROM links GROUP BY link_type ORDER BY count DESC;"

# Total pages and edges
psql gbrain -c "SELECT count(*) as pages FROM pages; SELECT count(*) as edges FROM links;"

# Graph traversal (CLI)
gbrain graph-query themes/gong/alert-noise-and-fatigue --direction in --depth 1
gbrain graph-query accounts/salesforce/001e000000vdxzsiab --direction both --depth 2

# Rank by frontmatter field
gbrain rank --type theme --field source_count --limit 10
gbrain rank --type idea --field voters_count --limit 20

# Search
gbrain search "alert noise customer pain"
```

## File inventory

| File | Purpose |
|------|---------|
| `scripts/ingest-uservoice.ts` | UserVoice CSV → accounts + ideas + voted_for edges |
| `scripts/ingest-gong-wiki.ts` | Gong wiki dir → calls + customers + themes + edges |
| `scripts/ingest-jira-tickets.ts` | JIRA JSON → tickets + epics |
| `scripts/ingest-confluence-status.ts` | Confluence JSON → status reports |
| `scripts/fetch-ocp-data.ts` | Fetch fresh Confluence + JIRA data via Atlassian API |
| `scripts/wire-cross-source-edges.ts` | Cross-source edge wiring (status→JIRA, ticket→epic, etc.) |
| `scripts/weekly-rollup.ts` | Generate weekly status rollup report |
| `src/core/link-extraction.ts` | DIR_PATTERN + FRONTMATTER_LINK_MAP (auto-link config) |
| `src/core/types.ts` | PageType union (add new types here) |
| `src/core/markdown.ts` | inferType function (slug→type inference) |
| `src/core/operations.ts` | list_pages_ranked operation |
| `src/commands/rank.ts` | gbrain rank CLI command |

## Data file locations

| File | Size | Contents |
|------|------|----------|
| `~/dev/data/user-voice.csv` | 42 MB | 24,634 rows of UserVoice export |
| `~/dev/data/wiki/` | ~4,349 files | Gong call summaries, customers, themes |
| `data/confluence-status-reports.json` | 536 KB | 70 OCP status reports |
| `data/jira-tickets.json` | 10 MB | 7,122 JIRA issues |
| `data/rollup-*.md` | ~10 KB each | Generated weekly rollup reports |
