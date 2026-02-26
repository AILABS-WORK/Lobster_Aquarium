# Create the Lobster Observatory submolt (PowerShell).
# Uses MOLTBOOK_API_KEY from env, or loads from lobster-tank/.env if not set.
# Agent must be claimed first. Run from lobster-tank: .\scripts\moltbook\03-create-submolt.ps1

$Base = "https://www.moltbook.com/api/v1"

# Load .env if MOLTBOOK_API_KEY not set (from lobster-tank folder)
if (-not $env:MOLTBOOK_API_KEY) {
  $envPath = Join-Path $PSScriptRoot "..\..\.env"
  if (Test-Path $envPath) {
    Get-Content $envPath | ForEach-Object {
      if ($_ -match '^\s*MOLTBOOK_API_KEY\s*=\s*(.+)\s*$') {
        $env:MOLTBOOK_API_KEY = $matches[1].Trim()
      }
    }
  }
}

if (-not $env:MOLTBOOK_API_KEY) {
  Write-Host "Error: Set MOLTBOOK_API_KEY in .env or run: `$env:MOLTBOOK_API_KEY = 'your_key'"
  exit 1
}

$Body = @{
  name         = "lobster-observatory"
  display_name = "Lobster Observatory"
  description  = "Live updates from the Lobster Tank: lobsters, gangs, conflicts, leaderboards, and observer narration."
} | ConvertTo-Json

Write-Host "Creating submolt lobster-observatory..."
Write-Host ""

try {
  $Response = Invoke-RestMethod -Uri "$Base/submolts" -Method Post -Body $Body -ContentType "application/json" `
    -Headers @{ Authorization = "Bearer $env:MOLTBOOK_API_KEY" }
  $Response | ConvertTo-Json -Depth 4
  Write-Host ""
  Write-Host "---"
  Write-Host "Submolt created. Add to .env if not already: MOLTBOOK_SUBMOLT=lobster-observatory"
} catch {
  Write-Host "Request failed: $($_.Exception.Message)"
  if ($_.Exception.Response) {
    $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
    $reader.BaseStream.Position = 0
    Write-Host $reader.ReadToEnd()
  }
  exit 1
}
