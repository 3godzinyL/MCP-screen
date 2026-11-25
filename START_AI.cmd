@echo off
rem Claude Code z podlaczonym serwerem MCP "mpc-ekran" (plik .mcp.json w tym folderze)
cd /d "%~dp0"
if not exist node_modules (
  echo Instaluje zaleznosci...
  call npm install
)
title Claude + MPC Ekran
claude
