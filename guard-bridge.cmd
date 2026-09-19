@echo off
rem Idempotent guard: if the bridge is alive do nothing, else start it detached.
curl -s --max-time 3 http://127.0.0.1:39751/health >nul 2>&1 && exit /b 0
cd /d "%~dp0"
start "" /b cmd /c "node server.mjs >> "%~dp0bridge.log" 2>&1"
