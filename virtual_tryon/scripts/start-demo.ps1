param(
  [string]$CatVtonPython = $env:CATVTON_PYTHON,
  [string]$ModelRoot = $env:CATVTON_MODEL_ROOT,
  [switch]$Remote,
  [switch]$Demo,
  [switch]$LocalBaseline
)

$ErrorActionPreference = "Stop"
if ($Demo -and ($Remote -or $LocalBaseline)) { throw '-Demo cannot be combined with -Remote or -LocalBaseline' }
$projectRoot = Split-Path -Parent $PSScriptRoot
$serverRoot = Join-Path $projectRoot "server"
$runtimeRoot = Join-Path $env:TEMP "codex\Graduation-project\virtual-tryon-runtime"

if (-not $CatVtonPython) {
  $CatVtonPython = "D:\Temp\codex\Graduation-project\catvton\.venv\Scripts\python.exe"
}
if (-not $ModelRoot) {
  $ModelRoot = "D:\Temp\codex\Graduation-project\catvton\models\catvton-bundle"
}

New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
$env:PYTHONDONTWRITEBYTECODE = '1'
if ($Remote) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'start-remote-tunnel.ps1') -LocalPort 8022 -RemotePort 8030 -EnsureFullFrameService
  if ($LASTEXITCODE -ne 0) { throw 'Full-frame tunnel did not become ready' }
}

function Test-HttpReady([string]$Url) {
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Get-CatVtonStatus {
  try {
    return Invoke-RestMethod `
      -Uri "http://127.0.0.1:8020/api/status" `
      -TimeoutSec 3
  } catch {
    return $null
  }
}

$needLocalBaseline = (-not $Remote -and -not $Demo) -or $LocalBaseline
if ($needLocalBaseline) {
  $catVtonStatus = Get-CatVtonStatus
  if (-not $catVtonStatus) {
    if (-not (Test-Path -LiteralPath $CatVtonPython)) {
      throw "CatVTON Python was not found: $CatVtonPython"
    }
    if (-not (Test-Path -LiteralPath $ModelRoot)) {
      throw "CatVTON model bundle was not found: $ModelRoot"
    }
    $env:CATVTON_MODEL_ROOT = $ModelRoot
    Start-Process `
      -FilePath $CatVtonPython `
      -ArgumentList "tryon_server.py" `
      -WorkingDirectory $serverRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $runtimeRoot "catvton.stdout.log") `
      -RedirectStandardError (Join-Path $runtimeRoot "catvton.stderr.log")
    Write-Host "Started CatVTON on http://127.0.0.1:8020"
  } else {
    Write-Host "CatVTON is already running on http://127.0.0.1:8020"
  }
} else {
  Write-Host "Preview mode: skipping the optional local CatVTON GPU baseline"
}

if (-not (Test-HttpReady "http://127.0.0.1:8766/")) {
  Start-Process `
    -FilePath "npm.cmd" `
    -ArgumentList "run", "dev", "--", "--port", "8766", "--strictPort" `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $runtimeRoot "web.stdout.log") `
    -RedirectStandardError (Join-Path $runtimeRoot "web.stderr.log")
  Write-Host "Started web app on http://127.0.0.1:8766/"
} else {
  Write-Host "Web app is already running on http://127.0.0.1:8766/"
}

$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline) {
  $catVtonStatus = if ($needLocalBaseline) { Get-CatVtonStatus } else { $null }
  if ($catVtonStatus -and $catVtonStatus.error) {
    throw "CatVTON failed to load: $($catVtonStatus.error)"
  }
  $fullFrameStatus = $null
  if ($Remote) {
    try { $fullFrameStatus = Invoke-RestMethod 'http://127.0.0.1:8022/api/status' -TimeoutSec 3 } catch {}
    if ($fullFrameStatus -and $fullFrameStatus.error) { throw "Full-frame model failed to load: $($fullFrameStatus.error)" }
  }
  if (
    (Test-HttpReady "http://127.0.0.1:8766/") -and
    (-not $needLocalBaseline -or ($catVtonStatus -and $catVtonStatus.ready)) -and
    (-not $Remote -or ($fullFrameStatus -and $fullFrameStatus.ready))
  ) {
    Write-Host "Demo ready: http://127.0.0.1:8766/"
    if ($Demo) { Write-Host 'Offline studio: http://127.0.0.1:8766/studio?demo=1 (no GPU or tunnel required)' }
    exit 0
  }
  Start-Sleep -Seconds 2
}

throw "Services did not become ready. Check logs in $runtimeRoot"
