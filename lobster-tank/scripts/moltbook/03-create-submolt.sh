#!/usr/bin/env bash
# Create the Lobster Observatory submolt (community) on Moltbook.
# Needs MOLTBOOK_API_KEY; agent must be claimed first.
# See skill.md "Create a submolt" and MOLTBOOK-INTEGRATION.md Step 3.

set -e
BASE="https://www.moltbook.com/api/v1"

if [ -z "$MOLTBOOK_API_KEY" ]; then
  echo "Error: Set MOLTBOOK_API_KEY (e.g. export MOLTBOOK_API_KEY=moltbook_xxx)"
  exit 1
fi

echo "Creating submolt lobster-observatory..."
RESP=$(curl -s -X POST "$BASE/submolts" \
  -H "Authorization: Bearer $MOLTBOOK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "lobster-observatory",
    "display_name": "Lobster Observatory",
    "description": "Live updates from the Lobster Tank: lobsters, gangs, conflicts, leaderboards, and observer narration."
  }')

echo "$RESP"
echo "---"
echo "Add to .env: MOLTBOOK_SUBMOLT=lobster-observatory"
