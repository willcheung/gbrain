#!/usr/bin/env bun
/**
 * Weekly OCP Rollup — generates a leadership-focused summary.
 *
 * Usage:
 *   DATABASE_URL="postgresql://wcheung@localhost/gbrain" bun scripts/weekly-rollup.ts
 *   DATABASE_URL="..." bun scripts/weekly-rollup.ts --slack   # Also post to Slack
 *   DATABASE_URL="..." bun scripts/weekly-rollup.ts --json    # Output raw JSON
 *
 * Requires SLACK_WEBHOOK_URL env var for --slack mode.
 *
 * What it produces:
 *   1. 🔴 NEEDS ATTENTION — blocked items, slipping deadlines, delivery risks
 *   2. 🟡 WATCH LIST — things trending the wrong direction
 *   3. 🟢 WINS — what shipped, what unblocked
 *   4. Team-by-team one-liners
 */

import * as db from '../src/core/db.ts';
import type { Row } from 'postgres';

// --- Config ---
const TEAM_ORDER = ['next', 'mobile', 'ing', 'aax', 'deveco', 'mne', 'appex', 'authnz', 'integrations'];

const TEAM_DISPLAY: Record<string, string> = {
  'next': 'NEXT',
  'mobile': 'Mobile',
  'ing': 'Ingestion',
  'aax': 'AAX',
  'deveco': 'DevEco',
  'mne': 'MnE',
  'appex': 'AppEx',
  'authnz': 'AuthNZ',
  'integrations': 'Integrations',
};

/** Map JIRA project keys to team keys */
const PROJECT_TO_TEAM: Record<string, string> = {
  'NEXT': 'next',
  'MOCO': 'mobile',
  'ING': 'ing',
  'AAX': 'aax',
  'DEVECO': 'deveco',
  'MNE': 'mne',
  'GBFM': 'appex', 'FEP': 'appex', 'PD': 'appex', 'FEAST': 'appex',
  'AUTH': 'authnz',
  'INTGR': 'integrations', 'CSOT': 'integrations',
};

interface StatusReport {
  slug: string;
  title: string;
  body: string;
  team: string;
  teamKey: string;
  date: string;
  frontmatter: Record<string, unknown>;
}

interface JiraTicket {
  slug: string;
  title: string;
  body: string;
  frontmatter: Record<string, unknown>;
}

interface RollupSection {
  emoji: string;
  heading: string;
  items: string[];
}

// --- Data fetching ---

async function getLatestStatusReports(sql: ReturnType<typeof db.getConnection>): Promise<Map<string, StatusReport>> {
  const rows = await sql`
    SELECT slug, title, compiled_truth, frontmatter
    FROM pages
    WHERE type = 'status'
      AND slug LIKE 'status/ocp/%'
    ORDER BY slug DESC
  `;

  const byTeam = new Map<string, StatusReport>();
  for (const r of rows) {
    const fm = typeof r.frontmatter === 'string' ? JSON.parse(r.frontmatter) : (r.frontmatter || {});
    const teamKey = fm?.team_key || r.slug.split('/')[2]?.replace(/-\d{4}-\d{2}-\d{2}$/, '');
    const date = fm?.date || 'unknown';

    if (!byTeam.has(teamKey) || date > byTeam.get(teamKey)!.date) {
      byTeam.set(teamKey, {
        slug: r.slug,
        title: r.title,
        body: r.compiled_truth || '',
        team: fm?.team || TEAM_DISPLAY[teamKey] || teamKey,
        teamKey,
        date,
        frontmatter: fm,
      });
    }
  }
  return byTeam;
}

async function getBlockedTickets(sql: ReturnType<typeof db.getConnection>): Promise<JiraTicket[]> {
  const rows = await sql`
    SELECT slug, title, compiled_truth, frontmatter
    FROM pages
    WHERE type = 'ticket'
      AND frontmatter->>'status' = 'Blocked'
    ORDER BY frontmatter->>'priority', title
  `;
  return rows.map(rowToTicket);
}

