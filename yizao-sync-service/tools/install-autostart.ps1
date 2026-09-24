$ErrorActionPreference = 'Stop'

$serviceDir = Split-Path -Parent $PSScriptRoot
$launcherPath = Join-Path $PSScriptRoot 'launcher.mjs'
$nodePath = (Get-Command node -ErrorAction Stop).Source
$startupDir = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupDir 'Yizao Publish Assistant Service.lnk'

if (-not (Test-Path -LiteralPath $launcherPath)) {
  throw "Launcher not found: $launcherPath"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $nodePath
$shortcut.Arguments = "`"$launcherPath`" --service-only"
$shortcut.WorkingDirectory = $serviceDir
$shortcut.WindowStyle = 7
$shortcut.Description = 'Start Yizao Publish Assistant local service after Windows sign-in'
$shortcut.Save()

Write-Host 'AUTO-START INSTALLED.' -ForegroundColor Green
Write-Host $shortcutPath
