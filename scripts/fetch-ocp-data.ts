#!/usr/bin/env bun
/**
 * Fetch OCP data from Confluence and JIRA via Atlassian REST API.
 *
 * Usage:
 *   bun scripts/fetch-ocp-data.ts --confluence    # Fetch status reports only
 *   bun scripts/fetch-ocp-data.ts --jira          # Fetch JIRA tickets only
 *   bun scripts/fetch-ocp-data.ts --all           # Fetch both
 *   bun scripts/fetch-ocp-data.ts --jira --since 7d  # Last 7 days only
 *
 * Requires ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN environment variables.
 * Generate a token at: https://id.atlassian.com/manage-profile/security/api-tokens
 *
 * Output:
 *   data/confluence-status-reports.json
 *   data/jira-tickets.json
 *
 * Then ingest with:
 *   DATABASE_URL="..." bun scripts/ingest-confluence-status.ts data/confluence-status-reports.json
 *   DATABASE_URL="..." bun scripts/ingest-jira-tickets.ts data/jira-tickets.json
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

// --- Config ---
const SITE = 'pagerduty.atlassian.net';
const BASE_URL = `https://${SITE}/wiki/api/v2`;
const JIRA_BASE = `https://${SITE}/rest/api/3`;
const ANCESTOR_ID = '5087494160'; // Team Status Reports folder
const SPACE_KEY = 'OCP';

const OCP_PROJECTS = [
  'NEXT', 'MOCO', 'ING', 'AAX', 'DEVECO', 'MNE',
  'AUTH', 'INTGR', 'CSOT', 'GBFM', 'FEP', 'PD', 'FEAST',
];

const DATA_DIR = join(import.meta.dir, '..', 'data');

// --- Auth ---
function getAuth(): string {
  const email = process.env.ATLASSIAN_EMAIL;
  const token = process.env.ATLASSIAN_API_TOKEN;
  if (!email || !token) {
    console.error('ERROR: Set ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN environment variables.');
    console.error('Generate a token at: https://id.atlassian.com/manage-profile/security/api-tokens');
    process.exit(1);
  }
  return Buffer.from(`${email}:${token}`).toString('base64');
}

async function atlassianFetch(url: string, auth: string): Promise<unknown> {
  const resp = await fetch(url, {
    headers: {
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/json',
    },
  });
  if (!resp.ok) {
    throw new Error(`${resp.status} ${resp.statusText}: ${await resp.text()}`);
  }
  return resp.json();
}

// --- Confluence ---

interface ConfluenceSearchResult {
  results: Array<{
    content: { id: string; title: string; type: string };
    lastModified: string;
    excerpt?: string;
    resultGlobalContainer?: { title: string };
  }>;
  _links?: { next?: string };
  size: number;
  totalSize: number;
}

interface ConfluencePageResponse {
  id: string;
  title: string;
  body?: { view?: { value: string }; storage?: { value: string }; atlas_doc_format?: { value: string } };
  version?: { by?: { displayName: string }; when: string };
  _links?: { webui?: string };
}

async function fetchConfluenceStatusReports(auth: string): Promise<void> {
  console.log('Fetching Confluence status reports...');

  // Search for all pages under the Team Status Reports folder
  const cql = encodeURIComponent(`ancestor = ${ANCESTOR_ID} AND space = "${SPACE_KEY}" AND type = page ORDER BY lastModified DESC`);
  let allPages: Array<{ id: string; title: string }> = [];
  let start = 0;
  const limit = 50;

  while (true) {
    const url = `https://${SITE}/wiki/rest/api/content/search?cql=${cql}&start=${start}&limit=${limit}`;
    const data = await atlassianFetch(url, auth) as ConfluenceSearchResult;
    for (const r of data.results) {
      allPages.push({ id: r.content.id, title: r.content.title });
    }
    console.log(`  Found ${allPages.length}/${data.totalSize} pages...`);
    if (allPages.length >= data.totalSize || data.results.length < limit) break;
    start += limit;
  }

  console.log(`Fetching full content for ${allPages.length} pages...`);
  const output: Array<Record<string, unknown>> = [];

  for (const page of allPages) {
    try {
      // Fetch page with body in storage format, then convert
      const url = `https://${SITE}/wiki/rest/api/content/${page.id}?expand=body.storage,version,metadata.labels`;
      const data = await atlassianFetch(url, auth) as ConfluencePageResponse;

      // Convert HTML to plain text (basic)
      const html = data.body?.storage?.value || '';
      const body = htmlToMarkdown(html);

      output.push({
        id: page.id,
        title: page.title,
        body,
        author: data.version?.by?.displayName || 'unknown',
        lastModified: data.version?.when || '',
        webUrl: `https://${SITE}/wiki${data._links?.webui || ''}`,
      });

      console.log(`  ✓ ${page.title}`);
    } catch (err) {
      console.error(`  ✗ ${page.title}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  mkdirSync(DATA_DIR, { recursive: true });
  const outPath = join(DATA_DIR, 'confluence-status-reports.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${output.length} reports to ${outPath}`);
}

/** Basic HTML → markdown conversion for Confluence content */
function htmlToMarkdown(html: string): string {
  let md = html;
  // Headers
  md = md.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n');
  md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n');
  md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n');
  md = md.replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n\n');
  // Bold / italic
  md = md.replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**');
  md = md.replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*');
  // Links - preserve JIRA links
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)');
  // Lists
  md = md.replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n');
  md = md.replace(/<\/?[ou]l[^>]*>/gi, '\n');
  // Paragraphs and breaks
  md = md.replace(/<br\s*\/?>/gi, '\n');
  md = md.replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n');
  // Tables (basic)
  md = md.replace(/<\/?table[^>]*>/gi, '\n');
  md = md.replace(/<\/?thead[^>]*>/gi, '');
  md = md.replace(/<\/?tbody[^>]*>/gi, '');
  md = md.replace(/<tr[^>]*>(.*?)<\/tr>/gi, '| $1\n');
  md = md.replace(/<t[hd][^>]*>(.*?)<\/t[hd]>/gi, '$1 | ');
  // Status macros (Confluence-specific)
  md = md.replace(/<ac:structured-macro[^>]*ac:name="status"[^>]*>.*?<ac:parameter ac:name="title">(.*?)<\/ac:parameter>.*?<\/ac:structured-macro>/gi, '[$1]');
  // Emoticons
  md = md.replace(/<ac:emoticon[^>]*ac:name="([^"]*)"[^>]*\/>/gi, ':$1:');
  // Strip remaining tags
  md = md.replace(/<[^>]+>/g, '');
  // Decode entities
  md = md.replace(/&amp;/g, '&');
  md = md.replace(/&lt;/g, '<');
  md = md.replace(/&gt;/g, '>');
  md = md.replace(/&quot;/g, '"');
  md = md.replace(/&#39;/g, "'");
  md = md.replace(/&nbsp;/g, ' ');
  // Clean up whitespace
  md = md.replace(/\n{3,}/g, '\n\n');
  return md.trim();
}