async function getHighPriorityOpen(sql: ReturnType<typeof db.getConnection>): Promise<JiraTicket[]> {
  const rows = await sql`
    SELECT slug, title, compiled_truth, frontmatter
    FROM pages
    WHERE type = 'ticket'
      AND frontmatter->>'priority' IN ('P0', 'P1')
      AND frontmatter->>'status' NOT IN ('Done', 'Closed')
    ORDER BY frontmatter->>'priority', frontmatter->>'project', title
  `;
  return rows.map(rowToTicket);
}

async function getCustomerIssuesOpen(sql: ReturnType<typeof db.getConnection>): Promise<JiraTicket[]> {
  const rows = await sql`
    SELECT slug, title, compiled_truth, frontmatter
    FROM pages
    WHERE type = 'ticket'
      AND frontmatter->>'issue_type' = 'Customer Investigation'
      AND frontmatter->>'status' NOT IN ('Done', 'Closed')
    ORDER BY frontmatter->>'priority', title
  `;
  return rows.map(rowToTicket);
}

function rowToTicket(r: Row): JiraTicket {
  return {
    slug: r.slug,
    title: r.title,
    body: r.compiled_truth || '',
    frontmatter: typeof r.frontmatter === 'string' ? JSON.parse(r.frontmatter) : (r.frontmatter || {}),
  };
}

// --- Analysis ---

