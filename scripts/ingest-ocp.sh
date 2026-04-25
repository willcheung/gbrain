#!/usr/bin/env bash
# Ingest OCP data (Confluence status reports + JIRA tickets) into gbrain.
#
# Usage:
#   # Full pipeline (fetch + ingest):
#   ATLASSIAN_EMAIL="you@company.com" ATLASSIAN_API_TOKEN="..." ./scripts/ingest-ocp.sh
#
#   # Incremental (last 7 days):
#   ATLASSIAN_EMAIL="you@company.com" ATLASSIAN_API_TOKEN="..." ./scripts/ingest-ocp.sh --since 7d
#
#   # Ingest only (if you already fetched data):
#   ./scripts/ingest-ocp.sh --ingest-only
#
# Requires:
#   - bun
#   - ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN (for fetch step)
#   - DATABASE_URL or defaults to postgresql://wcheung@localhost/gbrain

set -euo pipefail
cd "$(dirname "$0")/.."

export DATABASE_URL="${DATABASE_URL:-postgresql://wcheung@localhost/gbrain}"
export PATH="$HOME/.bun/bin:$PATH"

SINCE_FLAG=""
INGEST_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --ingest-only) INGEST_ONLY=true ;;
    --since) SINCE_FLAG="--since" ;;
    *d)
      if [ "$SINCE_FLAG" = "--since" ]; then
        SINCE_FLAG="--since $arg"
      fi
      ;;
  esac
done

echo "=== OCP Data Ingestion Pipeline ==="
echo "DATABASE_URL: $DATABASE_URL"
echo ""

# Step 1: Fetch data from Atlassian
if [ "$INGEST_ONLY" = false ]; then
  echo "--- Step 1: Fetching data from Atlassian ---"
  bun scripts/fetch-ocp-data.ts --all $SINCE_FLAG
  echo ""
fi

# Step 2: Ingest Confluence status reports
if [ -f data/confluence-status-reports.json ]; then
  echo "--- Step 2: Ingesting Confluence status reports ---"
  bun scripts/ingest-confluence-status.ts data/confluence-status-reports.json
  echo ""
else
  echo "--- Step 2: SKIPPED (no data/confluence-status-reports.json) ---"
  echo ""
fi

# Step 3: Ingest JIRA tickets
if [ -f data/jira-tickets.json ]; then
  echo "--- Step 3: Ingesting JIRA tickets ---"
  bun scripts/ingest-jira-tickets.ts data/jira-tickets.json
  echo ""
else
  echo "--- Step 3: SKIPPED (no data/jira-tickets.json) ---"
  echo ""
fi

echo "=== Done ==="
