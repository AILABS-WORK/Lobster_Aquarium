#!/usr/bin/env bash
# Run after the human has claimed the agent (opened claim_url and verified).
# Checks claim status, then creates the lobster_observatory submolt if missing.
# Needs MOLTBOOK_API_KEY in env.

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "$MOLTBOOK_API_KEY" ]; then
  echo "Error: Set MOLTBOOK_API_KEY (e.g. export MOLTBOOK_API_KEY=moltbook_xxx)"
  exit 1
fi

echo "=== 1. Checking claim status ==="
"$SCRIPT_DIR/02-check-claim-status.sh"
echo ""
echo "=== 2. Creating submolt (if not already created) ==="
"$SCRIPT_DIR/03-create-submolt.sh"
echo ""
echo "Add to .env: MOLTBOOK_SUBMOLT=lobster-observatory"
echo "Then the app can perform automated narrator posts and manual posts."
