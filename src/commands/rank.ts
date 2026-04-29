#!/usr/bin/env bun
/**
 * gbrain rank — List pages ranked by a frontmatter field.
 *
 * Usage:
 *   gbrain rank --type idea --field voters --limit 20
 *   gbrain rank --type account --field arr --tag enterprise --limit 50
 *   gbrain rank --type theme --field total_revenue --order asc
 */

import { operationsByName } from '../core/operations.ts';
import type { OperationContext } from '../core/operations.ts';

export async function runRank(args: string[], engine: any) {
  const params: Record<string, string | number> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--type' && args[i + 1]) params.type = args[++i];
    else if (arg === '--field' && args[i + 1]) params.field = args[++i];
    else if (arg === '--order' && args[i + 1]) params.order = args[++i];
    else if (arg === '--tag' && args[i + 1]) params.tag = args[++i];
    else if (arg === '--min-value' && args[i + 1]) params.min_value = parseFloat(args[++i]);
    else if (arg === '--limit' && args[i + 1]) params.limit = parseInt(args[++i]);
  }

  if (!params.type || !params.field) {
    console.error('Usage: gbrain rank --type <type> --field <field> [--order desc|asc] [--tag <tag>] [--min-value <n>] [--limit <n>]');
    process.exit(1);
  }

  const op = operationsByName['list_pages_ranked'];
  const ctx: OperationContext = { engine, remote: false };
  const result = await op.handler(ctx, params);

  if (!Array.isArray(result) || result.length === 0) {
    console.log('No results.');
    return;
  }

  // Print as table
  const field = params.field as string;
  console.log(`${'Rank'.padEnd(5)} ${'Slug'.padEnd(50)} ${String(field).padEnd(15)} Title`);
  console.log('─'.repeat(100));
  for (let i = 0; i < result.length; i++) {
    const r = result[i] as any;
    const val = r[field] !== undefined ? String(r[field]) : 'N/A';
    console.log(`${String(i + 1).padEnd(5)} ${String(r.slug).padEnd(50)} ${val.padEnd(15)} ${r.title || ''}`);
  }
}
