#!/usr/bin/env bun
/**
 * Ingest JIRA tickets from OCP projects into gbrain.
 *
 * Usage:
 *   DATABASE_URL="postgresql://wcheung@localhost/gbrain" bun scripts/ingest-jira-tickets.ts <tickets.json>
 *
 * What it does:
 *   1. Reads a JSON file of JIRA issues (fetched separately via Atlassian MCP or REST API)
 *   2. Creates a brain page per ticket at tickets/jira/{key-lowercase}
 *   3. Creates a brain page per epic at epics/jira/{key-lowercase}
 *   4. Extracts assignees, reporters, customers, linked issues into frontmatter
 *
 * Re-running is safe — importFromContent uses content hashing and skips unchanged pages.
 */

import { importFromContent } from '../src/core/import-file.ts';
import * as db from '../src/core/db.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

// --- Types ---
interface JiraIssue {
  key: string;
  summary: string;
  description?: string;
  status: string;
  priority?: string;
  issueType: string;
  assignee?: string;
  reporter?: string;
  project: string;
  projectName?: string;
  parentKey?: string;
  parentSummary?: string;
  storyPoints?: number;
  sprint?: string;
  typeOfWork?: string;
  labels?: string[];
  components?: string[];
  created?: string;
  updated?: string;
  dueDate?: string;
  linkedIssues?: string[];
  webUrl?: string;
  // For Customer Investigation issues
  customerName?: string;
}

// --- Helpers ---

/** Determine if an issue is an Epic */
function isEpic(issue: JiraIssue): boolean {
  return issue.issueType === 'Epic';
}

/** Build slug for a JIRA issue */
function buildSlug(issue: JiraIssue): string {
  const key = issue.key.toLowerCase();
  if (isEpic(issue)) return `epics/jira/${key}`;
  return `tickets/jira/${key}`;
}

/** Determine brain page type */
function pageType(issue: JiraIssue): string {
  if (isEpic(issue)) return 'feature'; // epics map to feature pages
  return 'ticket';
}

/** Build tags for the issue */
function buildTags(issue: JiraIssue): string[] {
  const tags: string[] = ['jira', issue.project.toLowerCase()];

  if (isEpic(issue)) tags.push('epic');
  if (issue.issueType === 'Bug') tags.push('bug');
  if (issue.issueType === 'Customer Investigation') tags.push('customer-investigation');
  if (issue.issueType === 'Security Finding') tags.push('security');
  if (issue.issueType === 'Spike') tags.push('spike');

  if (issue.priority === 'P0' || issue.priority === 'P1') tags.push('high-priority');
  if (issue.status === 'Blocked') tags.push('blocked');

  if (issue.typeOfWork) {
    if (issue.typeOfWork.includes('Unplanned')) tags.push('unplanned');
    if (issue.typeOfWork.includes('Customer Request')) tags.push('customer-request');
  }

  if (issue.labels) tags.push(...issue.labels.map(l => l.toLowerCase()));

  return [...new Set(tags)];
}

