<#
.SYNOPSIS
Builds Agent WebUI when needed, then safely restarts the production server.

.EXAMPLE
pwsh -NoProfile -File .\scripts\restart-agent-webui.ps1

.EXAMPLE
pwsh -NoProfile -File .\scripts\restart-agent-webui.ps1 -ForceBuild

.EXAMPLE
pwsh -NoProfile -File .\scripts\restart-agent-webui.ps1 -BuildOnly
#>

[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 3457,

  [ValidateNotNullOrEmpty()]
  [string]$ListenHost = "0.0.0.0",

  [ValidateRange(5, 300)]
  [int]$StartupTimeoutSeconds = 60,

  [ValidateRange(5, 86400)]
  [int]$ShutdownTimeoutSeconds = 60,

  [ValidateRange(5, 86400)]
  [int]$DrainTimeoutSeconds = 7200,

  [ValidateRange(5, 86400)]
  [int]$DrainNoProgressTimeoutSeconds = 3600,

  [ValidateRange(1, 30)]
  [int]$DrainReadyGraceSeconds = 3,

  [string]$AccessToken = "",

  [switch]$ForceBuild,
  [switch]$BuildOnly,
  [switch]$StartOnly,

  # Wait for every active turn, including restart-safe persistent turns. This
  # closes the race between an external idle check and the actual drain.
  [switch]$RequireFullyIdle,

  # Refuse to stop an unrelated port owner by default. Use this only after
  # manually confirming that the process on -Port is safe to terminate.
  [switch]$ForcePortOwner,

  # Explicit break-glass switches. Normal restarts never interrupt active turns
  # and never force-kill a backend that is still shutting down.
  [switch]$ForceActiveTurns,
  [switch]$ForceShutdown
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$backendDir = Join-Path $repoRoot "backend"
$runtimeDir = Join-Path $repoRoot ".agent-webui\restart"
$buildStatePath = Join-Path $runtimeDir "build-state.json"
$pidPath = Join-Path $runtimeDir "server-$Port.pid"
$stdoutPath = Join-Path $runtimeDir "server-$Port.stdout.log"
$stderrPath = Join-Path $runtimeDir "server-$Port.stderr.log"

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null

function Get-BuildInputs {
  $files = [Collections.Generic.List[IO.FileInfo]]::new()
  $fixedInputs = @(
    "package.json",
    "package-lock.json",
    "shared\package.json",
    "shared\tsconfig.json",
    "frontend-shared\package.json",
    "backend\package.json",
    "backend\tsconfig.json",
    "frontend\package.json",
    "frontend\index.html",
    "frontend\tsconfig.json",
    "frontend\tsconfig.node.json",
    "frontend\vite.config.ts",
    "frontend\tailwind.config.ts",
    "frontend\postcss.config.js",
    "frontend\postcss.config.cjs"
  )
  foreach ($relativePath in $fixedInputs) {
    $path = Join-Path $repoRoot $relativePath
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      $files.Add((Get-Item -LiteralPath $path))
    }
  }

  $sourceRoots = @(
    "shared\src",
    "frontend-shared",
    "backend\src",
    "frontend\src",
    "frontend\public"
  )
  foreach ($relativeRoot in $sourceRoots) {
    $path = Join-Path $repoRoot $relativeRoot
    if (-not (Test-Path -LiteralPath $path -PathType Container)) { continue }
    foreach ($file in Get-ChildItem -LiteralPath $path -File -Recurse) {
      if ($file.FullName -match '[\\/](?:dist|node_modules|coverage)[\\/]') { continue }
      $files.Add($file)
    }
  }

  return @($files | Sort-Object FullName -Unique)
}

