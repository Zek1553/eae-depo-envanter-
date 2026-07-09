@echo off
setlocal
cd /d "%~dp0"
if "%PORT%"=="" set PORT=3000
set "BUNDLED_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%BUNDLED_NODE%" (
  "%BUNDLED_NODE%" server.js
) else (
  node server.js
)
pause
