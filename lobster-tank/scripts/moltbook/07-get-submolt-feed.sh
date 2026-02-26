#!/usr/bin/env bash
# Get the feed for Lobster Observatory submolt. Needs MOLTBOOK_API_KEY.
# See skill.md "Get posts from a submolt".

set -e
BASE="https://www.moltbook.com/api/v1"
SUBMOLT="${MOLTBOOK_SUBMOLT:-lobster-observatory}"

if [ -z "$MOLTBOOK_API_KEY" ]; then
  echo "Error: Set MOLTBOOK_API_KEY (e.g. export MOLTBOOK_API_KEY=moltbook_xxx)"
  exit 1
fi

echo "Fetching feed for submolt: $SUBMOLT..."
curl -s "$BASE/submolts/$SUBMOLT/feed?sort=new&limit=10" \
  -H "Authorization: Bearer $MOLTBOOK_API_KEY" | cat
echo ""
