# Kelbo installer for Windows (PowerShell 5.1 or 7).
#
#   irm https://raw.githubusercontent.com/kelbodev/kelbo/main/install.ps1 | iex
#   .\install.ps1 -Dir C:\Tools\kelbo -Port 3500
#
# Checks Node.js and git, clones Kelbo at the latest release tag (v<x.y.z>), installs its
# dependencies and starts it under PM2 (offering to install PM2 when it is missing). Run again
# on an existing installation, it updates it. It never touches config.json.
#
# Parameters (or environment variables, also for "irm | iex"):
#   -Dir DIR          KELBO_DIR      installation folder (default ~\kelbo)
#   -Port PORT        KELBO_PORT     port Kelbo listens on (default 3500)
#   -Version vX.Y.Z   KELBO_VERSION  a given release instead of the latest
#   -Repo URL         KELBO_REPO     repository (default https://github.com/kelbodev/kelbo.git)
#   -Yes                             install PM2 without asking when it is missing
#   -NoPm2                           don't use PM2: install only, start Kelbo yourself
param(
  [string]$Dir = $(if ($env:KELBO_DIR) { $env:KELBO_DIR } else { Join-Path $HOME 'kelbo' }),
  [string]$Port = $env:KELBO_PORT,
  [string]$Repo = $(if ($env:KELBO_REPO) { $env:KELBO_REPO } else { 'https://github.com/kelbodev/kelbo.git' }),
  [string]$Version = $env:KELBO_VERSION,
  [switch]$Yes,
  [switch]$NoPm2
)
$ErrorActionPreference = 'Stop'
$MinNode = 18

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    v $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    ! $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "`nx $m" -ForegroundColor Red; exit 1 }
function Has($c)  { [bool](Get-Command $c -ErrorAction SilentlyContinue) }
function Ask($q) {
  if ($Yes) { return $true }
  try { $a = Read-Host "    $q [Y/n]" } catch { return $false }
  return ($a -eq '' -or $a -match '^(y|yes|s|si)$')
}
# comando esterno: errore se esce con un codice diverso da 0
function Run($exe, [string[]]$arguments, $message) {
  & $exe @arguments
  if ($LASTEXITCODE -ne 0) { Die $message }
}

if ($Port -and $Port -notmatch '^\d+$') { Die "Invalid port: $Port" }
if ($Version -and $Version -notmatch '^v\d+\.\d+\.\d+$') { Die "Invalid version: $Version (expected vX.Y.Z)" }

Step 'Checking the requirements'
if (-not (Has git)) { Die 'git is not installed: install Git for Windows (https://git-scm.com) and run this script again.' }
if (-not (Has node)) { Die "Node.js is not installed: install Node.js $MinNode or later (https://nodejs.org) and run this script again." }
$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt $MinNode) { Die "Node.js $(node -v) is too old: Kelbo needs Node.js $MinNode or later." }
if (-not (Has npm)) { Die 'npm is not installed (it comes with Node.js).' }
Ok "git, Node.js $(node -v), npm $(npm -v)"

if (-not $Version) {
  Step 'Looking for the latest Kelbo release'
  $tags = git ls-remote --tags --refs $Repo 'v*' 2>$null | ForEach-Object { ($_ -split 'refs/tags/')[1] } |
    Where-Object { $_ -match '^v\d+\.\d+\.\d+$' }
  $Version = $tags | Sort-Object { [version]($_.Substring(1)) } | Select-Object -Last 1
  if (-not $Version) { Die "No release found in $Repo (is the address right, is the network up?)" }
}
Ok "Kelbo $Version"

