@echo off
rem Sprawdza ten komputer: zrzut ekranu, OCR, UI Automation, analiza pikseli, serwer MCP
cd /d "%~dp0"
node src\cli.js selftest
pause