// --- JIRA ---

interface JiraSearchResponse {
  issues: Array<{
    key: string;
    fields: Record<string, unknown>;
  }>;
  total: number;
  maxResults: number;
  startAt: number;
}

async function fetchJiraTickets(auth: string, sinceDays: number = 90): Promise<void> {
  console.log(`Fetching JIRA tickets (last ${sinceDays} days)...`);

  const projectList = OCP_PROJECTS.join(', ');
  const jql = `project in (${projectList}) AND updated >= -${sinceDays}d ORDER BY updated DESC`;
  let allIssues: Array<Record<string, unknown>> = [];
  let startAt = 0;
  const maxResults = 100;

  while (true) {
    const url = `${JIRA_BASE}/search?jql=${encodeURIComponent(jql)}&startAt=${startAt}&maxResults=${maxResults}&fields=summary,status,priority,issuetype,assignee,reporter,parent,customfield_10004,customfield_10007,customfield_16588,labels,components,created,updated,duedate,issuelinks,description,project`;
    const data = await atlassianFetch(url, auth) as JiraSearchResponse;

    for (const issue of data.issues) {
      const f = issue.fields;
      const mapped: Record<string, unknown> = {
        key: issue.key,
        summary: (f.summary as string) || '',
        description: truncateDescription(f.description),
        status: (f.status as Record<string, unknown>)?.name || 'unknown',
        priority: (f.priority as Record<string, unknown>)?.name || 'unset',
        issueType: (f.issuetype as Record<string, unknown>)?.name || 'unknown',
        assignee: (f.assignee as Record<string, unknown>)?.displayName || null,
        reporter: (f.reporter as Record<string, unknown>)?.displayName || null,
        project: (f.project as Record<string, unknown>)?.key || '',
        projectName: (f.project as Record<string, unknown>)?.name || '',
        storyPoints: f.customfield_10004 as number | null,
        typeOfWork: (f.customfield_16588 as Record<string, unknown>)?.value || null,
        labels: f.labels || [],
        components: ((f.components as Array<Record<string, unknown>>) || []).map(c => c.name as string),
        created: formatDate(f.created as string),
        updated: formatDate(f.updated as string),
        dueDate: f.duedate || null,
        webUrl: `https://${SITE}/browse/${issue.key}`,
      };

      // Parent epic
      const parent = f.parent as Record<string, unknown> | null;
      if (parent) {
        mapped.parentKey = parent.key;
        mapped.parentSummary = (parent.fields as Record<string, unknown>)?.summary || '';
      }

      // Sprint (take the most recent active sprint)
      const sprints = f.customfield_10007 as Array<Record<string, unknown>> | null;
      if (sprints?.length) {
        const active = sprints.find(s => s.state === 'active') || sprints[sprints.length - 1];
        mapped.sprint = active.name || null;
      }

      // Linked issues
      const links = f.issuelinks as Array<Record<string, unknown>> | null;
      if (links?.length) {
        mapped.linkedIssues = links.map(l => {
          const inward = l.inwardIssue as Record<string, unknown> | undefined;
          const outward = l.outwardIssue as Record<string, unknown> | undefined;
          const target = inward || outward;
          return target ? `${(l.type as Record<string, unknown>)?.name || 'relates'}: ${target.key}` : null;
        }).filter(Boolean);
      }

      // Customer name (for Customer Investigation type)
      if (mapped.issueType === 'Customer Investigation') {
        const summary = mapped.summary as string;
        // Common patterns: [Premium] Customer Name - Issue or **Customer:** name
        const custMatch = summary.match(/\[(?:Premium|Standard)\]\s*[-–—]?\s*(.+?)(?:\s*[-–—]|$)/i);
        if (custMatch) mapped.customerName = custMatch[1].trim();
      }

      allIssues.push(mapped);
    }

    console.log(`  Fetched ${allIssues.length}/${data.total} issues...`);
    if (startAt + data.issues.length >= data.total || data.issues.length < maxResults) break;
    startAt += maxResults;
  }

  mkdirSync(DATA_DIR, { recursive: true });
  const outPath = join(DATA_DIR, 'jira-tickets.json');
  writeFileSync(outPath, JSON.stringify(allIssues, null, 2));
  console.log(`\nWrote ${allIssues.length} issues to ${outPath}`);
}

