[CmdletBinding()]
param(
  [string]$RepositoryRoot,
  [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
  $RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $RepositoryRoot 'outputs'
}
$extensionRoot = Join-Path $RepositoryRoot 'wechatsync-source\Wechatsync-2\packages\extension'
$extensionDist = Join-Path $extensionRoot 'dist'
$serviceRoot = Join-Path $RepositoryRoot 'yizao-sync-service'
$guidePath = Join-Path $RepositoryRoot 'outputs\stage3-zhihu-local-acceptance-guide.md'
$packageName = 'publish-assistant-stage3-zhihu-acceptance'
$outputZip = Join-Path $OutputDirectory "$packageName.zip"
$outputHash = "$outputZip.sha256"

foreach ($required in @(
  (Join-Path $extensionDist 'manifest.json'),
  (Join-Path $serviceRoot 'server.mjs'),
  $guidePath
)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Missing acceptance package input: $required. Run npm run build in the Extension directory first."
  }
}

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempRoot = Join-Path $tempBase ("yizao-stage3-acceptance-" + [guid]::NewGuid().ToString('N'))
$stageRoot = Join-Path $tempRoot $packageName
$extensionZip = Join-Path $stageRoot 'extension-dist.zip'
$serviceTarget = Join-Path $stageRoot 'local-service'

try {
  New-Item -ItemType Directory -Path $stageRoot, $serviceTarget -Force | Out-Null

  $extensionStage = Join-Path $tempRoot 'extension-dist'
  New-Item -ItemType Directory -Path $extensionStage -Force | Out-Null
  Get-ChildItem -LiteralPath $extensionDist -Force |
    Where-Object { $_.Name -ne '.vite' } |
    Copy-Item -Destination $extensionStage -Recurse -Force
  Compress-Archive -Path (Join-Path $extensionStage '*') -DestinationPath $extensionZip -CompressionLevel Optimal

  foreach ($name in @('domain', 'lib', 'platforms', 'repositories', 'routes', 'services')) {
    Copy-Item -LiteralPath (Join-Path $serviceRoot $name) -Destination $serviceTarget -Recurse -Force
  }
  Copy-Item -LiteralPath (Join-Path $serviceRoot 'server.mjs') -Destination $serviceTarget
  Copy-Item -LiteralPath (Join-Path $serviceRoot 'package.json') -Destination $serviceTarget
  Copy-Item -LiteralPath (Join-Path $serviceRoot 'README.md') -Destination $serviceTarget
  Copy-Item -LiteralPath $guidePath -Destination (Join-Path $stageRoot 'README.md')

  @'
@echo off
setlocal
cd /d "%~dp0local-service"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 18.17 or newer is required.
  pause
  exit /b 1
)
echo Starting Yizao local service on http://127.0.0.1:8788 ...
echo The first-run pairing token is stored only in local-service\data and is not included in this package.
node server.mjs
if errorlevel 1 pause
'@ | Set-Content -LiteralPath (Join-Path $stageRoot 'start-local-service.cmd') -Encoding ascii

  $forbidden = Get-ChildItem -LiteralPath $stageRoot -Recurse -Force | Where-Object {
    $_.FullName -match '(?i)(\\|/)(data|node_modules|\.git|profile)(\\|/|$)' -or
    $_.Name -match '(?i)(^token$|\.xlsx?$|\.log$|\.env(?:\.|$))'
  }
  if ($forbidden) {
    throw "Acceptance package contains forbidden files: $($forbidden.FullName -join ', ')"
  }

  $innerHash = (Get-FileHash -LiteralPath $extensionZip -Algorithm SHA256).Hash.ToLowerInvariant()
  @(
    "extension-dist.zip  SHA256  $innerHash",
    'local-service       Source   Stage 3 guarded Zhihu draft service; no data/token included',
    'start-local-service.cmd       Starts only the packaged local service'
  ) | Set-Content -LiteralPath (Join-Path $stageRoot 'PACKAGE-MANIFEST.txt') -Encoding utf8

  New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
  if (Test-Path -LiteralPath $outputZip) { Remove-Item -LiteralPath $outputZip -Force }
  if (Test-Path -LiteralPath $outputHash) { Remove-Item -LiteralPath $outputHash -Force }
  Compress-Archive -LiteralPath $stageRoot -DestinationPath $outputZip -CompressionLevel Optimal
  $hash = (Get-FileHash -LiteralPath $outputZip -Algorithm SHA256).Hash.ToLowerInvariant()
  "$hash  $packageName.zip" | Set-Content -LiteralPath $outputHash -Encoding ascii
  Write-Output "Created: $outputZip"
  Write-Output "SHA256: $hash"
}
finally {
  $resolvedTemp = [IO.Path]::GetFullPath($tempRoot)
  if ($resolvedTemp.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and
      [IO.Path]::GetFileName($resolvedTemp).StartsWith('yizao-stage3-acceptance-', [StringComparison]::Ordinal)) {
    Remove-Item -LiteralPath $resolvedTemp -Recurse -Force -ErrorAction SilentlyContinue
  }
}
