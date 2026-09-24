$ErrorActionPreference = 'Stop'

$startupDir = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupDir 'Yizao Publish Assistant Service.lnk'

if (Test-Path -LiteralPath $shortcutPath) {
  Remove-Item -LiteralPath $shortcutPath -Force
  Write-Host 'AUTO-START REMOVED.' -ForegroundColor Green
} else {
  Write-Host 'AUTO-START WAS NOT INSTALLED.'
}