function extractBlockers(report: StatusReport): string[] {
  const blockers: string[] = [];
  const body = report.body;

  // Find the Blockers section
  const blockerMatch = body.match(/(?:###?\s*\**Blockers?\b.*?\**|anything you need)[\s\S]*?(?=###?\s*\**(?:Cross-team|Customer|Delivery)|$)/i);
  if (blockerMatch) {
    const section = blockerMatch[0];
    // Extract bullet points
    const bullets = section.match(/^\s*[\*\-]\s+.+$/gm);
    if (bullets) {
      for (const b of bullets) {
        const clean = b.replace(/^\s*[\*\-]\s+/, '').trim();
        if (clean && !clean.match(/^None|^No blockers|^Nothing/i)) {
          blockers.push(clean);
        }
      }
    }
  }
  return blockers;
}

function extractDeliveryRisks(report: StatusReport): string[] {
  const risks: string[] = [];
  const body = report.body;

  const riskMatch = body.match(/(?:###?\s*\**Delivery risk)[\s\S]*?(?=###?\s*\**(?:Cross-team|Customer|Blockers)|$)/i);
  if (riskMatch) {
    const section = riskMatch[0];
    const bullets = section.match(/^\s*[\*\-]\s+.+$/gm);
    if (bullets) {
      for (const b of bullets) {
        const clean = b.replace(/^\s*[\*\-]\s+/, '').trim();
        if (clean && !clean.match(/^None|^No risk|^Nothing/i)) {
          risks.push(clean);
        }
      }
    }
    // Also check for "Path to green" which indicates something is at risk
    if (section.match(/path to green/i) && !risks.length) {
      const pathMatch = section.match(/path to green[:\s]*(.*?)(?:\n|$)/i);
      if (pathMatch) risks.push(pathMatch[1].trim());
    }
  }
  return risks;
}

function extractWins(report: StatusReport): string[] {
  const wins: string[] = [];
  const body = report.body;

  // Look for ✅ Done items
  const donePattern = /✅\s*\[([A-Z]+-\d+)\]\([^)]*\)\s*[—–-]\s*(.+?)(?:\s*_\(|$)/gm;
  let match;
  while ((match = donePattern.exec(body)) !== null) {
    const desc = match[2].replace(/\\\[|\\\]/g, '').replace(/\[.*?\]\(.*?\)/g, '').trim();
    wins.push(`${match[1]} — ${desc}`);
  }

  // Look for "Complete" in epic status
  const completeEpic = body.match(/\*\*Epic:\*\*.*?\|\s*✅\s*Complete/gi);
  if (completeEpic) {
    for (const e of completeEpic) {
      const epicMatch = e.match(/\[([A-Z]+-\d+)\s*[—–-]\s*(.+?)\]/);
      if (epicMatch) wins.push(`Epic complete: ${epicMatch[1]} — ${epicMatch[2]}`);
    }
  }

  return wins.slice(0, 5); // Cap at 5 most notable
}

function extractOneLineStatus(report: StatusReport): string {
  const body = report.body;

  // Try to get the first highlight epic and its status
  const epicMatch = body.match(/🥇.*?\n.*?\*\*Epic:\*\*\s*\[([A-Z]+-\d+)\s*[—–-]\s*(.+?)\].*?\|\s*(.+?)(?:\n|$)/s);
  if (epicMatch) {
    const status = epicMatch[3].trim().replace(/[🔄📋✅🚧⏸️]/g, '').trim();
    return `${epicMatch[1]} ${epicMatch[2].trim()} — ${status}`;
  }

  // Fallback: first meaningful line of highlights (strip emoji/custom tags)
  const firstLine = body.match(/(?:Highlights|##).*?\n\n?(.*?)(?:\n\n|\n\*)/s);
  if (firstLine) {
    const clean = firstLine[1]
      .replace(/<custom[^>]*>.*?<\/custom>/g, '')
      .replace(/[#*\[\]]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (clean.length > 10) return clean.slice(0, 120);
  }

  return 'See full report';
}

/** Extract a multi-line status snippet — top priorities with status */
function extractStatusSnippet(report: StatusReport): string {
  const body = report.body;
  const lines: string[] = [];

  // Extract medal-ranked priorities (🥇🥈🥉) with their epic status
  const medalPattern = /(?:🥇|🥈|🥉|####?\s*🥇|####?\s*🥈|####?\s*🥉)\s*(.+?)(?:\n|$)/g;
  let match;
  while ((match = medalPattern.exec(body)) !== null) {
    let heading = match[1].replace(/\*\*/g, '').replace(/<custom[^>]*>.*?<\/custom>/g, '').trim();
    if (!heading) continue;

    // Try to find the epic status on the next line
    const afterMatch = body.slice(match.index + match[0].length, match.index + match[0].length + 500);
    const epicStatus = afterMatch.match(/\*\*Epic:\*\*\s*\[([A-Z]+-\d+)\s*[—–-]\s*(.+?)\].*?\|\s*(.+?)(?:\n|$)/);
    if (epicStatus) {
      const status = epicStatus[3].replace(/[🔄📋✅🚧⏸️]/g, '').trim();
      lines.push(`• ${heading} (${epicStatus[1]}) — ${status}`);
    } else {
      lines.push(`• ${heading}`);
    }
  }

  // If no medals found, try bold headings (NEXT/DevEco style)
  if (lines.length === 0) {
    const boldPattern = /(?:^|\n)\*\*(.+?)\*\*\s*(?:<custom[^>]*>.*?<\/custom>\s*)*/g;
    while ((match = boldPattern.exec(body)) !== null) {
      const heading = match[1].replace(/<custom[^>]*>.*?<\/custom>/g, '').trim();
      if (heading && !heading.match(/^(?:Epic|Highlights|Week of|Status|Blockers|Cross-team|Customer|Delivery)/i) && heading.length > 5) {
        lines.push(`• ${heading}`);
        if (lines.length >= 3) break;
      }
    }
  }

  // If still nothing, try ### headings
  if (lines.length === 0) {
    const h3Pattern = /###\s*(?:🥇|🥈|🥉)?\s*(.+?)(?:\n|$)/g;
    while ((match = h3Pattern.exec(body)) !== null) {
      const heading = match[1].replace(/\*\*/g, '').replace(/<custom[^>]*>.*?<\/custom>/g, '').trim();
      if (heading && !heading.match(/^(?:Highlights|Blockers|Cross-team|Customer|Delivery)/i)) {
        lines.push(`• ${heading}`);
        if (lines.length >= 3) break;
      }
    }
  }

  return lines.slice(0, 3).join('\n');
}

/** Group JIRA tickets by team key using project-to-team mapping */
function groupByTeam(tickets: JiraTicket[]): Map<string, JiraTicket[]> {
  const byTeam = new Map<string, JiraTicket[]>();
  for (const t of tickets) {
    const project = (t.frontmatter?.project as string) || '';
    const teamKey = PROJECT_TO_TEAM[project] || 'other';
    if (!byTeam.has(teamKey)) byTeam.set(teamKey, []);
    byTeam.get(teamKey)!.push(t);
  }
  return byTeam;
}

function extractCustomerIssues(report: StatusReport): string[] {
  const issues: string[] = [];
  const body = report.body;

  const section = body.match(/(?:###?\s*\**Customer.*?(?:production|issues))[\s\S]*?(?=###?\s*\**(?:Delivery|Blockers|Cross-team)|$)/i);
  if (!section) return [];

  // Look for customer names and ticket refs
  const ticketPattern = /\[([A-Z]+-\d+)\].*?(?:\*\*Customer:\*\*\s*(.+?)\s*\||customer[:\s]*(.+?)(?:\n|\|))/gi;
  let match;
  while ((match = ticketPattern.exec(section[0])) !== null) {
    const customer = (match[2] || match[3] || '').trim();
    if (customer) issues.push(`${match[1]}: ${customer}`);
  }

  return issues;
}

// --- Report generation ---

interface TeamSignals {
  blockers: string[];
  risks: string[];
  wins: string[];
  snippet: string;
  blockedTickets: JiraTicket[];
  p0Tickets: JiraTicket[];
  p1Tickets: JiraTicket[];
  customerInvestigations: JiraTicket[];
  unreportedBlocked: JiraTicket[];
}

function generateRollup(
  reports: Map<string, StatusReport>,
  blockedTickets: JiraTicket[],
  highPriority: JiraTicket[],
  customerIssues: JiraTicket[],
): string {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10);
  const weekday = today.toLocaleDateString('en-US', { weekday: 'long' });

  // Group JIRA data by team
  const blockedByTeam = groupByTeam(blockedTickets);
  const highPriorityByTeam = groupByTeam(highPriority);
  const customerByTeam = groupByTeam(customerIssues);

  // Build reported JIRA keys set (what's mentioned in status reports)
  const reportedKeys = new Set<string>();
  for (const [, report] of reports) {
    const refs = report.frontmatter?.jira_refs as string[] | undefined;
    if (refs) refs.forEach(r => reportedKeys.add(r));
  }

  // Analyze each team
  const teamSignals = new Map<string, TeamSignals>();

  for (const teamKey of TEAM_ORDER) {
    const report = reports.get(teamKey);
    const teamBlocked = blockedByTeam.get(teamKey) || [];
    const teamHP = highPriorityByTeam.get(teamKey) || [];
    const teamCI = customerByTeam.get(teamKey) || [];
    const unreported = teamBlocked.filter(t => !reportedKeys.has(t.frontmatter?.jira_key as string));

    const signals: TeamSignals = {
      blockers: report ? extractBlockers(report) : [],
      risks: report ? extractDeliveryRisks(report) : [],
      wins: report ? extractWins(report) : [],
      snippet: report ? extractStatusSnippet(report) : 'No status report this week',
      blockedTickets: teamBlocked,
      p0Tickets: teamHP.filter(t => (t.frontmatter?.priority as string) === 'P0'),
      p1Tickets: teamHP.filter(t => (t.frontmatter?.priority as string) === 'P1'),
      customerInvestigations: teamCI,
      unreportedBlocked: unreported,
    };

    teamSignals.set(teamKey, signals);
  }

  // --- Build cross-cutting summary ---
  const needsAttention: string[] = [];
  const watchList: string[] = [];

  for (const teamKey of TEAM_ORDER) {
    const teamName = TEAM_DISPLAY[teamKey] || teamKey;
    const signals = teamSignals.get(teamKey)!;

    // NEEDS ATTENTION: blockers from status reports
    for (const b of signals.blockers) {
      needsAttention.push(`*${teamName}:* ${b}`);
    }
    // NEEDS ATTENTION: P0 tickets
    if (signals.p0Tickets.length > 0) {
      const keys = signals.p0Tickets.map(t => t.frontmatter?.jira_key).join(', ');
      needsAttention.push(`*${teamName}:* ${signals.p0Tickets.length} open P0 — ${keys}`);
    }
    // NEEDS ATTENTION: blocked tickets not in status reports
    if (signals.unreportedBlocked.length > 0) {
      const keys = signals.unreportedBlocked.slice(0, 3).map(t => t.frontmatter?.jira_key).join(', ');
      const more = signals.unreportedBlocked.length > 3 ? ` +${signals.unreportedBlocked.length - 3} more` : '';
      needsAttention.push(`*${teamName}:* ${signals.unreportedBlocked.length} blocked tickets not in status report — ${keys}${more}`);
    }

    // WATCH LIST: delivery risks
    for (const r of signals.risks) {
      watchList.push(`*${teamName}:* ${r}`);
    }
    // WATCH LIST: P1 tickets
    if (signals.p1Tickets.length > 0) {
      watchList.push(`*${teamName}:* ${signals.p1Tickets.length} open P1 tickets`);
    }
    // WATCH LIST: unassigned customer investigations
    const unassignedCI = signals.customerInvestigations.filter(t => !t.frontmatter?.assignee);
    if (unassignedCI.length > 0) {
      watchList.push(`*${teamName}:* ${unassignedCI.length} unassigned customer investigation${unassignedCI.length > 1 ? 's' : ''}`);
    }
  }

  // --- Build the report ---
  let report = `📋 *OCP Weekly Rollup — ${dateStr}*\n`;
  report += `_${reports.size} teams reporting | Data as of ${weekday}_\n`;

  // Cross-cutting alerts
  if (needsAttention.length > 0) {
    report += `\n🔴 *NEEDS ATTENTION*\n`;
    for (const item of needsAttention) {
      report += `${item}\n`;
    }
  } else {
    report += `\n🔴 *NEEDS ATTENTION*\nNone — all clear this week.\n`;
  }

  if (watchList.length > 0) {
    report += `\n🟡 *WATCH LIST*\n`;
    for (const item of watchList) {
      report += `${item}\n`;
    }
  }

  // Per-team sections
  report += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

  for (const teamKey of TEAM_ORDER) {
    const teamName = TEAM_DISPLAY[teamKey] || teamKey;
    const signals = teamSignals.get(teamKey)!;
    const statusReport = reports.get(teamKey);

    // Team header with status indicator
    let indicator = '🟢';
    if (signals.blockers.length > 0 || signals.p0Tickets.length > 0) indicator = '🔴';
    else if (signals.risks.length > 0 || signals.unreportedBlocked.length > 0 || signals.p1Tickets.length > 5) indicator = '🟡';

    report += `\n${indicator} *${teamName}*`;
    if (statusReport) report += ` _(${statusReport.date})_`;
    report += `\n`;

    // Status snippet (priorities)
    if (signals.snippet) {
      report += `${signals.snippet}\n`;
    }

    // Blockers inline
    if (signals.blockers.length > 0) {
      report += `⚠️ *Blockers:*\n`;
      for (const b of signals.blockers) {
        report += `  • ${b}\n`;
      }
    }

    // Delivery risks inline
    if (signals.risks.length > 0) {
      report += `⏳ *Risks:*\n`;
      for (const r of signals.risks) {
        report += `  • ${r}\n`;
      }
    }

    // JIRA signals
    const jiraSignals: string[] = [];
    if (signals.p0Tickets.length > 0) {
      jiraSignals.push(`${signals.p0Tickets.length} P0`);
    }
    if (signals.p1Tickets.length > 0) {
      jiraSignals.push(`${signals.p1Tickets.length} P1`);
    }
    if (signals.blockedTickets.length > 0) {
      jiraSignals.push(`${signals.blockedTickets.length} blocked`);
    }
    if (signals.customerInvestigations.length > 0) {
      const unassigned = signals.customerInvestigations.filter(t => !t.frontmatter?.assignee).length;
      const ciStr = `${signals.customerInvestigations.length} customer investigation${signals.customerInvestigations.length > 1 ? 's' : ''}`;
      jiraSignals.push(unassigned > 0 ? `${ciStr} (${unassigned} unassigned)` : ciStr);
    }
    if (jiraSignals.length > 0) {
      report += `📎 _JIRA: ${jiraSignals.join(' · ')}_\n`;
    }

    // Wins
    if (signals.wins.length > 0) {
      report += `✅ ${signals.wins.slice(0, 3).join(' · ')}\n`;
    }
  }

  // Stats footer
  const totalP0 = highPriority.filter(t => (t.frontmatter?.priority as string) === 'P0').length;
  const totalP1 = highPriority.filter(t => (t.frontmatter?.priority as string) === 'P1').length;
  report += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  report += `_${blockedTickets.length} blocked · ${totalP0} P0 · ${totalP1} P1 · ${customerIssues.length} customer investigations_`;

  return report;
}

function toSlackPayload(report: string): string {
  return JSON.stringify({
    text: report,
    unfurl_links: false,
    unfurl_media: false,
  });
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const postToSlack = args.includes('--slack');
  const jsonOutput = args.includes('--json');

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL not set.');
    process.exit(1);
  }

  await db.connect({ engine: 'postgres', database_url: databaseUrl });
  const sql = db.getConnection();

  // Fetch data
  const [reports, blockedTickets, highPriority, customerIssues] = await Promise.all([
    getLatestStatusReports(sql),
    getBlockedTickets(sql),
    getHighPriorityOpen(sql),
    getCustomerIssuesOpen(sql),
  ]);

  // Generate report
  const rollup = generateRollup(reports, blockedTickets, highPriority, customerIssues);

  if (jsonOutput) {
    console.log(JSON.stringify({
      date: new Date().toISOString().slice(0, 10),
      teams: reports.size,
      blockedTickets: blockedTickets.length,
      highPriority: highPriority.length,
      customerIssues: customerIssues.length,
      report: rollup,
    }, null, 2));
  } else {
    // Print to terminal (replace Slack markdown with plain)
    const plain = rollup
      .replace(/\*/g, '')
      .replace(/_([^_]+)_/g, '$1');
    console.log(plain);
  }

  // Post to Slack
  if (postToSlack) {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (!webhookUrl) {
      console.error('\nERROR: SLACK_WEBHOOK_URL not set. Cannot post to Slack.');
      process.exit(1);
    }

    console.log('\nPosting to Slack...');
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: toSlackPayload(rollup),
    });

    if (resp.ok) {
      console.log('✓ Posted to Slack');
    } else {
      console.error(`✗ Slack error: ${resp.status} ${await resp.text()}`);
      process.exit(1);
    }
  }

  // Also write to file
  const { writeFileSync, mkdirSync } = await import('fs');
  const { join } = await import('path');
  const outDir = join(import.meta.dir, '..', 'data');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `rollup-${new Date().toISOString().slice(0, 10)}.md`);
  writeFileSync(outPath, rollup);

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
