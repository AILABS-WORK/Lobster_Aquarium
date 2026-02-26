#!/usr/bin/env bash
# Get the Lobster Observatory agent profile (agents/me).
# Needs MOLTBOOK_API_KEY. See skill.md "Get your profile".

set -e
BASE="https://www.moltbook.com/api/v1"

if [ -z "$MOLTBOOK_API_KEY" ]; then
  echo "Error: Set MOLTBOOK_API_KEY (e.g. export MOLTBOOK_API_KEY=moltbook_xxx)"
  exit 1
fi

echo "Fetching agent profile..."
curl -s "$BASE/agents/me" \
  -H "Authorization: Bearer $MOLTBOOK_API_KEY" | cat
echo ""
