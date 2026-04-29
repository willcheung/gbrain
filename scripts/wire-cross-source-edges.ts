#!/usr/bin/env bun
/**
 * Wire cross-source edges that auto-link can't handle.
 *
 * Creates edges between data sources that reference each other via non-slug identifiers
 * (JIRA keys, company names, tag keywords).
 *
 * Edge types created:
 *   1. status_report → JIRA ticket/epic (via jira_refs frontmatter, JIRA key resolution)
 *   2. ticket → epic (via parent_epic frontmatter)
 *   3. ticket ↔ ticket (via linked_issues frontmatter)
 *   4. idea → theme (via tag/keyword matching between UV categories and Gong themes)
 *
 * Usage:
 *   DATABASE_URL="postgresql://wcheung@localhost/gbrain" bun scripts/wire-cross-source-edges.ts [--dry-run]
 */

import * as db from '../src/core/db.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { LinkBatchInput } from '../src/core/engine.ts';

const dryRun = process.argv.includes('--dry-run');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) { console.error('DATABASE_URL not set'); process.exit(1); }

async function main() {
  console.log(`Cross-source edge wiring${dryRun ? ' (DRY RUN)' : ''}\n`);

  await db.connect({ engine: 'postgres', database_url: databaseUrl });
  const engine = new PostgresEngine();
  const sql = (engine as any).sql;

  const BATCH_SIZE = 5000;
  let totalCreated = 0;

  async function flushBatch(batch: LinkBatchInput[], label: string): Promise<number> {
    if (batch.length === 0) return 0;
    if (dryRun) {
      console.log(`  [dry-run] Would create ${batch.length} ${label} edges`);
      return 0;
    }
    const created = await engine.addLinksBatch(batch);
    totalCreated += created;
    return created;
  }

  // =========================================================================
  // 1. Status reports → JIRA tickets (via jira_refs)
  // =========================================================================
  console.log('=== 1. Status reports → JIRA tickets (jira_refs) ===');

  // Build JIRA key → slug index
  const jiraKeyIndex = new Map<string, string>();
  const ticketPages = await sql`
    SELECT slug, frontmatter->>'jira_key' as jira_key
    FROM pages WHERE (type = 'ticket' OR type = 'feature')
    AND frontmatter->>'jira_key' IS NOT NULL
  `;
  for (const row of ticketPages) {
    jiraKeyIndex.set(row.jira_key.toUpperCase(), row.slug);
  }
  console.log(`  ${jiraKeyIndex.size} JIRA keys indexed`);

  // Load status reports with jira_refs
  const statusPages = await sql`
    SELECT slug, frontmatter->'jira_refs' as jira_refs
    FROM pages WHERE type = 'status'
    AND frontmatter->'jira_refs' IS NOT NULL
    AND jsonb_typeof(frontmatter->'jira_refs') = 'array'
  `;

  let statusEdges: LinkBatchInput[] = [];
  let statusResolved = 0, statusUnresolved = 0;
  for (const page of statusPages) {
    const refs = page.jira_refs as string[];
    for (const ref of refs) {
      const key = ref.toUpperCase().trim();
      const ticketSlug = jiraKeyIndex.get(key);
      if (ticketSlug) {
        statusEdges.push({
          from_slug: page.slug,
          to_slug: ticketSlug,
          link_type: 'mentions',
          context: `jira_refs: ${ref}`,
          link_source: 'frontmatter',
          origin_slug: page.slug,
          origin_field: 'jira_refs',
        });
        statusResolved++;
        if (statusEdges.length >= BATCH_SIZE) {
          await flushBatch(statusEdges, 'status→jira');
          statusEdges = [];
        }
      } else {
        statusUnresolved++;
      }
    }
  }
  const statusCreated = await flushBatch(statusEdges, 'status→jira');
  console.log(`  ${statusResolved} resolved, ${statusUnresolved} unresolved, ${statusCreated} edges created\n`);

  // =========================================================================
  // 2. Tickets → Epics (via parent_epic)
  // =========================================================================
  console.log('=== 2. Tickets → Epics (parent_epic) ===');

  const ticketsWithEpic = await sql`
    SELECT slug, frontmatter->>'parent_epic' as parent_epic
    FROM pages WHERE type = 'ticket'
    AND frontmatter->>'parent_epic' IS NOT NULL
    AND frontmatter->>'parent_epic' != ''
  `;

  let epicEdges: LinkBatchInput[] = [];
  let epicResolved = 0, epicUnresolved = 0;
  for (const ticket of ticketsWithEpic) {
    const epicKey = ticket.parent_epic.toUpperCase().trim();
    const epicSlug = jiraKeyIndex.get(epicKey);
    if (epicSlug) {
      epicEdges.push({
        from_slug: ticket.slug,
        to_slug: epicSlug,
        link_type: 'belongs_to_epic',
        context: `parent_epic: ${ticket.parent_epic}`,
        link_source: 'frontmatter',
        origin_slug: ticket.slug,
        origin_field: 'parent_epic',
      });
      epicResolved++;
      if (epicEdges.length >= BATCH_SIZE) {
        await flushBatch(epicEdges, 'ticket→epic');
        epicEdges = [];
      }
    } else {
      epicUnresolved++;
    }
  }
  const epicCreated = await flushBatch(epicEdges, 'ticket→epic');
  console.log(`  ${epicResolved} resolved, ${epicUnresolved} unresolved, ${epicCreated} edges created\n`);

  // =========================================================================
  // 3. Ticket ↔ Ticket (via linked_issues)
  // =========================================================================
  console.log('=== 3. Ticket ↔ Ticket (linked_issues) ===');

  const ticketsWithLinks = await sql`
    SELECT slug, frontmatter->'linked_issues' as linked_issues
    FROM pages WHERE (type = 'ticket' OR type = 'feature')
    AND frontmatter->'linked_issues' IS NOT NULL
    AND jsonb_typeof(frontmatter->'linked_issues') = 'array'
    AND frontmatter->>'linked_issues' != '[]'
  `;

  let linkEdges: LinkBatchInput[] = [];
  let linkResolved = 0, linkUnresolved = 0;
  for (const ticket of ticketsWithLinks) {
    const links = ticket.linked_issues as string[];
    for (const link of links) {
      // Format: "relates to: MNE-6605" or "blocks: AUTH-2750" or "is blocked by: AUTH-2748"
      const match = link.match(/^(.*?):\s*([A-Z]+-\d+)$/i);
      if (!match) continue;

      const relation = match[1].trim().toLowerCase();
      const targetKey = match[2].toUpperCase();
      const targetSlug = jiraKeyIndex.get(targetKey);
      if (!targetSlug) { linkUnresolved++; continue; }

      // Determine link type and direction
      let linkType = 'relates_to';
      let fromSlug = ticket.slug;
      let toSlug = targetSlug;

      if (relation === 'blocks') {
        linkType = 'blocks';
      } else if (relation === 'is blocked by') {
        linkType = 'blocks';
        fromSlug = targetSlug;
        toSlug = ticket.slug;
      } else if (relation === 'clones' || relation === 'is cloned by') {
        linkType = 'relates_to'; // treat clones as relates
      }

      linkEdges.push({
        from_slug: fromSlug,
        to_slug: toSlug,
        link_type: linkType,
        context: link,
        link_source: 'frontmatter',
        origin_slug: ticket.slug,
        origin_field: 'linked_issues',
      });
      linkResolved++;
      if (linkEdges.length >= BATCH_SIZE) {
        await flushBatch(linkEdges, 'ticket↔ticket');
        linkEdges = [];
      }
    }
  }
  const linkCreated = await flushBatch(linkEdges, 'ticket↔ticket');
  console.log(`  ${linkResolved} resolved, ${linkUnresolved} unresolved, ${linkCreated} edges created\n`);

  // =========================================================================
  // 4. Ideas → Themes (tag/keyword matching)
  // =========================================================================
  console.log('=== 4. Ideas → Themes (category/forum keyword matching) ===');

  // Build theme keyword index from theme tags and slug keywords
  const themePages = await sql`
    SELECT slug, title, frontmatter->'tags' as tags
    FROM pages WHERE type = 'theme'
  `;

  // Map of keyword → theme slug
  const themeKeywords = new Map<string, string>();
  // More specific mapping: theme slug → set of keywords for matching
  const themeMatchPatterns = new Map<string, string[]>();

  for (const theme of themePages) {
    const slug = theme.slug as string;
    const themeSlug = slug.replace('themes/gong/', '');
    const keywords = themeSlug.split('-').filter((k: string) => k.length > 3);
    themeMatchPatterns.set(slug, keywords);

    // Index by full slug name and individual keywords
    themeKeywords.set(themeSlug.replace(/-/g, ' '), slug);
    for (const kw of keywords) {
      if (!themeKeywords.has(kw)) themeKeywords.set(kw, slug);
    }

    // Index theme tags
    if (Array.isArray(theme.tags)) {
      for (const tag of theme.tags as string[]) {
        const norm = String(tag).toLowerCase().trim();
        if (!themeKeywords.has(norm)) themeKeywords.set(norm, slug);
      }
    }
  }
  console.log(`  ${themeKeywords.size} theme keywords indexed from ${themePages.length} themes`);

  // Match ideas by category and forum fields
  const ideas = await sql`
    SELECT slug,
      frontmatter->>'category' as category,
      frontmatter->>'forum' as forum
    FROM pages WHERE type = 'idea'
    AND (frontmatter->>'category' IS NOT NULL OR frontmatter->>'forum' IS NOT NULL)
  `;

  let ideaEdges: LinkBatchInput[] = [];
  let ideaMatched = 0, ideaUnmatched = 0;
  const matchedThemeCounts = new Map<string, number>();

  for (const idea of ideas) {
    // Combine category + forum into searchable text
    const text = `${idea.category || ''} ${idea.forum || ''}`.toLowerCase();
    const matchedThemes = new Set<string>();

    // Try to match against theme keywords
    for (const [keyword, themeSlug] of themeKeywords) {
      if (keyword.length >= 4 && text.includes(keyword) && !matchedThemes.has(themeSlug)) {
        matchedThemes.add(themeSlug);
        ideaEdges.push({
          from_slug: idea.slug,
          to_slug: themeSlug,
          link_type: 'relates_to_theme',
          context: `category: ${idea.category}, forum: ${idea.forum}`,
          link_source: 'manual',
          origin_slug: idea.slug,
          origin_field: 'category',
        });
        ideaMatched++;
        matchedThemeCounts.set(themeSlug, (matchedThemeCounts.get(themeSlug) || 0) + 1);
        if (ideaEdges.length >= BATCH_SIZE) {
          await flushBatch(ideaEdges, 'idea→theme');
          ideaEdges = [];
        }
      }
    }

    if (matchedThemes.size === 0) ideaUnmatched++;
  }
  const ideaCreated = await flushBatch(ideaEdges, 'idea→theme');
  console.log(`  ${ideaMatched} idea→theme matches, ${ideaUnmatched} ideas with no theme match, ${ideaCreated} edges created`);

  // Print theme match distribution
  const sorted = [...matchedThemeCounts.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`  Theme match distribution:`);
  for (const [theme, count] of sorted) {
    console.log(`    ${theme}: ${count}`);
  }

  // =========================================================================
  // Summary
  // =========================================================================
  console.log(`\n=== Summary ===`);
  console.log(`  Status → JIRA:    ${statusResolved} resolved → ${statusCreated} edges`);
  console.log(`  Ticket → Epic:    ${epicResolved} resolved → ${epicCreated} edges`);
  console.log(`  Ticket ↔ Ticket:  ${linkResolved} resolved → ${linkCreated} edges`);
  console.log(`  Idea → Theme:     ${ideaMatched} matched → ${ideaCreated} edges`);
  console.log(`  Total new edges:  ${totalCreated}`);

  await engine.disconnect();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
