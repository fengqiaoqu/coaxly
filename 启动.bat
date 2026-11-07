@echo off
chcp 65001 >nul
title Learn Buddy Proxy
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0proxy\server.ps1"
echo.
echo Proxy stopped. Press any key to close this window.
pause >nul