function Get-BuildSnapshot {
  $inputs = @(Get-BuildInputs)
  $records = foreach ($file in $inputs) {
    $relativePath = [IO.Path]::GetRelativePath($repoRoot, $file.FullName).Replace("\", "/")
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    "$relativePath`t$hash"
  }
  $payload = [Text.Encoding]::UTF8.GetBytes(($records -join "`n"))
  $fingerprint = [Convert]::ToHexString(
    [Security.Cryptography.SHA256]::HashData($payload)
  ).ToLowerInvariant()
  $newestInputUtc = if ($inputs.Count) {
    ($inputs | Measure-Object LastWriteTimeUtc -Maximum).Maximum
  } else {
    [DateTime]::MinValue
  }
  return [pscustomobject]@{
    Fingerprint = $fingerprint
    Paths = @($inputs | ForEach-Object {
      [IO.Path]::GetRelativePath($repoRoot, $_.FullName).Replace("\", "/")
    })
    NewestInputUtc = $newestInputUtc
  }
}

function Get-BuildOutputs {
  $required = @(
    "shared\dist\index.js",
    "backend\dist\server.js",
    "backend\dist\app.js",
    "backend\dist\actions\sessions.js",
    "frontend\dist\index.html"
  ) | ForEach-Object { Join-Path $repoRoot $_ }
  if ($required | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }) {
    return @()
  }
  $assetsDir = Join-Path $repoRoot "frontend\dist\assets"
  if (
    -not (Test-Path -LiteralPath $assetsDir -PathType Container) -or
    -not (Get-ChildItem -LiteralPath $assetsDir -File | Select-Object -First 1)
  ) {
    return @()
  }
  return @($required | ForEach-Object { Get-Item -LiteralPath $_ })
}

function Read-BuildState {
  if (-not (Test-Path -LiteralPath $buildStatePath -PathType Leaf)) { return $null }
  try {
    $state = Get-Content -LiteralPath $buildStatePath -Raw | ConvertFrom-Json
    if ($state.version -ne 1 -or $state.repoRoot -ne $repoRoot) { return $null }
    return $state
  } catch {
    return $null
  }
}

function Save-BuildState($snapshot) {
  $state = [ordered]@{
    version = 1
    repoRoot = $repoRoot
    fingerprint = $snapshot.Fingerprint
    paths = @($snapshot.Paths)
    builtAt = (Get-Date).ToUniversalTime().ToString("o")
  }
  $tempPath = "$buildStatePath.tmp"
  $state | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $tempPath -Encoding utf8
  Move-Item -LiteralPath $tempPath -Destination $buildStatePath -Force
}

function Test-NeedsBuild($snapshot, $outputs, $state) {
  if ($ForceBuild -or $outputs.Count -eq 0) { return $true }
  if ($state -and $state.fingerprint -eq $snapshot.Fingerprint) { return $false }

  # A deleted build input cannot be inferred from output timestamps, so force
  # one rebuild when a previously recorded source/config path disappears.
  if ($state -and $state.paths) {
    $currentPaths = [Collections.Generic.HashSet[string]]::new(
      [string[]]$snapshot.Paths,
      [StringComparer]::OrdinalIgnoreCase
    )
    foreach ($oldPath in @($state.paths)) {
      if (-not $currentPaths.Contains([string]$oldPath)) { return $true }
    }
  }

  # This also recognizes a successful manual `npm run build`: all sentinel
  # outputs will be newer than every current source/config input.
  $oldestOutputUtc = ($outputs | Measure-Object LastWriteTimeUtc -Minimum).Minimum
  return $oldestOutputUtc -lt $snapshot.NewestInputUtc
}

function Invoke-ConditionalBuild {
  $snapshot = Get-BuildSnapshot
  $outputs = @(Get-BuildOutputs)
  $state = Read-BuildState
  if (-not (Test-NeedsBuild $snapshot $outputs $state)) {
    Write-Host "Build is current; skipping npm run build." -ForegroundColor DarkGray
    Save-BuildState $snapshot
    return
  }

  Write-Host "Build inputs changed; running npm run build..." -ForegroundColor Cyan
  Push-Location $repoRoot
  try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
  $snapshot = Get-BuildSnapshot
  if ((Get-BuildOutputs).Count -eq 0) {
    throw "Build completed without all required production outputs"
  }
  Save-BuildState $snapshot
}

function Get-ListeningProcessIds {
  return @(
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique
  )
}

function Test-AgentWebuiProcess($processInfo, $knownPid) {
  if (-not $processInfo) { return $false }
  if ($knownPid -and $processInfo.ProcessId -eq $knownPid) { return $true }
  return (
    $processInfo.Name -ieq "node.exe" -and
    [string]$processInfo.CommandLine -match '(?i)(?:^|\s)(?:[^\s"]+[\\/])?dist[\\/]server\.js(?:\s|$)'
  )
}

function Get-ObjectPropertyValue($object, [string]$name) {
  if ($null -eq $object) { return $null }
  $property = $object.PSObject.Properties |
    Where-Object { $_.Name -eq $name } |
    Select-Object -First 1
  if ($property) { return $property.Value }
  return $null
}

function Get-DrainAccessToken {
  if ($AccessToken.Trim()) { return $AccessToken.Trim() }
  if ([string]$env:AGENT_WEBUI_TOKEN) { return ([string]$env:AGENT_WEBUI_TOKEN).Trim() }
  $tokenPath = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".agent-webui\token"
  if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) {
    throw "Cannot drain Agent WebUI without an access token. Pass -AccessToken or set AGENT_WEBUI_TOKEN."
  }
  $value = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
  if (-not $value) { throw "Agent WebUI token file is empty: $tokenPath" }
  return $value
}

