@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js，请先安装 Node.js 18.17 或更高版本。
  pause
  exit /b 1
)

node tools\launcher.mjs
if errorlevel 1 pause
