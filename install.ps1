# Cloud Code one-line installer (Windows PowerShell).
#   irm https://raw.githubusercontent.com/alver714/Cloud-Code/main/install.ps1 | iex
# Clones the public repo, installs deps, and launches the setup wizard.
$ErrorActionPreference = 'Stop'

$Repo = 'https://github.com/alver714/Cloud-Code.git'
$Dir  = if ($env:CLOUD_CODE_DIR) { $env:CLOUD_CODE_DIR } else { Join-Path $HOME 'cloud-code' }

function Say  ($m) { Write-Host $m -ForegroundColor Cyan }
function Warn ($m) { Write-Host $m -ForegroundColor Yellow }
function Die  ($m) { Write-Host $m -ForegroundColor Red; exit 1 }

Say 'Cloud Code installer'

if (-not (Get-Command git  -ErrorAction SilentlyContinue)) { Die 'git is required. Install from https://git-scm.com and re-run.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die 'Node.js 22+ is required. Install from https://nodejs.org and re-run.' }

$nodeMajor = ((node -v) -replace '^v','' -split '\.')[0]
if ([int]$nodeMajor -lt 22) { Warn "Node $(node -v) detected — 22+ is recommended; continuing anyway." }

if (Test-Path (Join-Path $Dir '.git')) {
  Say "Updating existing checkout at $Dir"
  git -C $Dir pull --ff-only
} else {
  Say "Cloning into $Dir"
  git clone --depth 1 $Repo $Dir
}

Set-Location $Dir
Say 'Installing dependencies…'
npm install --no-audit --no-fund

Say 'Starting the setup wizard…'
npm run setup
