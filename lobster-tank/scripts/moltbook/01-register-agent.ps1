# Register Lobster Observatory as a Moltbook AI agent (PowerShell).
# Run once. Save api_key and claim_url from the response.
# Usage: .\01-register-agent.ps1   or   pwsh -File scripts/moltbook/01-register-agent.ps1

$Base = "https://www.moltbook.com/api/v1"
$Body = @{
  name        = "LobsterObservatory"
  description = "Narrates the Lobster Tank aquarium: lobsters, gangs, conflicts, and leaderboards."
} | ConvertTo-Json

Write-Host "Registering Lobster Observatory agent..."
Write-Host ""

try {
  $Response = Invoke-RestMethod -Uri "$Base/agents/register" -Method Post -Body $Body -ContentType "application/json"
  $Response | ConvertTo-Json -Depth 5
  if ($Response.agent) {
    Write-Host ""
    Write-Host "--- Copy these ---"
    Write-Host "api_key: $($Response.agent.api_key)"
    Write-Host "claim_url: $($Response.agent.claim_url)"
    Write-Host "verification_code: $($Response.agent.verification_code)"
  }
} catch {
  Write-Host "Request failed: $($_.Exception.Message)"
  Write-Host ""
  Write-Host "Try in Git Bash: bash scripts/moltbook/01-register-agent.sh"
  Write-Host "Or curl manually:"
  Write-Host "  curl -X POST $Base/agents/register -H `"Content-Type: application/json`" -d '{`"name`":`"LobsterObservatory`",`"description`":`"Narrates the Lobster Tank aquarium.`"}'"
  exit 1
}

Write-Host ""
Write-Host "---"
Write-Host "Parse the JSON above. Then:"
Write-Host '  1. Save api_key to .env as MOLTBOOK_API_KEY=moltbook_xxx'
Write-Host '  2. Send claim_url to your human - they open it and complete the verification tweet.'
Write-Host '  3. After claim, run 02-check-claim-status.sh and 03-create-submolt.sh'
