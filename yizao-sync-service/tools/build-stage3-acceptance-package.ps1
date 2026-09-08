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

$extensionDist = Join-Path $RepositoryRoot 'wechatsync-source\Wechatsync-2\packages\extension\dist'
$serviceRoot = Join-Path $RepositoryRoot 'yizao-sync-service'
$guidePath = Join-Path $RepositoryRoot 'outputs\stage3-zhihu-local-acceptance-guide.md'
$acceptanceTools = Join-Path $serviceRoot 'tools\acceptance'
$packageName = 'publish-assistant-stage3-zhihu-html-fidelity-v3.1'
$outputZip = Join-Path $OutputDirectory "$packageName.zip"
$outputHash = "$outputZip.sha256"
$readmeName = 'README-' + [string][char]0x9A8C + [string][char]0x6536 + '.md'

foreach ($required in @(
  (Join-Path $extensionDist 'manifest.json'),
  (Join-Path $serviceRoot 'server.mjs'),
  $guidePath,
  (Join-Path $acceptanceTools 'START-HERE.ps1'),
  (Join-Path $acceptanceTools 'VERIFY-SHA256.ps1')
)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Missing acceptance package input: $required. Run npm run build in the Extension directory first."
  }
}

function Copy-Utf8Bom([string]$Source, [string]$Destination) {
  $content = [IO.File]::ReadAllText($Source, [Text.Encoding]::UTF8)
  [IO.File]::WriteAllText($Destination, $content, (New-Object Text.UTF8Encoding($true)))
}

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempRoot = Join-Path $tempBase ("yizao-stage3-acceptance-" + [guid]::NewGuid().ToString('N'))
$stageRoot = Join-Path $tempRoot $packageName
$extensionTarget = Join-Path $stageRoot 'extension-dist'
$serviceTarget = Join-Path $stageRoot 'local-service'
$toolsTarget = Join-Path $stageRoot 'tools'

try {
  New-Item -ItemType Directory -Path $stageRoot, $extensionTarget, $serviceTarget, $toolsTarget -Force | Out-Null

  Get-ChildItem -LiteralPath $extensionDist -Force |
    Where-Object { $_.Name -ne '.vite' } |
    Copy-Item -Destination $extensionTarget -Recurse -Force

  foreach ($name in @('domain', 'lib', 'platforms', 'repositories', 'routes', 'services')) {
    Copy-Item -LiteralPath (Join-Path $serviceRoot $name) -Destination $serviceTarget -Recurse -Force
  }
  foreach ($name in @('server.mjs', 'package.json', 'README.md')) {
    Copy-Item -LiteralPath (Join-Path $serviceRoot $name) -Destination $serviceTarget
  }
  Copy-Item -LiteralPath $guidePath -Destination (Join-Path $stageRoot $readmeName)
  Copy-Utf8Bom (Join-Path $acceptanceTools 'START-HERE.ps1') (Join-Path $toolsTarget 'START-HERE.ps1')
  Copy-Utf8Bom (Join-Path $acceptanceTools 'VERIFY-SHA256.ps1') (Join-Path $toolsTarget 'VERIFY-SHA256.ps1')

  @'
@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\START-HERE.ps1"
exit /b %errorlevel%
'@ | Set-Content -LiteralPath (Join-Path $stageRoot 'START-HERE.cmd') -Encoding ascii
  @'
@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\VERIFY-SHA256.ps1" %*
exit /b %errorlevel%
'@ | Set-Content -LiteralPath (Join-Path $stageRoot 'VERIFY-SHA256.cmd') -Encoding ascii

  $forbidden = Get-ChildItem -LiteralPath $stageRoot -Recurse -Force | Where-Object {
    $_.FullName -match '(?i)(\\|/)(data|node_modules|\.git|profile)(\\|/|$)' -or
    $_.Name -match '(?i)(^token$|\.xlsx?$|\.xls$|\.docx$|\.log$|\.env(?:\.|$))'
  }
  if ($forbidden) { throw "Acceptance package contains forbidden files: $($forbidden.FullName -join ', ')" }

  $hashLines = Get-ChildItem -LiteralPath $stageRoot -Recurse -Force -File |
    Sort-Object FullName |
    ForEach-Object {
      $relative = $_.FullName.Substring($stageRoot.Length + 1).Replace('\', '/')
      $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      "$hash  $relative"
    }
  [IO.File]::WriteAllLines(
    (Join-Path $stageRoot 'PACKAGE-SHA256.txt'),
    [string[]]$hashLines,
    (New-Object Text.UTF8Encoding($true))
  )

  New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
  if (Test-Path -LiteralPath $outputZip) { Remove-Item -LiteralPath $outputZip -Force }
  if (Test-Path -LiteralPath $outputHash) { Remove-Item -LiteralPath $outputHash -Force }
  Compress-Archive -LiteralPath $stageRoot -DestinationPath $outputZip -CompressionLevel Optimal
  $outerHash = (Get-FileHash -LiteralPath $outputZip -Algorithm SHA256).Hash.ToLowerInvariant()
  "$outerHash  $packageName.zip" | Set-Content -LiteralPath $outputHash -Encoding ascii
  Write-Output "Created: $outputZip"
  Write-Output "SHA256: $outerHash"
}
finally {
  $resolvedTemp = [IO.Path]::GetFullPath($tempRoot)
  if ($resolvedTemp.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and
      [IO.Path]::GetFileName($resolvedTemp).StartsWith('yizao-stage3-acceptance-', [StringComparison]::Ordinal)) {
    Remove-Item -LiteralPath $resolvedTemp -Recurse -Force -ErrorAction SilentlyContinue
  }
}
