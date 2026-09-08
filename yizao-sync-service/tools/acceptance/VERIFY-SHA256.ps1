[CmdletBinding()]
param([switch]$NoPause)

$ErrorActionPreference = 'Stop'
$packageRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifest = Join-Path $packageRoot 'PACKAGE-SHA256.txt'
if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
  Write-Host '[错误 20] 验收包缺少 PACKAGE-SHA256.txt。' -ForegroundColor Red
  if (-not $NoPause) { Read-Host '按 Enter 键关闭' | Out-Null }
  exit 20
}

$failed = @()
function Get-Sha256Hex([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  try {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
  }
  finally { $stream.Dispose() }
}
foreach ($line in Get-Content -LiteralPath $manifest) {
  if (-not $line.Trim()) { continue }
  if ($line -notmatch '^([0-9a-f]{64})  (.+)$') { $failed += "清单格式错误：$line"; continue }
  $expected = $Matches[1]
  $relative = $Matches[2]
  $target = [IO.Path]::GetFullPath((Join-Path $packageRoot ($relative -replace '/', '\')))
  if (-not $target.StartsWith($packageRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    $failed += "路径越界：$relative"; continue
  }
  if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { $failed += "缺少文件：$relative"; continue }
  $actual = Get-Sha256Hex $target
  if ($actual -ne $expected) { $failed += "校验失败：$relative" }
}

if ($failed.Count) {
  $failed | ForEach-Object { Write-Host "[错误 21] $_" -ForegroundColor Red }
  if (-not $NoPause) { Read-Host '按 Enter 键关闭' | Out-Null }
  exit 21
}
Write-Host 'SHA256 校验通过：验收包内文件完整。' -ForegroundColor Green
if (-not $NoPause) { Read-Host '按 Enter 键关闭' | Out-Null }
exit 0
