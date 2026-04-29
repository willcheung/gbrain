#!/usr/bin/env bun
/**
 * Wire JIRA ticket/epic → theme edges via title keyword matching.
 *
 * Bridges the idea→JIRA traversal gap through the theme hub:
 *   idea → relates_to_theme → THEME ← addresses_theme ← JIRA ticket
 *
 * Safe to re-run: ON CONFLICT DO NOTHING via addLinksBatch.
 *
 * Usage:
 *   DATABASE_URL="postgresql://wcheung@localhost/gbrain" bun scripts/wire-theme-edges.ts [--dry-run]
 */

import * as db from '../src/core/db.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { LinkBatchInput } from '../src/core/engine.ts';

const dryRun = process.argv.includes('--dry-run');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) { console.error('DATABASE_URL not set'); process.exit(1); }

// Theme → keywords mapping. Add new themes here and re-run.
const THEME_KEYWORDS: Record<string, string[]> = {
  'themes/gong/alert-noise-and-fatigue': ['alert noise', 'alert fatigue', 'noise reduction', 'suppression', 'dedup', 'flapping'],
  'themes/gong/aiops-and-intelligent-grouping': ['intelligent grouping', 'aiops', 'ai ops', 'alert grouping', 'event grouping', 'correlation', 'machine learning'],
  'themes/gong/automation-and-runbooks': ['runbook', 'automation', 'auto-remediation', 'automated', 'workflow', 'orchestration'],
  'themes/gong/servicenow-integration-pain': ['servicenow', 'snow', 'itsm', 'cmdb'],
  'themes/gong/event-orchestration-migration': ['event orchestration', 'orchestration', 'migration', 'event rule', 'routing rule'],
  'themes/gong/grouping-accuracy-failures': ['grouping accuracy', 'false positive', 'mis-group', 'misgroup', 'merge', 'grouping'],
  'themes/gong/status-pages-and-stakeholder-communication': ['status page', 'status update', 'stakeholder', 'communication', 'subscriber'],
  'themes/gong/scheduling-complexity': ['schedule', 'scheduling', 'on-call', 'oncall', 'rotation', 'escalation policy'],
  'themes/gong/stale-configuration-and-unused-services': ['stale', 'unused', 'cleanup', 'configuration', 'audit'],
  'themes/gong/manual-triage-and-processes': ['triage', 'manual', 'toil', 'acknowledge', 'priorit'],
  'themes/gong/churn-drivers': ['churn', 'cancel', 'competitor', 'switch', 'renewal'],
  'themes/gong/competitive-pressure': ['opsgenie', 'datadog', 'splunk', 'grafana', 'competitor'],
  'themes/gong/jelly-postmortem-gaps': ['postmortem', 'post-mortem', 'retrospective', 'jelly', 'review'],
  'themes/gong/agentic-ai-adoption-blockers': ['agentic', 'copilot', 'ai agent', 'llm', 'generative'],
  'themes/gong/non-iag-ml-opportunities': ['machine learning', 'prediction', 'anomaly', 'forecast', 'classify'],
};

async function main() {
  console.log(`JIRA→Theme edge wiring (addresses_theme)${dryRun ? ' (DRY RUN)' : ''}\n`);

  await db.connect({ engine: 'postgres', database_url: databaseUrl });
  const engine = new PostgresEngine();
  const sql = (engine as any).sql;

  // Load all ticket/epic pages
  const tickets = await sql`
    SELECT id, slug, lower(title) as title
    FROM pages WHERE type = 'ticket' OR type = 'feature'
  `;
  console.log(`  ${tickets.length} tickets/epics loaded`);

  // Load theme pages to verify slugs exist
  const themePages = await sql`
    SELECT id, slug FROM pages WHERE type = 'theme'
  `;
  const themeIdBySlug = new Map<string, number>();
  for (const t of themePages) themeIdBySlug.set(t.slug, t.id);
  console.log(`  ${themePages.length} themes loaded`);

  // Match tickets against theme keywords
  const edges: LinkBatchInput[] = [];
  const themeCounts = new Map<string, number>();
  const matched = new Set<string>();

  for (const [themeSlug, keywords] of Object.entries(THEME_KEYWORDS)) {
    if (!themeIdBySlug.has(themeSlug)) {
      console.log(`  WARNING: theme ${themeSlug} not found in DB, skipping`);
      continue;
    }
    for (const ticket of tickets) {
      for (const kw of keywords) {
        if (ticket.title.includes(kw)) {
          const key = `${ticket.slug}→${themeSlug}`;
          if (matched.has(key)) break; // one edge per ticket→theme pair
          matched.add(key);
          edges.push({
            from_slug: ticket.slug,
            to_slug: themeSlug,
            link_type: 'addresses_theme',
            context: `title keyword: ${kw}`,
            link_source: 'manual',
            origin_slug: ticket.slug,
            origin_field: 'title',
          });
          themeCounts.set(themeSlug, (themeCounts.get(themeSlug) || 0) + 1);
          break; // found a match, move to next ticket for this theme
        }
      }
    }
  }

  console.log(`\n  ${edges.length} addresses_theme edges to create`);

  if (dryRun) {
    console.log('  [dry-run] No edges created');
  } else {
    // Flush in batches of 5000
    let totalCreated = 0;
    for (let i = 0; i < edges.length; i += 5000) {
      const batch = edges.slice(i, i + 5000);
      totalCreated += await engine.addLinksBatch(batch);
    }
    console.log(`  ${totalCreated} new edges created (${edges.length - totalCreated} already existed)`);
  }

  // Print distribution
  console.log('\n  Theme match distribution:');
  const sorted = [...themeCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [theme, count] of sorted) {
    console.log(`    ${theme.replace('themes/gong/', '')}: ${count}`);
  }

  await engine.disconnect();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
