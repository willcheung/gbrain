#!/usr/bin/env bun
/**
 * Ingest Gong wiki into gbrain (4-phase).
 *
 * Usage:
 *   DATABASE_URL="postgresql://wcheung@localhost/gbrain" bun scripts/ingest-gong-wiki.ts <wiki-dir> [--no-embed] [--dry-run]
 *
 * Phases:
 *   1. Scan & resolve customers — match wiki customer files to brain account pages
 *   2. Ingest customers + themes + synthesis pages
 *   3. Ingest source call summaries
 *   4. Batch edge creation (had_call + belongs_to_theme)
 */

import { importFromContent } from '../src/core/import-file.ts';
import * as db from '../src/core/db.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { LinkBatchInput } from '../src/core/engine.ts';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';

// ---------------------------------------------------------------------------
// YAML lite parser (handles the frontmatter formats in the wiki data)
// ---------------------------------------------------------------------------

function parseFrontmatter(content: string): { fm: Record<string, unknown>; body: string } {
  if (!content.startsWith('---')) {
    return { fm: {}, body: content };
  }
  const end = content.indexOf('\n---', 3);
  if (end === -1) {
    return { fm: {}, body: content };
  }
  const yamlBlock = content.slice(4, end); // skip opening '---\n'
  const body = content.slice(end + 4).trimStart(); // skip closing '\n---'

  const fm: Record<string, unknown> = {};

  // State machine: handle scalar, inline array, and block array values
  const lines = yamlBlock.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Skip blank lines and comments
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }

    // Block array item (starts with '  - ')
    // (handled inside key parsing below)

    // Key: value  OR  Key:
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) { i++; continue; }

    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();

    if (!key) { i++; continue; }

    if (rest === '') {
      // Possible block array — peek at next lines for '  - ' items
      const items: string[] = [];
      i++;
      while (i < lines.length && /^\s+-\s/.test(lines[i])) {
        const item = lines[i].replace(/^\s+-\s*/, '').trim();
        items.push(unquote(item));
        i++;
      }
      fm[key] = items.length > 0 ? items : '';
    } else if (rest.startsWith('[') && rest.endsWith(']')) {
      // Inline array: [a, b, c]
      const inner = rest.slice(1, -1);
      const items = splitCsv(inner).map(s => unquote(s.trim())).filter(Boolean);
      fm[key] = items;
      i++;
    } else {
      fm[key] = unquote(rest);
      i++;
    }
  }

  return { fm, body };
}

