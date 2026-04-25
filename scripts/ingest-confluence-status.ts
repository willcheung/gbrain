#!/usr/bin/env bun
/**
 * Ingest OCP Team Status Reports from Confluence into gbrain.
 *
 * Usage:
 *   DATABASE_URL="postgresql://wcheung@localhost/gbrain" bun scripts/ingest-confluence-status.ts
 *
 * What it does:
 *   1. Searches Confluence OCP space for all status report pages (ancestor = 5087494160)
 *   2. Fetches each page's full markdown content
 *   3. Parses team name, date, author from the title and metadata
 *   4. Creates a brain page per report at status/ocp/{team}-{date}
 *   5. Extracts JIRA ticket references, people, customers into frontmatter
 *
 * Re-running is safe — importFromContent uses content hashing and skips unchanged pages.
 */

import { importFromContent } from '../src/core/import-file.ts';
import * as db from '../src/core/db.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

// --- Config ---
const CLOUD_ID = 'pagerduty.atlassian.net';
const ANCESTOR_ID = '5087494160'; // Team Status Reports folder
const SPACE_KEY = 'OCP';
const CQL = `ancestor = ${ANCESTOR_ID} AND space = "${SPACE_KEY}" AND type = page ORDER BY lastModified DESC`;

// --- Types ---
interface ConfluencePage {
  id: string;
  title: string;
  author?: { displayName?: string };
  lastModified?: string;
  webUrl?: string;
}

interface SearchResult {
  content: {
    totalCount: number;
    nodes: ConfluencePage[];
  };
}

// --- Atlassian MCP client ---
// When run standalone (not inside Claude Code), we call the Atlassian REST API directly.
// For now, this script generates markdown files that can be imported via `gbrain import`.
// The actual MCP calls happen in the companion script or via Claude Code session.

// --- Parsing helpers ---

/** Extract team name from page title. Handles both formats:
 *  - "NEXT-FY27Q1-04242026"     → next
 *  - "Mobile-Q1FY27-042426"     → mobile
 *  - "ING-Q1FY27-042426"        → ing
 */
function parseTeamFromTitle(title: string): string {
  // Match the team prefix before the first dash followed by Q or FY
  const match = title.match(/^(.+?)[-_](?:Q\d|FY\d)/i);
  if (match) return match[1].toLowerCase().replace(/\s+/g, '-');
  // Fallback: first word
  return title.split(/[-_\s]/)[0].toLowerCase();
}

/** Extract date from page title.
 *  - "NEXT-FY27Q1-04242026"  → 2026-04-24
 *  - "Mobile-Q1FY27-042426"  → 2026-04-24
 */
function parseDateFromTitle(title: string): string {
  // Try MMDDYYYY format (8 digits)
  const long = title.match(/(\d{2})(\d{2})(\d{4})$/);
  if (long) return `${long[3]}-${long[1]}-${long[2]}`;

  // Try MMDDYY format (6 digits)
  const short = title.match(/(\d{2})(\d{2})(\d{2})$/);
  if (short) {
    const year = parseInt(short[3]) > 50 ? `19${short[3]}` : `20${short[3]}`;
    return `${year}-${short[1]}-${short[2]}`;
  }

  return 'unknown';
}

/** Team name normalization */
const TEAM_NAMES: Record<string, string> = {
  'next': 'NEXT (Notifications Experience)',
  'mobile': 'Mobile',
  'ing': 'Ingestion',
  'aax': 'AAX (Account Admin Experience)',
  'deveco': 'DevEco (Developer Ecosystem)',
  'mne': 'MnE (Monetization & Entitlements)',
  'appex': 'AppEx (App Experience)',
  'authnz': 'AuthNZ (Authentication & Authorization)',
  'integrations': 'Integrations',
  'dev-eco': 'DevEco (Developer Ecosystem)',
  'web-evolution': 'Web Evolution',
};

/** Extract JIRA ticket references from content */
function extractJiraRefs(content: string): string[] {
  const pattern = /\b([A-Z][A-Z0-9]+-\d+)\b/g;
  const refs = new Set<string>();
  let match;
  while ((match = pattern.exec(content)) !== null) {
    refs.add(match[1]);
  }
  return [...refs].sort();
}

