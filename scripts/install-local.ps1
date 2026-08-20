<#
.SYNOPSIS
    Build, package, and install Claude Context Meter locally, then verify it registered.

.DESCRIPTION
    Installing a .vsix while VS Code is running can leave the new version extracted on
    disk but never registered — VS Code keeps running the old one and the install looks
    like it silently did nothing. This script uses --force, verifies the registry
    afterwards, and sweeps the orphaned version folders that accumulate over time.

    Note: VS Code *pins* extensions installed from a .vsix, which disables automatic
    Marketplace updates for it. That is expected for local dev builds.

.PARAMETER SkipBuild
    Install the existing .vsix without recompiling and repackaging.

.PARAMETER KeepOrphans
    Leave stale version folders on disk instead of removing them.

.EXAMPLE
    ./scripts/install-local.ps1
.EXAMPLE
    ./scripts/install-local.ps1 -SkipBuild
#>
[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$KeepOrphans
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ExtensionId = 'kexgev.claude-context-meter'
$RepoRoot    = Split-Path -Parent $PSScriptRoot

function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Message) Write-Host "    $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "    $Message" -ForegroundColor Yellow }

if (-not (Get-Command code -ErrorAction SilentlyContinue)) {
    throw "The 'code' CLI was not found on PATH. In VS Code run: Shell Command: Install 'code' command in PATH"
}

Push-Location $RepoRoot
try {
    $version = (Get-Content package.json -Raw | ConvertFrom-Json).version
    Write-Step "Claude Context Meter $version"

    $vsix = Join-Path $RepoRoot "claude-context-meter-$version.vsix"

    if (-not $SkipBuild) {
        Write-Step 'Compiling and packaging'
        npm run compile
        if ($LASTEXITCODE -ne 0) { throw "npm run compile failed (exit $LASTEXITCODE)" }

        npx vsce package --allow-missing-repository
        if ($LASTEXITCODE -ne 0) { throw "vsce package failed (exit $LASTEXITCODE)" }
        Write-Ok "Packaged $(Split-Path -Leaf $vsix)"
    }

    if (-not (Test-Path $vsix)) {
        throw "VSIX not found at $vsix. Run without -SkipBuild to build it."
    }

    # --force is required: without it, reinstalling the same or an older version is a no-op.
    Write-Step 'Installing'
    code --install-extension $vsix --force
    if ($LASTEXITCODE -ne 0) { throw "code --install-extension failed (exit $LASTEXITCODE)" }

    # Verify against the registry rather than trusting the installer's exit code.
    Write-Step 'Verifying registration'
    $extRoot       = Join-Path $env:USERPROFILE '.vscode\extensions'
    $registryPath  = Join-Path $extRoot 'extensions.json'
    $expectedDir   = "$ExtensionId-$version"

    if (-not (Test-Path $registryPath)) { throw "Extension registry not found at $registryPath" }

    $registry   = Get-Content $registryPath -Raw | ConvertFrom-Json
    $registered = $registry | Where-Object { $_.identifier.id -eq $ExtensionId }

    if (-not $registered) {
        throw "$ExtensionId is not registered with VS Code despite a successful install."
    }
    if ($registered.version -ne $version) {
        throw "Registry reports $($registered.version) but $version was installed. The new version is extracted but not active."
    }
    Write-Ok "Registered version $($registered.version)"

    if (-not $KeepOrphans) {
        Write-Step 'Sweeping stale version folders'
        $keep    = $registry | ForEach-Object { $_.relativeLocation }
        $orphans = Get-ChildItem -Path $extRoot -Directory -Filter "$ExtensionId-*" |
                   Where-Object { $keep -notcontains $_.Name -and $_.Name -ne $expectedDir }

        if ($orphans) {
            foreach ($orphan in $orphans) {
                Remove-Item -Recurse -Force $orphan.FullName
                Write-Ok "Removed $($orphan.Name)"
            }
        } else {
            Write-Ok 'None found'
        }
    }

    if (Get-Process -Name 'Code' -ErrorAction SilentlyContinue) {
        Write-Warn 'VS Code is running. Reload to activate: Ctrl+Shift+P -> Developer: Reload Window'
    }

    Write-Host ''
    Write-Host "Installed $ExtensionId $version" -ForegroundColor Green
}
finally {
    Pop-Location
}