if (Test-Path (Join-Path $Dir '.git')) {
  Step "Updating the installation in $Dir"
  $name = node -p "try { require(process.argv[1] + '/package.json').name } catch { '' }" $Dir
  if ($name -ne 'kelbo') { Die "$Dir is a git repository but not Kelbo: choose another folder with -Dir." }
  # package-lock.json rewritten by an npm install doesn't count: it is put back
  git -C $Dir checkout --quiet -- package-lock.json 2>$null
  $changes = git -C $Dir status --porcelain --untracked-files=no
  if ($changes) { Die "$Dir has local changes (git status): save or undo them, then run this script again." }
  Run git @('-C', $Dir, 'fetch', '--quiet', '--no-tags', 'origin', "refs/tags/${Version}:refs/tags/${Version}") "Download of $Version failed."
  $target = git -C $Dir rev-parse "$Version^{commit}"
  if ((git -C $Dir rev-parse HEAD) -eq $target) { Ok "Already at $Version" }
  else {
    git -C $Dir merge-base --is-ancestor HEAD $target
    if ($LASTEXITCODE -ne 0) { Die "$Version doesn't follow the installed version (different history): update refused." }
    $branch = git -C $Dir symbolic-ref --quiet --short HEAD 2>$null
    if ($branch) { Run git @('-C', $Dir, 'merge', '--quiet', '--ff-only', $target) 'Update failed.'; Ok "Branch $branch moved to $Version" }
    else { Run git @('-C', $Dir, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', $target) 'Update failed.'; Ok "Moved to $Version" }
  }
} elseif ((Test-Path $Dir) -and (Get-ChildItem -Force $Dir | Select-Object -First 1)) {
  Die "$Dir exists and is not empty: choose another folder with -Dir."
} else {
  Step "Downloading Kelbo $Version into $Dir"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Dir) | Out-Null
  Run git @('-c', 'advice.detachedHead=false', 'clone', '--quiet', '--branch', $Version, $Repo, $Dir) 'Download failed.'
  Ok 'Downloaded'
}

Step 'Installing the dependencies'
Push-Location $Dir
# npm ci keeps package-lock.json as released; npm install only if that fails (lock put back)
try {
  $flags = @('--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', '--loglevel=error')
  & npm ci @flags
  if ($LASTEXITCODE -ne 0) { Run npm (@('install') + $flags) 'npm install failed.'; git checkout --quiet -- package-lock.json 2>$null }
} finally { Pop-Location }
Ok 'Dependencies installed'

$url = "http://127.0.0.1:$(if ($Port) { $Port } else { '3500' })"
$usePm2 = -not $NoPm2
if ($usePm2 -and -not (Has pm2)) {
  Step 'PM2'
  Warn 'PM2 keeps Kelbo running in the background and restarts it after an update from the interface.'
  if (Ask 'Install PM2 now (npm install -g pm2)?') {
    Run npm @('install', '-g', 'pm2', '--no-audit', '--no-fund', '--loglevel=error') "Installing PM2 failed: run 'npm install -g pm2' and this script again."
    Ok "PM2 $(pm2 -v) installed"
  } else { $usePm2 = $false }
}

if ($usePm2) {
  Step 'Starting Kelbo with PM2'
  if ($Port) { $env:KELBO_PORT = $Port }
  pm2 describe kelbo *> $null
  if ($LASTEXITCODE -eq 0) { Run pm2 @('restart', 'kelbo', '--update-env') 'PM2 restart failed.'; Ok "Restarted (PM2 process 'kelbo')" }
  else { Run pm2 @('start', (Join-Path $Dir 'server.js'), '--name', 'kelbo', '--cwd', $Dir) 'PM2 start failed.'; Ok "Started (PM2 process 'kelbo')" }
  pm2 save *> $null
  Ok 'Saved in the PM2 process list'
  Write-Host "`nKelbo $Version is running: $url" -ForegroundColor Green
  Write-Host 'To start it at login too, see https://pm2.keymetrics.io/docs/usage/startup/ (pm2-installer on Windows).'
} else {
  Write-Host "`nKelbo $Version is installed in $Dir" -ForegroundColor Green
  Write-Host "Start it with:  cd `"$Dir`"; $(if ($Port) { "`$env:KELBO_PORT=$Port; " })npm start   -> $url"
}