/** Build brain page markdown from a JIRA issue */
function buildBrainPage(issue: JiraIssue): { slug: string; content: string } {
  const slug = buildSlug(issue);
  const tags = buildTags(issue);

  const frontmatterFields: Record<string, unknown> = {
    type: pageType(issue),
    title: `[${issue.key}] ${issue.summary}`,
    tags,
    source: 'jira',
    jira_key: issue.key,
    jira_url: issue.webUrl || '',
    project: issue.project,
    project_name: issue.projectName || issue.project,
    issue_type: issue.issueType,
    status: issue.status,
    priority: issue.priority || 'unset',
  };

  if (issue.assignee) frontmatterFields.assignee = issue.assignee;
  if (issue.reporter) frontmatterFields.reporter = issue.reporter;
  if (issue.parentKey) frontmatterFields.parent_epic = issue.parentKey;
  if (issue.storyPoints) frontmatterFields.story_points = issue.storyPoints;
  if (issue.sprint) frontmatterFields.sprint = issue.sprint;
  if (issue.typeOfWork) frontmatterFields.type_of_work = issue.typeOfWork;
  if (issue.components?.length) frontmatterFields.components = issue.components;
  if (issue.dueDate) frontmatterFields.due_date = issue.dueDate;
  if (issue.created) frontmatterFields.created = issue.created;
  if (issue.updated) frontmatterFields.updated = issue.updated;
  if (issue.linkedIssues?.length) frontmatterFields.linked_issues = issue.linkedIssues;
  if (issue.customerName) frontmatterFields.customer = issue.customerName;

  // Build YAML
  let yaml = '---\n';
  for (const [key, value] of Object.entries(frontmatterFields)) {
    if (Array.isArray(value)) {
      yaml += `${key}:\n`;
      for (const item of value) {
        yaml += `  - ${JSON.stringify(String(item))}\n`;
      }
    } else if (typeof value === 'number') {
      yaml += `${key}: ${value}\n`;
    } else {
      yaml += `${key}: ${JSON.stringify(value)}\n`;
    }
  }
  yaml += '---\n\n';

  // Build body
  let body = `# ${issue.summary}\n\n`;
  body += `**Project:** ${issue.projectName || issue.project}\n`;
  body += `**Status:** ${issue.status}\n`;
  body += `**Priority:** ${issue.priority || 'unset'}\n`;
  body += `**Type:** ${issue.issueType}\n`;
  if (issue.assignee) body += `**Assignee:** ${issue.assignee}\n`;
  if (issue.reporter) body += `**Reporter:** ${issue.reporter}\n`;
  if (issue.parentKey) body += `**Epic:** ${issue.parentKey} — ${issue.parentSummary || ''}\n`;
  if (issue.sprint) body += `**Sprint:** ${issue.sprint}\n`;
  if (issue.storyPoints) body += `**Story Points:** ${issue.storyPoints}\n`;
  if (issue.typeOfWork) body += `**Type of Work:** ${issue.typeOfWork}\n`;
  if (issue.dueDate) body += `**Due:** ${issue.dueDate}\n`;
  body += '\n';

  if (issue.description) {
    body += `## Description\n\n${issue.description}\n\n`;
  }

  if (issue.linkedIssues?.length) {
    body += `## Linked Issues\n\n`;
    for (const linked of issue.linkedIssues) {
      body += `- ${linked}\n`;
    }
    body += '\n';
  }

  // Timeline
  const timelineEntries: string[] = [];
  if (issue.created) timelineEntries.push(`- **${issue.created}** | Created`);
  if (issue.updated && issue.updated !== issue.created) {
    timelineEntries.push(`- **${issue.updated}** | Last updated — status: ${issue.status}`);
  }

  if (timelineEntries.length > 0) {
    body += `<!-- timeline -->\n\n${timelineEntries.join('\n')}\n`;
  }

  return { slug, content: yaml + body };
}

// --- Main ---

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL not set. Run with:');
    console.error('  DATABASE_URL="postgresql://wcheung@localhost/gbrain" bun scripts/ingest-jira-tickets.ts <tickets.json>');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const noEmbed = args.includes('--no-embed');
  const inputFile = args.find(a => !a.startsWith('--'));
  if (!inputFile) {
    console.error('Usage: bun scripts/ingest-jira-tickets.ts <tickets.json> [--no-embed]');
    console.error('');
    console.error('tickets.json should contain an array of JiraIssue objects.');
    process.exit(1);
  }
  if (noEmbed) console.log('Skipping embeddings (--no-embed)');

  console.log('Connecting to brain...');
  await db.connect({ engine: 'postgres', database_url: databaseUrl });
  const engine = new PostgresEngine();

  const { readFileSync } = await import('fs');
  const issues: JiraIssue[] = JSON.parse(readFileSync(inputFile, 'utf-8'));

  console.log(`Found ${issues.length} JIRA issues to ingest`);

  const epics = issues.filter(isEpic);
  const tickets = issues.filter(i => !isEpic(i));
  console.log(`  ${epics.length} epics, ${tickets.length} tickets`);

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  // Ingest epics first (so ticket → epic links resolve)
  for (const issue of [...epics, ...tickets]) {
    const { slug, content } = buildBrainPage(issue);

    try {
      const result = await importFromContent(engine, slug, content, { noEmbed });
      if (result.status === 'imported') {
        imported++;
        console.log(`  ✓ ${slug} (${result.chunks} chunks)`);
      } else if (result.status === 'skipped') {
        skipped++;
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