/** Truncate JIRA description (ADF JSON) to reasonable markdown */
function truncateDescription(desc: unknown): string {
  if (!desc) return '';
  if (typeof desc === 'string') return desc.slice(0, 5000);

  // ADF (Atlassian Document Format) — extract text nodes
  try {
    const texts: string[] = [];
    function walk(node: Record<string, unknown>) {
      if (node.type === 'text' && typeof node.text === 'string') {
        texts.push(node.text);
      }
      if (Array.isArray(node.content)) {
        for (const child of node.content) walk(child as Record<string, unknown>);
      }
    }
    walk(desc as Record<string, unknown>);
    return texts.join(' ').slice(0, 5000);
  } catch {
    return JSON.stringify(desc).slice(0, 2000);
  }
}

/** Format ISO date to YYYY-MM-DD */
function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  return iso.slice(0, 10);
}

// --- CLI ---

async function main() {
  const args = process.argv.slice(2);
  const doConfluence = args.includes('--confluence') || args.includes('--all');
  const doJira = args.includes('--jira') || args.includes('--all');

  if (!doConfluence && !doJira) {
    console.log('Usage:');
    console.log('  bun scripts/fetch-ocp-data.ts --confluence    # Fetch Confluence status reports');
    console.log('  bun scripts/fetch-ocp-data.ts --jira          # Fetch JIRA tickets');
    console.log('  bun scripts/fetch-ocp-data.ts --all           # Fetch both');
    console.log('  bun scripts/fetch-ocp-data.ts --jira --since 7d');
    console.log('');
    console.log('Requires: ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN env vars');
    process.exit(0);
  }

  const auth = getAuth();

  // Parse --since flag
  let sinceDays = 90;
  const sinceIdx = args.indexOf('--since');
  if (sinceIdx !== -1 && args[sinceIdx + 1]) {
    const val = args[sinceIdx + 1];
    const match = val.match(/^(\d+)d?$/);
    if (match) sinceDays = parseInt(match[1]);
  }

  if (doConfluence) await fetchConfluenceStatusReports(auth);
  if (doJira) await fetchJiraTickets(auth, sinceDays);

  console.log('\nDone! Next steps:');
  if (doConfluence) {
    console.log('  DATABASE_URL="postgresql://wcheung@localhost/gbrain" bun scripts/ingest-confluence-status.ts data/confluence-status-reports.json');
  }
  if (doJira) {
    console.log('  DATABASE_URL="postgresql://wcheung@localhost/gbrain" bun scripts/ingest-jira-tickets.ts data/jira-tickets.json');
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
