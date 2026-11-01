[CmdletBinding()]
param(
    [string]$SourceDir = (Join-Path $PSScriptRoot '.source-cache/source'),
    [string]$TargetDir = (Join-Path $PSScriptRoot '.source-cache/target'),
    [string]$OutputDir = (Join-Path $PSScriptRoot 'bin'),
    [string]$ResourcesDir,
    [string]$Toolchain = '1.95.0',
    [ValidateRange(1, 16)][int]$Jobs = 2,
    [switch]$PrepareOnly,
    [switch]$RunTests
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
    throw 'This sidecar build supports Windows x64.'
}
$lock = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'source.json') -Raw | ConvertFrom-Json
$patchPath = Join-Path $PSScriptRoot 'sample-effort.patch'
$SourceDir = [IO.Path]::GetFullPath($SourceDir)
$TargetDir = [IO.Path]::GetFullPath($TargetDir)
$OutputDir = [IO.Path]::GetFullPath($OutputDir)

function Invoke-Git {
    & git -C $SourceDir @args
    if ($LASTEXITCODE -ne 0) { throw "git failed ($LASTEXITCODE): $args" }
}

function Assert-Hash([string]$Path, [string]$Expected) {
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Expected) { throw "Hash mismatch: $Path" }
}

if (-not (Test-Path -LiteralPath (Join-Path $SourceDir '.git'))) {
    New-Item -ItemType Directory -Path $SourceDir -Force | Out-Null
    Invoke-Git init
    Invoke-Git config core.longpaths true
    Invoke-Git remote add origin $lock.upstream.repository
    Invoke-Git fetch --depth 1 origin $lock.upstream.commit
    Invoke-Git checkout --detach $lock.upstream.commit
}
$head = (Invoke-Git rev-parse HEAD).Trim()
if ($head -ne $lock.upstream.commit) { throw "Source must be at $($lock.upstream.commit), got $head" }
& git -C $SourceDir apply --reverse --check $patchPath 2>$null
if ($LASTEXITCODE -ne 0) {
    if (Invoke-Git status --porcelain) { throw 'Source has unrelated changes; use a clean pinned checkout.' }
    Invoke-Git apply --check $patchPath
    Invoke-Git apply $patchPath
}
$actualPatch = (@(Invoke-Git diff --binary --full-index --no-color --no-ext-diff -- . ':(exclude)codex-rs/Cargo.lock') -join "`n").TrimEnd()
$expectedPatch = ([IO.File]::ReadAllText($patchPath) -replace "`r`n", "`n").TrimEnd()
if ($actualPatch -cne $expectedPatch) { throw 'Source differs from the pinned patch.' }
# The release commit bumps workspace packages but leaves their lock versions at 0.0.0.
# Synchronize local packages only; every external dependency stays exactly pinned.
$upstreamLock = ((Invoke-Git show HEAD:codex-rs/Cargo.lock) -join "`n") + "`n"
$sha = [Security.Cryptography.SHA256]::Create()
function Get-TextHash([string]$Text) {
    [Convert]::ToHexString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))).ToLowerInvariant()
}
if ((Get-TextHash $upstreamLock) -ne $lock.upstreamCargoLockSha256) { throw 'Unexpected upstream Cargo.lock.' }
$normalizedLock = [regex]::Replace($upstreamLock, '(?ms)^\[\[package\]\]\n(?<body>.*?)(?=^\[\[package\]\]|\z)', {
    param($match)
    $block = $match.Value
    if ($block -notmatch '(?m)^source = ' -and $block -notmatch '(?m)^checksum = ') {
        $block = $block.Replace('version = "0.0.0"', ('version = "' + $lock.upstream.version + '"'))
    }
    $block
})
if ((Get-TextHash $normalizedLock) -ne $lock.cargoLockSha256) { throw 'Unexpected normalized Cargo.lock.' }
$cargoLockPath = Join-Path $SourceDir 'codex-rs/Cargo.lock'
$currentLock = [IO.File]::ReadAllText($cargoLockPath) -replace "`r`n", "`n"
if ($currentLock -cne $upstreamLock -and $currentLock -cne $normalizedLock) { throw 'Cargo.lock has unrelated changes.' }
[IO.File]::WriteAllText($cargoLockPath, $normalizedLock, [Text.UTF8Encoding]::new($false))
Invoke-Git diff --check
Write-Host "Prepared Codex $($lock.upstream.version), patch $($lock.patchRevision)."
if ($PrepareOnly) { return }

