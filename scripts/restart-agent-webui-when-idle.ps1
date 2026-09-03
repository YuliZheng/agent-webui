<#
.SYNOPSIS
Waits until Agent WebUI has no active turns, then performs a safe restart.

.DESCRIPTION
This monitor only observes the authenticated drain snapshot while turns are
active. Once activeCount and admissionCount are both zero, it hands off to the
normal restart script with RequireFullyIdle enabled. It never passes the access
token on a process command line.
#>

[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 3457,

  [ValidateRange(5, 60)]
  [int]$PollSeconds = 10,

  [ValidateRange(60, 86400)]
  [int]$MaxWaitSeconds = 28800,

  [ValidateRange(60, 86400)]
  [int]$NoProgressTimeoutSeconds = 14400,

  [string]$AccessToken = "",

  [string]$VerificationHtmlPath = "C:\Users\11947\av_history_personal_ranking.html",

  [switch]$StatusOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$restartScript = Join-Path $PSScriptRoot "restart-agent-webui.ps1"
$mutex = [Threading.Mutex]::new($false, "Local\AgentWebUI-IdleRestart-$Port")
$ownsMutex = $false

function Write-MonitorEvent([string]$message) {
  Write-Output "[$((Get-Date).ToString('o'))] $message"
}

function Get-AccessToken {
  if ($AccessToken.Trim()) { return $AccessToken.Trim() }
  if ([string]$env:AGENT_WEBUI_TOKEN) { return ([string]$env:AGENT_WEBUI_TOKEN).Trim() }
  $tokenPath = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".agent-webui\token"
  if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) {
    throw "Cannot monitor Agent WebUI without an access token."
  }
  $value = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
  if (-not $value) { throw "Agent WebUI access token file is empty." }
  return $value
}

function Get-RecognizedServer {
  $owners = @(
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique
  )
  if ($owners.Count -ne 1) {
    throw "Expected exactly one Agent WebUI listener on port $Port; found $($owners.Count)."
  }
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $($owners[0])"
  if (
    -not $processInfo -or
    $processInfo.Name -ine "node.exe" -or
    [string]$processInfo.CommandLine -notmatch '(?i)(?:^|\s)(?:[^\s"]+[\\/])?dist[\\/]server\.js(?:\s|$)'
  ) {
    throw "Port $Port is not owned by a recognized Agent WebUI server; no credential was sent."
  }
  return $processInfo
}

function New-AuthenticatedClient {
  $client = [Net.Http.HttpClient]::new()
  $client.Timeout = [TimeSpan]::FromSeconds(10)
  $client.DefaultRequestHeaders.Authorization =
    [Net.Http.Headers.AuthenticationHeaderValue]::new("Bearer", (Get-AccessToken))
  return $client
}

function Get-DrainSnapshot([Net.Http.HttpClient]$client) {
  $uri = "http://127.0.0.1:$Port/api/admin/drain"
  $response = $client.GetAsync($uri).GetAwaiter().GetResult()
  try {
    $status = [int]$response.StatusCode
    if ($status -ne 200) { throw "Idle status request failed with HTTP $status." }
    $json = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    return $json | ConvertFrom-Json
  } finally {
    $response.Dispose()
  }
}

function Get-SnapshotFingerprint($snapshot) {
  $ids = @($snapshot.activeTurns | ForEach-Object { [string]$_.sessionId } | Sort-Object)
  return "$([int]$snapshot.activeCount)|$([int]$snapshot.admissionCount)|$($ids -join ',')"
}

function Assert-PostRestart([int]$originalPid) {
  $deadline = (Get-Date).AddSeconds(90)
  $server = $null
  while ((Get-Date) -lt $deadline) {
    try {
      $candidate = Get-RecognizedServer
      if ([int]$candidate.ProcessId -ne $originalPid) {
        $server = $candidate
        break
      }
    } catch {
      # The port is expected to be briefly unavailable during handoff.
    }
    Start-Sleep -Milliseconds 250
  }
  if (-not $server) { throw "The listener PID did not change after restart." }
  if ([string]$server.CommandLine -match '(?i)--codex-runtime\s+stdio(?:\s|$)') {
    throw "Restarted Agent WebUI is using the non-persistent stdio runtime."
  }

  $client = New-AuthenticatedClient
  try {
    $health = $client.GetAsync("http://127.0.0.1:$Port/api/me").GetAwaiter().GetResult()
    try {
      $healthStatus = [int]$health.StatusCode
      if ($healthStatus -ne 200 -and $healthStatus -ne 401) {
        throw "Restarted Agent WebUI health returned HTTP $healthStatus."
      }
    } finally {
      $health.Dispose()
    }

    if (-not (Test-Path -LiteralPath $VerificationHtmlPath -PathType Leaf)) {
      throw "Verification HTML does not exist: $VerificationHtmlPath"
    }
    $encodedPath = [Uri]::EscapeDataString($VerificationHtmlPath)
    $request = [Net.Http.HttpRequestMessage]::new(
      [Net.Http.HttpMethod]::Get,
      "http://127.0.0.1:$Port/api/local-file-content?path=$encodedPath"
    )
    $html = $client.SendAsync(
      $request,
      [Net.Http.HttpCompletionOption]::ResponseHeadersRead
    ).GetAwaiter().GetResult()
    try {
      if ([int]$html.StatusCode -ne 200) {
        throw "HTML verification returned HTTP $([int]$html.StatusCode)."
      }
      if ($html.Content.Headers.ContentType.MediaType -ne "text/html") {
        throw "HTML verification returned an unexpected content type."
      }
      $csp = if ($html.Headers.Contains("Content-Security-Policy")) {
        ($html.Headers.GetValues("Content-Security-Policy") -join "; ")
      } else { "" }
      if ($csp -notmatch '(?i)\bsandbox\b' -or $csp -notmatch '(?i)\ballow-scripts\b') {
        throw "HTML verification CSP does not enable sandboxed scripts."
      }
      if ($csp -match '(?i)\ballow-same-origin\b') {
        throw "HTML verification CSP unexpectedly enables same-origin access."
      }
    } finally {
      $html.Dispose()
      $request.Dispose()
    }
  } finally {
    $client.Dispose()
  }

  $viewerSource = Join-Path $repoRoot "frontend\src\components\LocalFileViewer.vue"
  $viewerText = Get-Content -LiteralPath $viewerSource -Raw
  if ($viewerText -notmatch ':src="contentUrl"' -or $viewerText -match '\bsrcdoc\b') {
    throw "LocalFileViewer source is not using the URL-backed HTML iframe."
  }
  $liveIndex = Get-Item -LiteralPath (Join-Path $repoRoot "frontend\dist\index.html")
  $recentAssets = @(
    Get-ChildItem -LiteralPath (Join-Path $repoRoot "frontend\dist\assets") -Filter "*.js" -File |
      Where-Object { $_.LastWriteTimeUtc -ge $liveIndex.LastWriteTimeUtc.AddMinutes(-5) }
  )
  $assetHasEndpoint = $false
  foreach ($asset in $recentAssets) {
    if (Select-String -LiteralPath $asset.FullName -SimpleMatch "local-file-content" -Quiet) {
      $assetHasEndpoint = $true
      break
    }
  }
  if (-not $assetHasEndpoint) {
    throw "Published frontend assets do not contain the URL-backed local-file endpoint."
  }

  Write-MonitorEvent "Verified restarted Agent WebUI on PID $($server.ProcessId): persistent runtime, HTML script sandbox, and published frontend asset are current."
}