function Invoke-AgentWebuiRequest($client, [string]$method, [string]$path) {
  $httpMethod = switch ($method) {
    "GET" { [Net.Http.HttpMethod]::Get }
    "POST" { [Net.Http.HttpMethod]::Post }
    "DELETE" { [Net.Http.HttpMethod]::Delete }
    default { throw "Unsupported HTTP method: $method" }
  }
  $request = [Net.Http.HttpRequestMessage]::new($httpMethod, "http://127.0.0.1:$Port$path")
  if ($method -eq "POST") {
    $request.Content = [Net.Http.StringContent]::new("{}", [Text.Encoding]::UTF8, "application/json")
  }
  try {
    $response = $client.SendAsync($request).GetAwaiter().GetResult()
    try {
      $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      $body = $null
      if ($content) {
        try { $body = $content | ConvertFrom-Json } catch { $body = $content }
      }
      return [pscustomobject]@{ StatusCode = [int]$response.StatusCode; Body = $body }
    } finally {
      $response.Dispose()
    }
  } finally {
    $request.Dispose()
  }
}

function Cancel-AgentWebuiDrain {
  try {
    $client = [Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromSeconds(5)
    $client.DefaultRequestHeaders.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new("Bearer", (Get-DrainAccessToken))
    try { [void](Invoke-AgentWebuiRequest $client "DELETE" "/api/admin/drain") } finally { $client.Dispose() }
  } catch {
    Write-Warning "Could not cancel drain mode automatically: $($_.Exception.Message)"
  }
}

function Wait-ExistingServerDrain {
  $owners = @(Get-ListeningProcessIds)
  if (-not $owners.Count) { return $false }

  $knownPid = 0
  if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
    [void][int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$knownPid)
  }
  foreach ($processId in $owners) {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
    if (-not (Test-AgentWebuiProcess $processInfo $knownPid)) {
      if ($ForcePortOwner) {
        Write-Warning "Skipping drain because port $Port is owned by an unrecognized process; no access token was sent to it."
        return $false
      }
      throw "Refusing to send the drain credential to unrecognized port owner PID $processId."
    }
  }

  if ($ForceActiveTurns) {
    Write-Warning "-ForceActiveTurns bypassed the active-turn drain. Running conversations may be interrupted."
    return $false
  }

  $client = [Net.Http.HttpClient]::new()
  $client.Timeout = [TimeSpan]::FromSeconds(10)
  $client.DefaultRequestHeaders.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new("Bearer", (Get-DrainAccessToken))
  $supportsDrain = $false
  try {
    $started = Invoke-AgentWebuiRequest $client "POST" "/api/admin/drain"
    if ($started.StatusCode -eq 404) {
      Write-Warning "The running backend predates the drain endpoint. Using a one-time authenticated idle check; new turns cannot be blocked until this upgrade completes."
    } elseif ($started.StatusCode -ge 200 -and $started.StatusCode -lt 300) {
      $supportsDrain = $true
      Write-Host "Restart handoff enabled; persistent Codex turns remain accepted while non-migratable work is paused." -ForegroundColor Yellow
    } else {
      throw "Drain request failed with HTTP $($started.StatusCode)."
    }

    $wallDeadline = (Get-Date).AddSeconds($DrainTimeoutSeconds)
    $progressDeadline = (Get-Date).AddSeconds($DrainNoProgressTimeoutSeconds)
    $readySince = $null
    $lastFingerprint = $null
    while ($true) {
      if ($supportsDrain) {
        $status = Invoke-AgentWebuiRequest $client "GET" "/api/admin/drain"
        if ($status.StatusCode -ne 200) { throw "Drain status failed with HTTP $($status.StatusCode)." }
        $active = @($status.Body.activeTurns)
        $activeCount = [int]$status.Body.activeCount
        $blockingValue = Get-ObjectPropertyValue $status.Body "blockingActiveCount"
        $blockingActiveCount = if ($null -eq $blockingValue) { $activeCount } else { [int]$blockingValue }
        $admissionCount = [int]$status.Body.admissionCount
        $ready = if ($RequireFullyIdle) {
          $activeCount -eq 0 -and $admissionCount -eq 0
        } else {
          [bool]$status.Body.ready
        }
      } else {
        $status = Invoke-AgentWebuiRequest $client "GET" "/api/sessions"
        if ($status.StatusCode -ne 200) { throw "Legacy idle check failed with HTTP $($status.StatusCode)." }
        $sessionList = Get-ObjectPropertyValue $status.Body "sessions"
        $sessions = if ($null -ne $sessionList) { @($sessionList) } else { @($status.Body) }
        $active = @($sessions | Where-Object {
          $statusValue = Get-ObjectPropertyValue $_ "status"
          $aliveValue = Get-ObjectPropertyValue $_ "webuiAlive"
          $statusValue -eq "running" -and $aliveValue -ne $false
        })
        $activeCount = $active.Count
        $blockingActiveCount = $activeCount
        $admissionCount = 0
        $ready = $activeCount -eq 0
      }

      $ids = @($active | ForEach-Object {
        $sessionId = Get-ObjectPropertyValue $_ "sessionId"
        if ($sessionId) { $sessionId }
        else { Get-ObjectPropertyValue $_ "id" }
      } | Sort-Object)
      $fingerprint = "$activeCount|$blockingActiveCount|$admissionCount|$($ids -join ',')"
      if ($fingerprint -ne $lastFingerprint) {
        $lastFingerprint = $fingerprint
        $progressDeadline = (Get-Date).AddSeconds($DrainNoProgressTimeoutSeconds)
        Write-Host "Drain status: $activeCount active turn(s), $blockingActiveCount blocking turn(s), $admissionCount admission(s)." -ForegroundColor DarkGray
      }

      if ($ready) {
        if ($null -eq $readySince) { $readySince = Get-Date }
        if (((Get-Date) - $readySince).TotalSeconds -ge $DrainReadyGraceSeconds) {
          $readyDescription = if ($RequireFullyIdle) { "no active turns" } else { "no blocking work" }
          Write-Host "The backend had $readyDescription for $DrainReadyGraceSeconds seconds; it is safe to restart." -ForegroundColor Green
          return $supportsDrain
        }
      } else {
        $readySince = $null
      }

      if ((Get-Date) -ge $wallDeadline) {
        throw "Drain timed out after $DrainTimeoutSeconds seconds; the running server was not stopped."
      }
      if ((Get-Date) -ge $progressDeadline) {
        throw "Drain made no observable progress for $DrainNoProgressTimeoutSeconds seconds; the running server was not stopped."
      }
      Start-Sleep -Milliseconds 1000
    }
  } catch {
    if ($supportsDrain) {
      try { [void](Invoke-AgentWebuiRequest $client "DELETE" "/api/admin/drain") } catch { Write-Warning "Drain cancellation failed: $($_.Exception.Message)" }
    }
    throw
  } finally {
    $client.Dispose()
  }
}

