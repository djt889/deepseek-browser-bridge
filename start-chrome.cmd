@echo off
rem DeepSeek Browser Bridge - standalone Chrome with CDP debug port.
rem
rem NOTE: in account-pool mode the bridge (node server.mjs) launches every
rem account's Chrome automatically and silently. This script is only for
rem MANUAL single-instance use (e.g. re-login on a specific profile).
rem
rem Default: silent mode - real (headed) Chrome in a window parked off-screen
rem (taskbar icon only). NEVER use --headless here: HeadlessChrome changes the
rem User-Agent and other fingerprints the page's risk-control SDK can see.
rem
rem Usage:
rem   start-chrome.cmd          silent (off-screen) window
rem   start-chrome.cmd show     normal window - use this the FIRST time to log in

set "PROFILE=%LOCALAPPDATA%\dq-bridge-profile"
set "PORT=9222"

set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not defined CHROME (
  echo Chrome not found. Edit this file and set CHROME to your chrome.exe path.
  exit /b 1
)

rem Off-screen by default; "show" puts the window on screen (for first login).
set "POS=--window-position=-32000,-32000"
if /i "%~1"=="show" set "POS=--window-position=60,60"

start "" "%CHROME%" --remote-debugging-port=%PORT% --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check --window-size=1200,900 %POS% "https://chat.deepseek.com/"

echo Chrome started (debug port %PORT%, profile %PROFILE%).
if /i not "%~1"=="show" (
  echo Window is parked off-screen. First login: run "start-chrome.cmd show",
  echo or hover the taskbar icon, right-click the preview -^> Move, then press an arrow key.
)
