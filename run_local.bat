@echo off
REM The WAREXX website (landing page, demo) on THIS computer, online
REM through a Cloudflare Tunnel, with the leads database kept here and the
REM free-trial emails (demo link + login email + password) sent from the
REM mailbox in .env. See frontend\tools\run-local.mjs. Ctrl+C stops it.
cd /d "%~dp0frontend"
if not exist "node_modules" (
  echo ==^> Installing
  call npm ci || exit /b 1
)
node tools\run-local.mjs %*