if (-not $ResourcesDir) {
    $package = Get-ChildItem -LiteralPath (Join-Path $env:ProgramFiles 'WindowsApps') -Directory -Filter "OpenAI.Codex_$($lock.appVersion)_x64__*" |
        Select-Object -First 1
    if (-not $package) { throw "Install Codex $($lock.appVersion), or pass -ResourcesDir." }
    $ResourcesDir = Join-Path $package.FullName 'app/resources'
}
$ResourcesDir = [IO.Path]::GetFullPath($ResourcesDir)
Assert-Hash (Join-Path $ResourcesDir 'codex.exe') $lock.officialCliSha256
Assert-Hash (Join-Path $ResourcesDir 'app.asar') $lock.officialAsarSha256
foreach ($helper in $lock.helpers) {
    Assert-Hash (Join-Path $ResourcesDir $helper.path) $helper.sha256
}

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vsPath = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsPath) { throw 'Visual Studio C++ Build Tools are required.' }
& (Join-Path $vsPath 'Common7/Tools/Launch-VsDevShell.ps1') -Arch amd64 -HostArch amd64 -SkipAutomaticLocation | Out-Null
$cmakeBin = Join-Path $vsPath 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin'
$ninjaBin = Join-Path $vsPath 'Common7/IDE/CommonExtensions/Microsoft/CMake/Ninja'
$gitPath = (Get-Command git).Source
$gitUsrBin = Join-Path (Split-Path (Split-Path $gitPath)) 'usr/bin'
$env:PATH = "$cmakeBin;$ninjaBin;$env:PATH;$gitUsrBin"
$env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = (Get-Command link.exe).Source
if (Test-Path -LiteralPath (Join-Path $gitUsrBin 'perl.exe')) {
    $env:PERL = Join-Path $gitUsrBin 'perl.exe'
}
$env:CARGO_TARGET_DIR = $TargetDir
$env:CARGO_BUILD_JOBS = [string]$Jobs
if (-not ((& rustup toolchain list) -match "^$([regex]::Escape($Toolchain))(-| )")) {
    throw "Install the build toolchain: rustup toolchain install $Toolchain --profile minimal"
}
New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
$workspace = Join-Path $SourceDir 'codex-rs'
Push-Location $workspace
try {
    & cargo "+$Toolchain" build --release --locked -p codex-cli --bin codex 2>&1 |
        Tee-Object -FilePath (Join-Path $TargetDir 'build.log')
    if ($LASTEXITCODE -ne 0) { throw "Codex build failed ($LASTEXITCODE)." }
    if ($RunTests) {
        $filters = @(
            'unsupported_effort_updates_use_sample_effort_without_changing_parent',
            'sample_preserves_effort_baseline',
            'sample_returns_null_for_custom_tool_calls',
            'sample_wait_keeps_parent_responsive_and_reclaims_child'
        )
        foreach ($filter in $filters) {
            & cargo "+$Toolchain" test --release --locked -p codex-app-server --test all $filter -- --test-threads=1 2>&1 |
                Tee-Object -FilePath (Join-Path $TargetDir "test-$filter.log")
            if ($LASTEXITCODE -ne 0) { throw "Sample test failed: $filter" }
        }
    }
} finally {
    Pop-Location
}

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $TargetDir 'release/codex.exe') -Destination (Join-Path $OutputDir 'codex.exe') -Force
foreach ($helper in $lock.helpers) {
    Copy-Item -LiteralPath (Join-Path $ResourcesDir $helper.path) -Destination (Join-Path $OutputDir $helper.path) -Force
}
$licensesDir = Join-Path $OutputDir 'licenses'
New-Item -ItemType Directory -Path $licensesDir -Force | Out-Null
$licenseFiles = @()
foreach ($name in @('LICENSE', 'NOTICE')) {
    $licensePath = Join-Path $SourceDir $name
    if (Test-Path -LiteralPath $licensePath) {
        $relative = "licenses/codex-$name.txt"
        Copy-Item -LiteralPath $licensePath -Destination (Join-Path $OutputDir $relative) -Force
        $licenseFiles += $relative
    }
}
$officialNotices = Join-Path $ResourcesDir 'THIRD_PARTY_NOTICES.txt'
if (Test-Path -LiteralPath $officialNotices) {
    $relative = 'licenses/codex-THIRD_PARTY_NOTICES.txt'
    Copy-Item -LiteralPath $officialNotices -Destination (Join-Path $OutputDir $relative) -Force
    $licenseFiles += $relative
}
$files = foreach ($name in @('codex.exe') + @($lock.helpers.path) + $licenseFiles) {
    [ordered]@{
        path = $name
        sha256 = (Get-FileHash -LiteralPath (Join-Path $OutputDir $name) -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}
$manifest = [ordered]@{
    schemaVersion = 1
    upstream = [ordered]@{ version = $lock.upstream.version; commit = $lock.upstream.commit }
    patchRevision = $lock.patchRevision
    appVersion = $lock.appVersion
    officialCliSha256 = $lock.officialCliSha256
    officialAsarSha256 = $lock.officialAsarSha256
    patchSha256 = (Get-FileHash -LiteralPath $patchPath -Algorithm SHA256).Hash.ToLowerInvariant()
    cargoLockSha256 = $lock.cargoLockSha256
    rustc = (& rustc "+$Toolchain" --version)
    files = @($files)
}
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDir 'manifest.json') -Encoding utf8NoBOM
Write-Host "Built matching Codex sample sidecar: $OutputDir"
