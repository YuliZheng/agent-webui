[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 3457,

  [ValidateRange(5, 300)]
  [int]$TailscaleRetrySeconds = 15
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$restartScript = Join-Path $PSScriptRoot "restart-agent-webui.ps1"
$runtimeDir = Join-Path $repoRoot ".agent-webui\restart"
$logPath = Join-Path $runtimeDir "autostart.log"
$statusPath = Join-Path $runtimeDir "autostart-status.json"

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
"[$((Get-Date).ToString('o'))] Starting Agent WebUI logon task." |
  Set-Content -LiteralPath $logPath -Encoding utf8

function Write-AutostartStatus {
  param(
    [string]$State,
    [string]$Message,
    [int]$TailscaleAttempts = 0
  )

  [ordered]@{
    state = $State
    message = $Message
    tailscaleAttempts = $TailscaleAttempts
    updatedAt = (Get-Date).ToString("o")
  } | ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding utf8
}

try {
  Write-AutostartStatus -State "starting-backend" -Message "Starting Agent WebUI without waiting for network."
  $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
  & $pwsh -NoProfile -NonInteractive -File $restartScript -Port $Port -StartOnly *>> $logPath
  if ($LASTEXITCODE -ne 0) {
    throw "Agent WebUI start helper exited with code $LASTEXITCODE."
  }

  $tailscale = Get-Command tailscale.exe -ErrorAction SilentlyContinue
  if (-not $tailscale) {
    Write-AutostartStatus -State "backend-ready" -Message "Agent WebUI is ready; Tailscale is not installed."
    exit 0
  }

  # The backend is already ready at this point. Tailscale may still be in
  # NoState immediately after Windows logon, so retry only the HTTPS exposure
  # in this hidden task; local WebUI availability never waits on the network.
  $attempt = 0
  while ($true) {
    $attempt++
    & $tailscale.Source serve --bg "http://127.0.0.1:$Port" *>> $logPath
    if ($LASTEXITCODE -eq 0) {
      Write-AutostartStatus -State "complete" -Message "Agent WebUI and Tailscale HTTPS are ready." -TailscaleAttempts $attempt
      exit 0
    }

    Write-AutostartStatus `
      -State "waiting-for-tailscale" `
      -Message "Agent WebUI is ready locally; waiting for Tailscale/network." `
      -TailscaleAttempts $attempt
    Start-Sleep -Seconds $TailscaleRetrySeconds
  }
} catch {
  Write-AutostartStatus -State "failed" -Message $_.Exception.Message
  "[$((Get-Date).ToString('o'))] ERROR: $($_.Exception.Message)" |
    Add-Content -LiteralPath $logPath -Encoding utf8
  exit 1
}
