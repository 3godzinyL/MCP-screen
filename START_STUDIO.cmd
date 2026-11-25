@echo off
rem MPC Studio - program do pokazu (stara wersja reczna vs nowa AI przez MCP)
cd /d "%~dp0"
if not exist node_modules (
  echo Instaluje zaleznosci...
  call npm install
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0src\studio\main.js" %*