/** Extract customer names from "Customer/production issues" section */
function extractCustomers(content: string): string[] {
  const customers = new Set<string>();

  // Pattern: **Customer:** name |
  const customerPattern = /\*\*Customer:\*\*\s*(.+?)\s*\|/gi;
  let match;
  while ((match = customerPattern.exec(content)) !== null) {
    customers.add(match[1].trim());
  }

  return [...customers].sort();
}

/** Extract people names from assignee patterns */
function extractPeople(content: string): string[] {
  const people = new Set<string>();

  // Pattern: _(Status — Person Name)_ or _(Person Name)_
  const assigneePattern = /[—–-]\s*([A-Z][a-z]+ [A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s*\)/g;
  let match;
  while ((match = assigneePattern.exec(content)) !== null) {
    people.add(match[1].trim());
  }

  return [...people].sort();
}

/** Build brain page markdown from a Confluence status report */
function buildBrainPage(page: ConfluencePage, body: string): { slug: string; content: string } {
  const team = parseTeamFromTitle(page.title);
  const date = parseDateFromTitle(page.title);
  const teamFullName = TEAM_NAMES[team] || team;
  const jiraRefs = extractJiraRefs(body);
  const customers = extractCustomers(body);
  const people = extractPeople(body);

  const slug = `status/ocp/${team}-${date}`;

  const frontmatterFields: Record<string, unknown> = {
    type: 'status',
    title: `${teamFullName} Status Report — ${date}`,
    tags: ['status-report', 'ocp', team],
    source: 'confluence',
    confluence_id: page.id,
    confluence_url: page.webUrl || '',
    team: teamFullName,
    team_key: team,
    date,
    author: page.author?.displayName || 'unknown',
  };

  if (jiraRefs.length > 0) frontmatterFields.jira_refs = jiraRefs;
  if (customers.length > 0) frontmatterFields.customers = customers;
  if (people.length > 0) frontmatterFields.people_mentioned = people;

  // Build YAML manually to control formatting
  let yaml = '---\n';
  for (const [key, value] of Object.entries(frontmatterFields)) {
    if (Array.isArray(value)) {
      yaml += `${key}:\n`;
      for (const item of value) {
        yaml += `  - "${item}"\n`;
      }
    } else {
      yaml += `${key}: ${JSON.stringify(value)}\n`;
    }
  }
  yaml += '---\n\n';

  const content = yaml + body;
  return { slug, content };
}

// --- Main ---

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL not set. Run with:');
    console.error('  DATABASE_URL="postgresql://wcheung@localhost/gbrain" bun scripts/ingest-confluence-status.ts');
    process.exit(1);
  }

  console.log('Connecting to brain...');
  await db.connect({ engine: 'postgres', database_url: databaseUrl });
  const engine = new PostgresEngine();

  // Read page list from stdin (JSON array of {id, title, author, webUrl})
  // This is piped from the fetch step which runs inside Claude Code with MCP access.
  const args = process.argv.slice(2);
  const noEmbed = args.includes('--no-embed');
  const inputFile = args.find(a => !a.startsWith('--'));
  if (!inputFile) {
    console.error('Usage: bun scripts/ingest-confluence-status.ts <pages.json> [--no-embed]');
    console.error('');
    console.error('pages.json should contain an array of objects with:');
    console.error('  { id, title, body, author, webUrl }');
    process.exit(1);
  }
  if (noEmbed) console.log('Skipping embeddings (--no-embed)');

  const { readFileSync } = await import('fs');
  const pages: Array<ConfluencePage & { body: string }> = JSON.parse(readFileSync(inputFile, 'utf-8'));

  console.log(`Found ${pages.length} status reports to ingest`);

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const page of pages) {
    const { slug, content } = buildBrainPage(page, page.body);

    try {
      const result = await importFromContent(engine, slug, content, { noEmbed });
      if (result.status === 'imported') {
        imported++;
        console.log(`  ✓ ${slug} (${result.chunks} chunks)`);
      } else if (result.status === 'skipped') {
        skipped++;
        console.log(`  · ${slug} (unchanged)`);
      } else {
        errors++;
        console.error(`  ✗ ${slug}: ${result.error}`);
      }
    } catch (err) {
      errors++;
      console.error(`  ✗ ${slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\nDone: ${imported} imported, ${skipped} unchanged, ${errors} errors`);
  await engine.disconnect();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
