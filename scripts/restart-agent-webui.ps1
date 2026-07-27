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

  [switch]$ForceBuild,
  [switch]$BuildOnly,
  [switch]$StartOnly,

  # Refuse to stop an unrelated port owner by default. Use this only after
  # manually confirming that the process on -Port is safe to terminate.
  [switch]$ForcePortOwner
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
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline -and (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
      Start-Sleep -Milliseconds 200
    }
    if (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
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
  $deadline = (Get-Date).AddSeconds(20)
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
  } finally {
    $client.Dispose()
  }

  if (-not $healthy) {
    $details = if (Test-Path -LiteralPath $stderrPath -PathType Leaf) {
      (Get-Content -LiteralPath $stderrPath -Tail 20) -join [Environment]::NewLine
    } else {
      "No stderr log was created."
    }
    throw "Agent WebUI did not become healthy on port $Port.`n$details"
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
  Stop-ExistingServer
  Start-Server
} finally {
  if ($ownsMutex) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
