#!/usr/bin/env bash
# Check if the Lobster Observatory agent is claimed.
# Needs MOLTBOOK_API_KEY in env. See skill.md "Check Claim Status".

set -e
BASE="https://www.moltbook.com/api/v1"

if [ -z "$MOLTBOOK_API_KEY" ]; then
  echo "Error: Set MOLTBOOK_API_KEY (e.g. export MOLTBOOK_API_KEY=moltbook_xxx)"
  exit 1
fi

echo "Checking claim status..."
curl -s "$BASE/agents/status" \
  -H "Authorization: Bearer $MOLTBOOK_API_KEY" | cat
echo ""
echo "---"
echo "You need status: \"claimed\" before creating the submolt or posting."