function Stop-ExistingServer {
  $knownPid = 0
  if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
    [void][int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$knownPid)
  }

  foreach ($processId in Get-ListeningProcessIds) {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
    if (-not (Test-AgentWebuiProcess $processInfo $knownPid) -and -not $ForcePortOwner) {
      $description = if ($processInfo) {
        "$($processInfo.Name) (PID $processId): $($processInfo.CommandLine)"
      } else {
        "PID $processId"
      }
      throw "Port $Port is owned by an unrecognized process: $description. Inspect it, then rerun with -ForcePortOwner only if it is safe."
    }

    Write-Host "Stopping Agent WebUI on port $Port (PID $processId)..." -ForegroundColor Yellow
    Stop-Process -Id $processId
    $deadline = (Get-Date).AddSeconds($ShutdownTimeoutSeconds)
    while ((Get-Date) -lt $deadline -and (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
      Start-Sleep -Milliseconds 200
    }
    if (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
      if (-not $ForceShutdown) {
        throw "Agent WebUI PID $processId did not exit within $ShutdownTimeoutSeconds seconds. It was not force-killed; inspect it or rerun with -ForceShutdown."
      }
      Write-Warning "-ForceShutdown is force-killing Agent WebUI PID $processId."
      Stop-Process -Id $processId -Force
    }
  }

  if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
    Remove-Item -LiteralPath $pidPath -Force
  }
}

