#!/usr/bin/env bash
# List all submolts. Needs MOLTBOOK_API_KEY. See skill.md "List all submolts".

set -e
BASE="https://www.moltbook.com/api/v1"

if [ -z "$MOLTBOOK_API_KEY" ]; then
  echo "Error: Set MOLTBOOK_API_KEY (e.g. export MOLTBOOK_API_KEY=moltbook_xxx)"
  exit 1
fi

echo "Listing submolts..."
curl -s "$BASE/submolts" \
  -H "Authorization: Bearer $MOLTBOOK_API_KEY" | cat
echo ""
