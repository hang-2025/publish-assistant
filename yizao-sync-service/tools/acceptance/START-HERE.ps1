[CmdletBinding()]
param(
  [string]$NodeCommand = 'node',
  [int]$Port = 8788,
  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'

function Stop-WithMessage([int]$Code, [string]$Message) {
  Write-Host "[错误 $Code] $Message" -ForegroundColor Red
  if (-not $NoPause) { Read-Host '按 Enter 键关闭' | Out-Null }
  exit $Code
}

$node = Get-Command -Name $NodeCommand -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) { Stop-WithMessage 10 '未找到 Node.js。请安装 Node.js 18.17 或更高版本后重试。' }

try {
  $nodeVersion = (& $node.Source -p "process.versions.node").Trim()
  $parts = @($nodeVersion.Split('.') | ForEach-Object { [int]$_ })
  if ($parts.Count -lt 2 -or $parts[0] -lt 18 -or ($parts[0] -eq 18 -and $parts[1] -lt 17)) {
    Stop-WithMessage 11 "Node.js 版本过低（当前 $nodeVersion，需要 18.17 或更高版本）。"
  }
} catch {
  Stop-WithMessage 11 '无法读取 Node.js 版本。请重新安装 Node.js 18.17 或更高版本。'
}

$client = New-Object Net.Sockets.TcpClient
try {
  $connect = $client.ConnectAsync('127.0.0.1', $Port)
  if ($connect.Wait(500) -and $client.Connected) {
    Stop-WithMessage 12 "端口 $Port 已被占用。请关闭占用该端口的程序后重试；本脚本不会接管已有服务。"
  }
} catch { } finally { $client.Dispose() }

$packageRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$serviceRoot = Join-Path $packageRoot 'local-service'
$serverPath = Join-Path $serviceRoot 'server.mjs'
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
  Stop-WithMessage 13 '验收包不完整：缺少 local-service/server.mjs。请重新下载并校验验收包。'
}

Write-Host "正在启动本地服务：http://127.0.0.1:$Port" -ForegroundColor Cyan
try {
  $service = Start-Process -FilePath $node.Source -ArgumentList @('server.mjs', '--port', "$Port") -WorkingDirectory $serviceRoot -PassThru
} catch {
  Stop-WithMessage 13 "本地服务启动失败：$($_.Exception.Message)"
}

$health = $null
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  if ($service.HasExited) { Stop-WithMessage 13 "本地服务提前退出，退出码 $($service.ExitCode)。请查看服务窗口中的错误。" }
  try {
    $health = Invoke-RestMethod -Method Get -TimeoutSec 2 -Uri "http://127.0.0.1:$Port/api/health"
    if ($health.ok -eq $true) { break }
  } catch { }
  Start-Sleep -Milliseconds 500
}
if (-not $health -or $health.ok -ne $true) {
  Stop-WithMessage 14 '本地服务启动后健康检查超时。请关闭服务窗口，确认安全软件未拦截 127.0.0.1 后重试。'
}

Write-Host ''
Write-Host '本地服务已就绪。接下来：' -ForegroundColor Green
Write-Host '1. 打开 chrome://extensions 并开启开发者模式。'
Write-Host '2. 选择“加载已解压的扩展程序”，加载本目录的 extension-dist。'
Write-Host '3. 打开扩展 Workbench，完成 Stage 3 验收前自检。'
Write-Host ''
Write-Host '令牌只需从服务窗口粘贴到 Workbench；不要复制或提交 Cookie、Profile、密码或验证码。'
Write-Host '公开发布、Excel 写入、文件移动/删除和真实归档仍保持禁用。'
if (-not $NoPause) { Read-Host '按 Enter 键关闭本提示窗口（本地服务窗口会继续运行）' | Out-Null }
exit 0
