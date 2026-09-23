$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$extensionDir = Join-Path $repositoryRoot 'wechatsync-source\Wechatsync-2\packages\extension'
$serviceDir = Join-Path $repositoryRoot 'yizao-sync-service'

Write-Host '[1/6] Verify unified release version'
node (Join-Path $repositoryRoot 'tools\sync-release-version.mjs') --check

Push-Location $extensionDir
try {
  Write-Host '[2/6] Run extension tests'
  npm test
  Write-Host '[3/6] Type-check extension'
  npm run typecheck
  Write-Host '[4/6] Build extension'
  npm run build
  Write-Host '[5/6] Verify extension security boundary'
  node tests/security-static.mjs
} finally {
  Pop-Location
}

if (-not (Test-Path (Join-Path $extensionDir 'dist\LICENSE'))) { throw 'The build is missing LICENSE' }
if (-not (Test-Path (Join-Path $extensionDir 'dist\NOTICE'))) { throw 'The build is missing NOTICE' }

Push-Location $serviceDir
try {
  Write-Host '[6/6] Run local service tests'
  npm test
} finally {
  Pop-Location
}

Write-Host 'QUALITY GATE PASSED. The branch is ready for review and commit.' -ForegroundColor Green
