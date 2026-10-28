param(
  [ValidatePattern('^[a-zA-Z0-9]+$')][string]$RemoteJob = '46pa21lc2qm2',
  [ValidateRange(1024,65535)][int]$LocalPort = 8021,
  [ValidateRange(1024,65535)][int]$RemotePort = 8020,
  [string]$IdentityFile = "$HOME\.ssh\openbayes",
  [switch]$EnsureFullFrameService,
  [switch]$Watch
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$runtimeRoot = Join-Path $env:TEMP "codex\Graduation-project\tunnel-$RemoteJob"
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
if (-not (Test-Path -LiteralPath $IdentityFile)) { throw "SSH key not found: $IdentityFile" }
if ($EnsureFullFrameService -and $RemotePort -ne 8030) {
  throw 'EnsureFullFrameService applies only to the full-frame backend on remote port 8030'
}

function Start-FullFrameService([string]$SshHost, [string]$SshPort) {
  # Reconnecting SSH does not restart Python after a workspace restart. Restore
  # only the existing backend on an already-running workspace; never start a GPU
  # workspace or change its model/configuration from this watcher.
  $remoteCode = @'
import fcntl, os, pathlib, socket, subprocess, time
root = pathlib.Path('/output/live-vton/candidates/fluxrt')
runtime = pathlib.Path('/tmp/codex/Graduation-project/full-frame-service')
runtime.mkdir(parents=True, exist_ok=True)
server = root / 'fluxrt_server.py'
python = root / 'venv/bin/python'
if not server.is_file() or not python.is_file():
    raise RuntimeError('Existing FluxRT server/runtime is missing; no installation attempted')
with (runtime / 'start.lock').open('a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    pid_file = root / 'service.pid'
    if pid_file.is_file():
        pid = pid_file.read_text().strip()
        command = pathlib.Path('/proc') / pid / 'cmdline' if pid.isdecimal() else None
        try:
            running = command is not None and str(server).encode() in command.read_bytes().split(b'\0')
        except (FileNotFoundError, ProcessLookupError):
            running = False
        if running:
            print('Existing full-frame service process is running', flush=True)
            raise SystemExit(0)
    with socket.socket() as probe:
        if probe.connect_ex(('127.0.0.1', 8030)) == 0:
            raise RuntimeError('Remote port 8030 has an unrecognized listener; leaving it untouched')
    log_path = runtime / ('service-' + time.strftime('%Y%m%d-%H%M%S', time.gmtime()) + '.log')
    with log_path.open('a') as log:
        process = subprocess.Popen(
            [str(python), '-u', '-B', str(server)], cwd=root,
            stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
            env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1',
                 'TMPDIR': str(runtime), 'FLUXRT_ROOT': str(root)},
            start_new_session=True)
    pid_file.write_text(str(process.pid))
    print('Started existing full-frame service; model is loading', flush=True)
'@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remoteCode))
  "import base64;exec(base64.b64decode('$encoded'))" | & ssh -T -o BatchMode=yes `
    -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 `
    -o ServerAliveInterval=15 -o ServerAliveCountMax=3 `
    -i $IdentityFile -p $SshPort "root@$SshHost" /opt/venv/bin/python -u -B -
  if ($LASTEXITCODE -ne 0) { throw 'Could not restore the existing full-frame backend over SSH' }
}

function Test-Tunnel {
  try {
    $status = Invoke-RestMethod "http://127.0.0.1:$LocalPort/api/status" -TimeoutSec 3
    return $status.host -like "*$RemoteJob*"
  } catch { return $false }
}

if ($Watch) {
  # One watcher per local port. SSH keepalives detect broken links; each reconnect
  # resolves the current job port, which changes when the container restarts.
  $mutex = [Threading.Mutex]::new($false, "Local\LiveVtonTunnel$LocalPort")
  if (-not $mutex.WaitOne(0)) { exit 0 }
  try {
    while ($true) {
      try {
        $info = (& bayes gear info $RemoteJob 2>&1 | Out-String)
        if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve running workspace SSH endpoint' }
        $match = [regex]::Match($info, 'ssh\s+root@([a-zA-Z0-9.-]+)\s+-p\s*(\d+)')
        if (-not $match.Success) { throw 'Workspace is not running or SSH endpoint is unavailable' }
        $sshHost = $match.Groups[1].Value
        $sshPort = $match.Groups[2].Value
        if ($EnsureFullFrameService) { Start-FullFrameService $sshHost $sshPort }
        Write-Host "$(Get-Date -Format s) forwarding 127.0.0.1:$LocalPort to remote $RemotePort via $sshHost port $sshPort"
        & ssh -N -T -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 `
          -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 `
          -L "127.0.0.1:${LocalPort}:127.0.0.1:${RemotePort}" -i $IdentityFile -p $sshPort "root@$sshHost"
      } catch { Write-Warning $_.Exception.Message }
      Start-Sleep -Seconds 5
    }
  } finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
}

if (Test-Tunnel) { Write-Host "Tunnel ready: http://127.0.0.1:$LocalPort"; exit 0 }
$watchArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Watch',
  '-RemoteJob', $RemoteJob, '-LocalPort', $LocalPort, '-RemotePort', $RemotePort, '-IdentityFile', "`"$IdentityFile`"")
if ($EnsureFullFrameService) { $watchArgs += '-EnsureFullFrameService' }
$watcher = Start-Process powershell.exe -WindowStyle Hidden -WorkingDirectory $projectRoot `
  -ArgumentList $watchArgs -PassThru `
  -RedirectStandardOutput (Join-Path $runtimeRoot "watcher-$LocalPort.stdout.log") `
  -RedirectStandardError (Join-Path $runtimeRoot "watcher-$LocalPort.stderr.log")
$watcher.Id | Set-Content (Join-Path $runtimeRoot "watcher-$LocalPort.pid")
$deadline = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $deadline) {
  if (Test-Tunnel) { Write-Host "Tunnel ready: http://127.0.0.1:$LocalPort (watcher $($watcher.Id))"; exit 0 }
  Start-Sleep -Seconds 2
}
throw "Tunnel health check timed out. Watcher retries; inspect $runtimeRoot"
