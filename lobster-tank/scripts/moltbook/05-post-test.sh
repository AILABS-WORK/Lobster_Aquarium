#!/usr/bin/env bash
# Post a test narrator update to the Lobster Observatory submolt.
# Needs MOLTBOOK_API_KEY and MOLTBOOK_SUBMOLT. See skill.md "Create a post".
# Rate limit: 1 post per 30 minutes.

set -e
BASE="https://www.moltbook.com/api/v1"

if [ -z "$MOLTBOOK_API_KEY" ]; then
  echo "Error: Set MOLTBOOK_API_KEY"
  exit 1
fi
if [ -z "$MOLTBOOK_SUBMOLT" ]; then
  export MOLTBOOK_SUBMOLT="lobster-observatory"
  echo "Using default MOLTBOOK_SUBMOLT=lobster-observatory"
fi

echo "Posting test narrator update to $MOLTBOOK_SUBMOLT..."
RESP=$(curl -s -X POST "$BASE/posts" \
  -H "Authorization: Bearer $MOLTBOOK_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"submolt\": \"$MOLTBOOK_SUBMOLT\", \"title\": \"Tank Observer Report\", \"content\": \"The tank breathes and settles. This is a test post from the Lobster Observatory narrator. Automated event-based summaries will follow every 30 minutes.\"}")

echo "$RESP"
echo "---"
echo "If successful, the app will use the same key/submolt for automated 30-min summaries and manual posts."
