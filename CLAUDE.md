# CLAUDE.md

GBrain is a personal knowledge brain with pluggable engines (PGLite or Postgres+pgvector),
hybrid search, and a self-wiring knowledge graph. This instance is configured as a
**PagerDuty PM Intelligence Brain** — see the project-level CLAUDE.md for PM-specific
query patterns, data sources, and scripts.

## Architecture

Contract-first: `src/core/operations.ts` defines ~42 shared operations. CLI (`src/cli.ts`)
and MCP server (`src/mcp/server.ts`) are both generated from this single source. Engine
factory (`src/core/engine-factory.ts`) dynamically imports `'pglite'` or `'postgres'`.

## Key files

- `src/core/operations.ts` — Operation definitions (the foundation)
- `src/core/engine.ts` — Pluggable engine interface. Exports `LinkBatchInput` / `TimelineBatchInput`
- `src/core/postgres-engine.ts` — Postgres+pgvector implementation (what this brain uses)
- `src/core/db.ts` — Connection management, schema init
- `src/core/import-file.ts` — `importFromFile` + `importFromContent` (chunk + embed + tags)
- `src/core/link-extraction.ts` — Graph edge extraction. `FRONTMATTER_LINK_MAP` maps frontmatter fields to typed edges. `DIR_PATTERN` whitelists directory prefixes for entity extraction.
- `src/core/embedding.ts` — OpenAI text-embedding-3-large, batch, retry, backoff
- `src/core/search/` — Hybrid search: vector + keyword + RRF + multi-query expansion
- `src/core/chunkers/` — 3-tier chunking (recursive, semantic, LLM-guided)
- `src/mcp/server.ts` — MCP stdio server (generated from operations)
- `src/cli.ts` — CLI entry point
- `src/schema.sql` — Full Postgres+pgvector DDL (source of truth)
- `skills/RESOLVER.md` — Skill routing table

## Commands

Run `gbrain --help` for full reference. Key commands:
- `gbrain serve` — Start MCP server (stdio)
- `gbrain search <query>` — Hybrid search
- `gbrain get <slug>` — Get a page
- `gbrain list --type <type>` — List pages
- `gbrain rank --type <type> --field <field>` — Rank by numeric frontmatter
- `gbrain embed --stale` — Embed pages missing embeddings
- `gbrain extract links --source db` — Extract/create graph edges from pages
- `gbrain graph-query <slug>` — Traverse graph relationships
- `gbrain doctor` — Health checks

## Testing

`bun test` runs unit tests (no database required).
`bun run test:e2e` runs E2E tests (requires `DATABASE_URL`).

## Build

`bun build --compile --outfile bin/gbrain src/cli.ts`

## Skills

29 skills in `skills/`, routed by `skills/RESOLVER.md`. Key skills for this brain:
query, brain-ops, enrich, maintain, ingest, briefing, data-research, reports.
See `skills/RESOLVER.md` for the full routing table.