function unquote(s: string): string {
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/** Split a CSV string respecting basic quoted strings */
function splitCsv(s: string): string[] {
  const results: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';
  for (const ch of s) {
    if (!inQuote && (ch === '"' || ch === "'")) {
      inQuote = true;
      quoteChar = ch;
      current += ch;
    } else if (inQuote && ch === quoteChar) {
      inQuote = false;
      quoteChar = '';
      current += ch;
    } else if (!inQuote && ch === ',') {
      results.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) results.push(current);
  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    // strip parentheticals
    .replace(/\s*\(.*?\)/g, '')
    // strip common suffixes
    .replace(/\b(inc|llc|ltd|corp|gmbh|plc|limited|corporation|lp|co)\b\.?/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toTitleCase(s: string): string {
  return s.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function readFile(path: string): string {
  return readFileSync(path, 'utf-8');
}

function listMdFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => join(dir, f));
}

// Extract wikilink target: [[customers/roblox]] → "customers/roblox"
function extractWikiTarget(wikilink: string): string {
  return wikilink.replace(/^\[\[/, '').replace(/\]\]$/, '').split('|')[0].trim();
}

// ---------------------------------------------------------------------------
// YAML output builder (mirrors ingest-uservoice.ts pattern)
// ---------------------------------------------------------------------------

function buildYaml(fm: Record<string, unknown>): string {
  let yaml = '---\n';
  for (const [key, value] of Object.entries(fm)) {
    if (Array.isArray(value)) {
      yaml += `${key}:\n`;
      for (const item of value) {
        yaml += `  - ${JSON.stringify(String(item))}\n`;
      }
    } else if (typeof value === 'number') {
      yaml += `${key}: ${value}\n`;
    } else if (typeof value === 'boolean') {
      yaml += `${key}: ${value}\n`;
    } else {
      yaml += `${key}: ${JSON.stringify(value)}\n`;
    }
  }
  yaml += '---\n\n';
  return yaml;
}

// ---------------------------------------------------------------------------
// Wikilink resolver — converts [[...]] to markdown links in body text
// ---------------------------------------------------------------------------

function resolveWikilinks(
  text: string,
  customerSlugMap: Map<string, string>,  // wiki slug (e.g. "customers/roblox") → brain slug
): string {
  return text.replace(/\[\[([^\]]+)\]\]/g, (match, inner) => {
    const target = inner.split('|')[0].trim();
    const displayName = inner.includes('|') ? inner.split('|')[1].trim() : null;

    // Strip evidence links
    if (target.startsWith('themes/evidence/')) return '';
    // Strip log links
    if (target === 'log' || target.startsWith('logs/')) return '';

    // Sources: [[sources/123]] → [Call 123](calls/gong/123)
    if (target.startsWith('sources/')) {
      const callId = target.slice('sources/'.length);
      const display = displayName ?? `Call ${callId}`;
      return `[${display}](calls/gong/${callId})`;
    }

    // Customers: [[customers/roblox]] → resolve to brain slug
    if (target.startsWith('customers/')) {
      const wikiSlug = target;
      const brainSlug = customerSlugMap.get(wikiSlug);
      if (brainSlug) {
        const shortName = basename(target); // e.g. "roblox"
        const display = displayName ?? toTitleCase(shortName);
        return `[${display}](${brainSlug})`;
      } else {
        // Unmatched — use companies/ fallback
        const shortName = basename(target);
        const display = displayName ?? toTitleCase(shortName);
        return `[${display}](companies/${shortName})`;
      }
    }

    // Themes: [[themes/alert-noise-and-fatigue]] → brain slug
    if (target.startsWith('themes/')) {
      const themeSlug = target.slice('themes/'.length);
      const display = displayName ?? toTitleCase(themeSlug);
      return `[${display}](themes/gong/${themeSlug})`;
    }

    // Synthesis pages
    if (target === 'overview') return `[${displayName ?? 'Overview'}](wiki/gong/overview)`;
    if (target === 'ml-opportunities') return `[${displayName ?? 'ML Opportunities'}](wiki/gong/ml-opportunities)`;

    // Fallback: strip the wikilink
    return displayName ?? target;
  });
}

// ---------------------------------------------------------------------------
// Page builders
// ---------------------------------------------------------------------------

function buildCustomerPage(slug: string, fm: Record<string, unknown>, body: string, customerSlugMap: Map<string, string>): string {
  const name = String(fm.customer_name ?? toTitleCase(basename(slug)));
  const tags = Array.isArray(fm.tags) ? fm.tags as string[] : [];

  const outFm: Record<string, unknown> = {
    type: 'company',
    title: name,
    tags: ['gong', 'customer', ...tags],
    source: 'gong-wiki',
  };
  if (fm.call_count) outFm.call_count = fm.call_count;
  if (fm.date_range) outFm.date_range = fm.date_range;
  if (fm.stages) outFm.stages = fm.stages;
  if (fm.outcome) outFm.outcome = fm.outcome;
  if (fm.industry) outFm.industry = fm.industry;

  const resolvedBody = resolveWikilinks(body, customerSlugMap);
  const header = `# ${name}\n\n`;
  return buildYaml(outFm) + header + resolvedBody;
}

function buildThemePage(slug: string, fm: Record<string, unknown>, body: string, customerSlugMap: Map<string, string>): string {
  const themeSlug = slug.replace('themes/gong/', '');
  const title = toTitleCase(themeSlug);
  const tags = Array.isArray(fm.tags) ? fm.tags as string[] : [];

  const outFm: Record<string, unknown> = {
    type: 'theme',
    title,
    tags: ['gong', 'theme', ...tags],
    source: 'gong-wiki',
    category: fm.category ?? '',
  };
  if (fm.customer_count) outFm.customer_count = fm.customer_count;
  if (fm.source_count) outFm.source_count = fm.source_count;
  if (fm.ml_relevant !== undefined) outFm.ml_relevant = fm.ml_relevant;

  const resolvedBody = resolveWikilinks(body, customerSlugMap);
  return buildYaml(outFm) + resolvedBody;
}

function buildSynthesisPage(slug: string, fm: Record<string, unknown>, body: string, customerSlugMap: Map<string, string>): string {
  const title = slug === 'wiki/gong/overview' ? 'PagerDuty Sales Signal Wiki Overview' : 'ML Opportunities from Customer Signal';
  const outFm: Record<string, unknown> = {
    type: 'synthesis',
    title,
    tags: ['gong', 'synthesis'],
    source: 'gong-wiki',
  };
  if (fm.last_updated) outFm.last_updated = fm.last_updated;
  if (fm.source_count) outFm.source_count = fm.source_count;

  const resolvedBody = resolveWikilinks(body, customerSlugMap);
  return buildYaml(outFm) + resolvedBody;
}

function buildSourcePage(
  callId: string,
  fm: Record<string, unknown>,
  body: string,
  customerSlugMap: Map<string, string>,
): string {
  const tags = Array.isArray(fm.tags) ? fm.tags as string[] : [];

  const outFm: Record<string, unknown> = {
    type: 'call',
    title: `Gong Call ${callId}`,
    tags: ['gong', 'call', ...tags],
    source: 'gong-wiki',
    call_id: callId,
  };
  if (fm.date) outFm.date = fm.date;
  if (fm.opportunity_stage) outFm.opportunity_stage = fm.opportunity_stage;
  if (fm.opportunity_type) outFm.opportunity_type = fm.opportunity_type;
  if (fm.outcome) outFm.outcome = fm.outcome;
  if (fm.confidence) outFm.confidence = fm.confidence;

  // Resolve customer wikilink to brain slug for frontmatter
  if (fm.customer) {
    const rawCustomer = String(fm.customer);
    // Could be "[[customers/roblox]]" or just "customers/roblox"
    const wikiTarget = rawCustomer.replace(/^\[\[/, '').replace(/\]\]$/, '').trim();
    const brainSlug = customerSlugMap.get(wikiTarget);
    if (brainSlug) {
      outFm.customer = brainSlug;
    } else if (wikiTarget.startsWith('customers/')) {
      outFm.customer = `companies/${wikiTarget.slice('customers/'.length)}`;
    }
    outFm.customer_wiki = wikiTarget;
  }

  const resolvedBody = resolveWikilinks(body, customerSlugMap);
  return buildYaml(outFm) + resolvedBody;
}

// ---------------------------------------------------------------------------
// Tag → theme matching
// ---------------------------------------------------------------------------

/** Strip prefixes like "pain-point/", "feature-request/", "product/" from a tag */
function stripTagPrefix(tag: string): string {
  const slashIdx = tag.indexOf('/');
  return slashIdx !== -1 ? tag.slice(slashIdx + 1) : tag;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL not set.');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const noEmbed = args.includes('--no-embed');
  const dryRun = args.includes('--dry-run');
  const wikiDir = args.find(a => !a.startsWith('--'));

  if (!wikiDir) {
    console.error('Usage: bun scripts/ingest-gong-wiki.ts <wiki-dir> [--no-embed] [--dry-run]');
    process.exit(1);
  }

  const sourcesDir = join(wikiDir, 'sources');
  const customersDir = join(wikiDir, 'customers');
  const themesDir = join(wikiDir, 'themes');
  const overviewFile = join(wikiDir, 'overview.md');
  const mlOppsFile = join(wikiDir, 'ml-opportunities.md');

  if (noEmbed) console.log('Skipping embeddings (--no-embed)');
  if (dryRun) console.log('Dry run — no writes will be made');

  // =========================================================================
  // PHASE 1: Scan & resolve customers
  // =========================================================================
  console.log('\n=== Phase 1: Scan & resolve customers ===');

  // Read wiki customer files
  const customerFiles = listMdFiles(customersDir);
  console.log(`  ${customerFiles.length} wiki customer files found`);

  interface WikiCustomer {
    wikiSlug: string;   // "customers/roblox"
    filename: string;   // "roblox"
    name: string;       // "Roblox"
    normalizedName: string;
    fm: Record<string, unknown>;
    body: string;
  }

  const wikiCustomers: WikiCustomer[] = [];
  for (const file of customerFiles) {
    const slug = basename(file, '.md');
    const { fm, body } = parseFrontmatter(readFile(file));
    const name = String(fm.customer_name ?? toTitleCase(slug));
    wikiCustomers.push({
      wikiSlug: `customers/${slug}`,
      filename: slug,
      name,
      normalizedName: normalizeCompanyName(name),
      fm,
      body,
    });
  }

  // Connect to brain and load account pages
  console.log('  Connecting to brain...');
  await db.connect({ engine: 'postgres', database_url: databaseUrl });
  const engine = new PostgresEngine();

  const customerSlugMap = new Map<string, string>(); // wikiSlug → brainSlug
  const unmatchedCustomers: WikiCustomer[] = [];
  const matchedCustomers: Array<{ wiki: WikiCustomer; brainSlug: string }> = [];

  if (!dryRun) {
    // Load all account pages for matching
    console.log('  Loading brain account pages...');
    const accountPages = await engine.listPages({ type: 'account', limit: 10000 });
    console.log(`  ${accountPages.length} account pages loaded`);

    // Build normalized name → brain slug index
    const brainNameIndex = new Map<string, string>(); // normalized → slug
    for (const page of accountPages) {
      const title = page.title || String(page.frontmatter?.account_name ?? page.frontmatter?.title ?? '');
      if (title) {
        const norm = normalizeCompanyName(title);
        if (norm && !brainNameIndex.has(norm)) {
          brainNameIndex.set(norm, page.slug);
        }
      }
    }
    console.log(`  ${brainNameIndex.size} normalized brain account names indexed`);

    // Match wiki customers to brain accounts
    for (const wc of wikiCustomers) {
      const brainSlug = brainNameIndex.get(wc.normalizedName);
      if (brainSlug) {
        customerSlugMap.set(wc.wikiSlug, brainSlug);
        matchedCustomers.push({ wiki: wc, brainSlug });
      } else {
        // Will be created as companies/{slug}
        const newSlug = `companies/${wc.filename}`;
        customerSlugMap.set(wc.wikiSlug, newSlug);
        unmatchedCustomers.push(wc);
      }
    }
  } else {
    // In dry-run, all customers are "unmatched" (we won't write)
    for (const wc of wikiCustomers) {
      customerSlugMap.set(wc.wikiSlug, `companies/${wc.filename}`);
      unmatchedCustomers.push(wc);
    }
  }

  // Print match report
  console.log('\n  === Customer Match Report ===');
  console.log(`  Matched to existing brain accounts: ${matchedCustomers.length}`);
  for (const { wiki, brainSlug } of matchedCustomers.slice(0, 10)) {
    console.log(`    ${wiki.name} → ${brainSlug}`);
  }
  if (matchedCustomers.length > 10) console.log(`    ... and ${matchedCustomers.length - 10} more`);
  console.log(`  Unmatched (will create as companies/): ${unmatchedCustomers.length}`);
  for (const wc of unmatchedCustomers.slice(0, 10)) {
    console.log(`    ${wc.name} → companies/${wc.filename}`);
  }
  if (unmatchedCustomers.length > 10) console.log(`    ... and ${unmatchedCustomers.length - 10} more`);

  // Scan source files for count
  const sourceFiles = listMdFiles(sourcesDir);
  const themeFiles = listMdFiles(themesDir);

  console.log(`\n  Estimated counts:`);
  console.log(`    Source calls:   ${sourceFiles.length}`);
  console.log(`    Theme pages:    ${themeFiles.length}`);
  console.log(`    Customers new:  ${unmatchedCustomers.length}`);
  console.log(`    Customers matched: ${matchedCustomers.length}`);

  if (dryRun) {
    console.log('\nDry run complete — no writes performed.');
    await engine.disconnect();
    return;
  }

  // =========================================================================
  // PHASE 2: Ingest customers + themes + synthesis
  // =========================================================================
  console.log('\n=== Phase 2: Ingest customers + themes + synthesis ===');

  let imported = 0, skipped = 0, errors = 0;

  // Ingest unmatched customers as companies/{slug}
  console.log(`  Ingesting ${unmatchedCustomers.length} unmatched customers...`);
  for (const wc of unmatchedCustomers) {
    const slug = `companies/${wc.filename}`;
    const content = buildCustomerPage(slug, wc.fm, wc.body, customerSlugMap);
    try {
      const result = await importFromContent(engine, slug, content, { noEmbed });
      if (result.status === 'imported') imported++;
      else if (result.status === 'skipped') skipped++;
      else { errors++; console.error(`  ✗ ${slug}: ${result.error}`); }
    } catch (err) {
      errors++;
      console.error(`  ✗ ${slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`  Customers: ${imported} imported, ${skipped} unchanged, ${errors} errors`);

  // Build tag index from themes: tag keyword → theme brain slug
  const themeTagIndex = new Map<string, string>(); // normalized tag → theme slug
  const themeSlugToTags = new Map<string, string[]>(); // theme slug → tags

  let tImported = 0, tSkipped = 0, tErrors = 0;
  console.log(`  Ingesting ${themeFiles.length} theme pages...`);
  for (const file of themeFiles) {
    const themeFilename = basename(file, '.md');
    const slug = `themes/gong/${themeFilename}`;
    const { fm, body } = parseFrontmatter(readFile(file));
    const content = buildThemePage(slug, fm, body, customerSlugMap);

    // Build tag index from this theme
    const tags = Array.isArray(fm.tags) ? fm.tags as string[] : [];
    themeSlugToTags.set(slug, tags);
    // Index the filename keywords too (the slug itself is a good key)
    themeTagIndex.set(themeFilename, slug);
    // Index each tag
    for (const tag of tags) {
      const norm = tag.toLowerCase().trim();
      if (!themeTagIndex.has(norm)) themeTagIndex.set(norm, slug);
    }

    try {
      const result = await importFromContent(engine, slug, content, { noEmbed });
      if (result.status === 'imported') tImported++;
      else if (result.status === 'skipped') tSkipped++;
      else { tErrors++; console.error(`  ✗ ${slug}: ${result.error}`); }
    } catch (err) {
      tErrors++;
      console.error(`  ✗ ${slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`  Themes: ${tImported} imported, ${tSkipped} unchanged, ${tErrors} errors`);

  // Ingest synthesis pages
  const synthPages = [
    { file: overviewFile, slug: 'wiki/gong/overview' },
    { file: mlOppsFile, slug: 'wiki/gong/ml-opportunities' },
  ];
  let sImported = 0, sSkipped = 0, sErrors = 0;
  console.log(`  Ingesting ${synthPages.length} synthesis pages...`);
  for (const { file, slug } of synthPages) {
    if (!existsSync(file)) { console.warn(`  ⚠ Missing: ${file}`); continue; }
    const { fm, body } = parseFrontmatter(readFile(file));
    const content = buildSynthesisPage(slug, fm, body, customerSlugMap);
    try {
      const result = await importFromContent(engine, slug, content, { noEmbed });
      if (result.status === 'imported') sImported++;
      else if (result.status === 'skipped') sSkipped++;
      else { sErrors++; console.error(`  ✗ ${slug}: ${result.error}`); }
    } catch (err) {
      sErrors++;
      console.error(`  ✗ ${slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`  Synthesis: ${sImported} imported, ${sSkipped} unchanged, ${sErrors} errors`);

  // =========================================================================
  // PHASE 3: Ingest source call summaries
  // =========================================================================
  console.log(`\n=== Phase 3: Ingest ${sourceFiles.length} source calls ===`);

  // Collect edge data as we ingest
  interface CallEdgeData {
    callSlug: string;
    customerBrainSlug: string | null;
    tags: string[];
  }
  const callEdgeData: CallEdgeData[] = [];

  let srcImported = 0, srcSkipped = 0, srcErrors = 0;
  let batchNum = 0;

  for (const file of sourceFiles) {
    const callId = basename(file, '.md');
    const slug = `calls/gong/${callId}`;
    const { fm, body } = parseFrontmatter(readFile(file));

    // Resolve customer
    let customerBrainSlug: string | null = null;
    if (fm.customer) {
      const rawCustomer = String(fm.customer);
      const wikiTarget = rawCustomer.replace(/^\[\[/, '').replace(/\]\]$/, '').trim();
      const resolved = customerSlugMap.get(wikiTarget);
      customerBrainSlug = resolved ?? null;
    }

    const tags = Array.isArray(fm.tags) ? fm.tags as string[] : [];
    callEdgeData.push({ callSlug: slug, customerBrainSlug, tags });

    const content = buildSourcePage(callId, fm, body, customerSlugMap);
    try {
      const result = await importFromContent(engine, slug, content, { noEmbed });
      if (result.status === 'imported') {
        srcImported++;
        batchNum++;
        if (batchNum % 500 === 0) console.log(`  ... ${batchNum} calls processed`);
      } else if (result.status === 'skipped') {
        srcSkipped++;
        batchNum++;
        if (batchNum % 500 === 0) console.log(`  ... ${batchNum} calls processed`);
      } else {
        srcErrors++;
        console.error(`  ✗ ${slug}: ${result.error}`);
      }
    } catch (err) {
      srcErrors++;
      console.error(`  ✗ ${slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`  Calls: ${srcImported} imported, ${srcSkipped} unchanged, ${srcErrors} errors`);

  // =========================================================================
  // PHASE 4: Batch edge creation
  // =========================================================================
  console.log('\n=== Phase 4: Creating graph edges ===');

  const BATCH_SIZE = 5000;
  let edgeBatch: LinkBatchInput[] = [];
  let totalEdges = 0;
  let hadCallCount = 0;
  let belongsToThemeCount = 0;
  let unmatchedTags = new Map<string, number>(); // tag → count of unmatched
  let unmatchedCustomerCalls = 0;

  async function flushBatch() {
    if (edgeBatch.length === 0) return;
    const created = await engine.addLinksBatch(edgeBatch);
    totalEdges += created;
    edgeBatch = [];
  }

  for (const { callSlug, customerBrainSlug, tags } of callEdgeData) {
    // had_call edges: customer → call
    if (customerBrainSlug) {
      edgeBatch.push({
        from_slug: customerBrainSlug,
        to_slug: callSlug,
        link_type: 'had_call',
        context: `frontmatter.customer`,
        link_source: 'frontmatter',
        origin_slug: callSlug,
        origin_field: 'customer',
      });
      hadCallCount++;
      if (edgeBatch.length >= BATCH_SIZE) await flushBatch();
    } else {
      unmatchedCustomerCalls++;
    }

    // belongs_to_theme edges: call → theme
    const matchedThemes = new Set<string>();
    for (const rawTag of tags) {
      const stripped = stripTagPrefix(rawTag).toLowerCase().trim();

      // Try exact match on stripped tag
      let themeSlug = themeTagIndex.get(stripped);

      // If not found, try keyword scan: check if the stripped tag contains a theme keyword
      if (!themeSlug) {
        for (const [keyword, ts] of themeTagIndex.entries()) {
          if (stripped.includes(keyword) || keyword.includes(stripped)) {
            themeSlug = ts;
            break;
          }
        }
      }

      if (themeSlug && !matchedThemes.has(themeSlug)) {
        matchedThemes.add(themeSlug);
        edgeBatch.push({
          from_slug: callSlug,
          to_slug: themeSlug,
          link_type: 'belongs_to_theme',
          context: `tag: ${rawTag}`,
          link_source: 'frontmatter',
          origin_slug: callSlug,
          origin_field: 'tags',
        });
        belongsToThemeCount++;
        if (edgeBatch.length >= BATCH_SIZE) await flushBatch();
      } else if (!themeSlug) {
        unmatchedTags.set(stripped, (unmatchedTags.get(stripped) ?? 0) + 1);
      }
    }
  }
  await flushBatch();

  console.log(`  had_call edges: ${hadCallCount}`);
  console.log(`  belongs_to_theme edges: ${belongsToThemeCount}`);
  console.log(`  Total edges created: ${totalEdges}`);
  console.log(`  Calls with no resolved customer: ${unmatchedCustomerCalls}`);

  if (unmatchedTags.size > 0) {
    const topUnmatched = [...unmatchedTags.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);
    console.log(`\n  Unmatched tag types (top 20):`);
    for (const [tag, count] of topUnmatched) {
      console.log(`    ${tag}: ${count}`);
    }
  }

  console.log(`\nDone.`);
  console.log(`  Phase 2: ${imported + tImported + sImported} imported, ${skipped + tSkipped + sSkipped} unchanged`);
  console.log(`  Phase 3: ${srcImported} imported, ${srcSkipped} unchanged, ${srcErrors} errors`);
  console.log(`  Phase 4: ${totalEdges} edges created`);

  await engine.disconnect();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