function Start-Server {
  $owners = @(Get-ListeningProcessIds)
  if ($owners.Count) {
    throw "Port $Port became occupied before startup (PID: $($owners -join ', '))"
  }
  $node = Get-Command node.exe -ErrorAction Stop
  $arguments = @("dist/server.js", "--host", $ListenHost, "--port", [string]$Port)
  $codexRuntime = $env:AGENT_WEBUI_CODEX_RUNTIME
  # The backend owns the default (persistent). Only pass an override when the
  # operator explicitly requests one, so the launcher cannot silently drift
  # back to the non-resumable stdio runtime.
  if (-not [string]::IsNullOrWhiteSpace($codexRuntime)) {
    $arguments += @("--codex-runtime", $codexRuntime.Trim())
  }
  $codexBinary = $env:AGENT_WEBUI_CODEX_BINARY
  if ([string]::IsNullOrWhiteSpace($codexBinary)) {
    $bundledCodex = Get-ChildItem `
      -Path (Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin\*\codex.exe") `
      -File `
      -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
    if ($bundledCodex) {
      $codexBinary = $bundledCodex.FullName
    }
  }
  if (-not [string]::IsNullOrWhiteSpace($codexBinary)) {
    $arguments += @("--codex-binary", $codexBinary)
  }
  $process = Start-Process `
    -FilePath $node.Source `
    -ArgumentList $arguments `
    -WorkingDirectory $backendDir `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -WindowStyle Hidden `
    -PassThru
  Set-Content -LiteralPath $pidPath -Value $process.Id -Encoding ascii

  $healthUri = "http://127.0.0.1:$Port/api/me"
  $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
  $healthy = $false
  $client = [Net.Http.HttpClient]::new()
  $client.Timeout = [TimeSpan]::FromSeconds(2)
  try {
    while ((Get-Date) -lt $deadline) {
      if ($process.HasExited) { break }
      try {
        $response = $client.GetAsync($healthUri).GetAwaiter().GetResult()
        $status = [int]$response.StatusCode
        $response.Dispose()
        if ($status -eq 200 -or $status -eq 401) {
          $healthy = $true
          break
        }
      } catch {
        # The socket may not be bound yet.
      }
      Start-Sleep -Milliseconds 250
    }
    # Avoid a false timeout when the server becomes ready at the deadline.
    if (-not $healthy -and -not $process.HasExited) {
      try {
        $response = $client.GetAsync($healthUri).GetAwaiter().GetResult()
        $status = [int]$response.StatusCode
        $response.Dispose()
        $healthy = $status -eq 200 -or $status -eq 401
      } catch {
        # The diagnostics below distinguish a live process from a listener.
      }
    }
  } finally {
    $client.Dispose()
  }

  if (-not $healthy) {
    $processState = if ($process.HasExited) {
      "Process PID $($process.Id) exited with code $($process.ExitCode)."
    } else {
      "Process PID $($process.Id) is still running."
    }
    $listeners = @(Get-ListeningProcessIds)
    $listenerState = if ($listeners.Count) {
      "Listening PID(s) on port ${Port}: $($listeners -join ', ')."
    } else {
      "No process is listening on port $Port."
    }
    $stderrTail = if ((Test-Path -LiteralPath $stderrPath -PathType Leaf) -and (Get-Item -LiteralPath $stderrPath).Length) {
      "stderr:`n$((Get-Content -LiteralPath $stderrPath -Tail 20) -join [Environment]::NewLine)"
    } else {
      "stderr was empty."
    }
    $stdoutTail = if ((Test-Path -LiteralPath $stdoutPath -PathType Leaf) -and (Get-Item -LiteralPath $stdoutPath).Length) {
      "stdout:`n$((Get-Content -LiteralPath $stdoutPath -Tail 20) -join [Environment]::NewLine)"
    } else {
      "stdout was empty."
    }
    throw "Agent WebUI did not become healthy on port $Port within $StartupTimeoutSeconds seconds.`n$processState`n$listenerState`n$stderrTail`n$stdoutTail"
  }

  Write-Host "Agent WebUI is running: http://127.0.0.1:$Port/ (PID $($process.Id))" -ForegroundColor Green
  Write-Host "Logs: $stdoutPath and $stderrPath" -ForegroundColor DarkGray
}

$mutex = [Threading.Mutex]::new($false, "Local\AgentWebUI-Restart-$Port")
$ownsMutex = $false
try {
  try {
    $ownsMutex = $mutex.WaitOne(0)
  } catch [Threading.AbandonedMutexException] {
    $ownsMutex = $true
  }
  if (-not $ownsMutex) {
    throw "Another Agent WebUI build/restart script is already running for port $Port"
  }

  if ($BuildOnly) {
    Invoke-ConditionalBuild
    Write-Host "Build-only check complete; the running server was not changed." -ForegroundColor Green
    exit 0
  }

  if ($StartOnly) {
    $owners = @(Get-ListeningProcessIds)
    if ($owners.Count) {
      foreach ($processId in $owners) {
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
        if (-not (Test-AgentWebuiProcess $processInfo 0)) {
          throw "Port $Port is already owned by an unrelated process (PID $processId): $($processInfo.CommandLine)"
        }
      }
      Write-Host "Agent WebUI is already running on port $Port (PID: $($owners -join ', '))." -ForegroundColor Green
      exit 0
    }
    Invoke-ConditionalBuild
    Start-Server
    exit 0
  }

  # Keep the verified live server available while compiling. The frontend
  # publisher is atomic, and Node keeps the already-loaded backend modules in
  # memory, so a failed build leaves the current instance usable. Only take the
  # short restart window after every required production output is ready.
  Invoke-ConditionalBuild
  $drainSupported = Wait-ExistingServerDrain
  try {
    Stop-ExistingServer
  } catch {
    if ($drainSupported -and @(Get-ListeningProcessIds).Count) { Cancel-AgentWebuiDrain }
    throw
  }
  Start-Server
} finally {
  if ($ownsMutex) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