try {
  try {
    $ownsMutex = $mutex.WaitOne(0)
  } catch [Threading.AbandonedMutexException] {
    $ownsMutex = $true
  }
  if (-not $ownsMutex) {
    throw "Another idle-restart monitor is already running for port $Port."
  }

  $initialServer = Get-RecognizedServer
  $initialPid = [int]$initialServer.ProcessId
  $client = New-AuthenticatedClient
  try {
    $snapshot = Get-DrainSnapshot $client
    Write-MonitorEvent "Observed Agent WebUI PID $initialPid with $([int]$snapshot.activeCount) active turn(s) and $([int]$snapshot.admissionCount) admission(s)."
    if ($StatusOnly) { return }

    $wallDeadline = (Get-Date).AddSeconds($MaxWaitSeconds)
    $progressDeadline = (Get-Date).AddSeconds($NoProgressTimeoutSeconds)
    $lastFingerprint = Get-SnapshotFingerprint $snapshot
    $consecutiveFailures = 0

    while ($true) {
      $server = Get-RecognizedServer
      if ([int]$server.ProcessId -ne $initialPid) {
        Write-MonitorEvent "Stopped without action because Agent WebUI already changed from PID $initialPid to PID $($server.ProcessId)."
        return
      }

      try {
        $snapshot = Get-DrainSnapshot $client
        if ($consecutiveFailures -gt 0) {
          Write-MonitorEvent "Idle status polling recovered after $consecutiveFailures failure(s)."
          $consecutiveFailures = 0
        }
      } catch {
        $consecutiveFailures++
        if ($consecutiveFailures -eq 1 -or $consecutiveFailures % 6 -eq 0) {
          Write-MonitorEvent "Idle status poll failed ($consecutiveFailures consecutive): $($_.Exception.Message)"
        }
        if ((Get-Date) -ge $wallDeadline) {
          throw "Idle monitor timed out after $MaxWaitSeconds seconds; Agent WebUI was not restarted."
        }
        if ((Get-Date) -ge $progressDeadline) {
          throw "Idle monitor saw no progress for $NoProgressTimeoutSeconds seconds; Agent WebUI was not restarted."
        }
        Start-Sleep -Seconds $PollSeconds
        continue
      }

      $fingerprint = Get-SnapshotFingerprint $snapshot
      if ($fingerprint -ne $lastFingerprint) {
        $lastFingerprint = $fingerprint
        $progressDeadline = (Get-Date).AddSeconds($NoProgressTimeoutSeconds)
        Write-MonitorEvent "Idle status changed: $([int]$snapshot.activeCount) active turn(s), $([int]$snapshot.admissionCount) admission(s)."
      }

      if ([int]$snapshot.activeCount -eq 0 -and [int]$snapshot.admissionCount -eq 0) {
        Write-MonitorEvent "All turns are idle; handing off to the safe restart script."
        $client.Dispose()
        $client = $null
        $pwsh = Get-Command pwsh -ErrorAction Stop
        & $pwsh.Source -NoProfile -File $restartScript -Port $Port -RequireFullyIdle -DrainReadyGraceSeconds 1
        if ($LASTEXITCODE -ne 0) {
          throw "Safe restart script failed with exit code $LASTEXITCODE."
        }
        Assert-PostRestart $initialPid
        Write-MonitorEvent "Idle restart completed successfully."
        return
      }

      if ((Get-Date) -ge $wallDeadline) {
        throw "Idle monitor timed out after $MaxWaitSeconds seconds; Agent WebUI was not restarted."
      }
      if ((Get-Date) -ge $progressDeadline) {
        throw "Idle monitor saw no progress for $NoProgressTimeoutSeconds seconds; Agent WebUI was not restarted."
      }
      Start-Sleep -Seconds $PollSeconds
    }
  } finally {
    if ($client) { $client.Dispose() }
  }
} finally {
  if ($ownsMutex) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
