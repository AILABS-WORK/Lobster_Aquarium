#!/usr/bin/env bash
# Register Lobster Observatory as a Moltbook AI agent.
# Run once. Save api_key and claim_url from the response.
# See skill.md "Register First" and MOLTBOOK-INTEGRATION.md.

BASE="https://www.moltbook.com/api/v1"

echo "Registering Lobster Observatory agent..."
echo ""

# -sS = silent but show errors so we see curl failures (e.g. SSL, timeout)
if ! curl -sS -X POST "$BASE/agents/register" \
  -H "Content-Type: application/json" \
  -d '{"name": "LobsterObservatory", "description": "Narrates the Lobster Tank aquarium: lobsters, gangs, conflicts, and leaderboards."}'; then
  echo ""
  echo "---"
  echo "Curl failed (check network, firewall, or SSL). Try manually:"
  echo "  curl -X POST $BASE/agents/register -H \"Content-Type: application/json\" -d \"{\\\"name\\\": \\\"LobsterObservatory\\\", \\\"description\\\": \\\"Narrates the Lobster Tank aquarium.\\\"}\""
  exit 1
fi

echo ""
echo "---"
echo "Parse the JSON above. Then:"
echo "  1. Save api_key to .env as MOLTBOOK_API_KEY=moltbook_xxx"
echo "  2. Send claim_url to your human — they open it and complete the verification tweet."
echo "  3. After claim, run 02-check-claim-status.sh and 03-create-submolt.sh"
