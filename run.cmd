@echo off
setlocal
cd /d "%~dp0"

echo Preparing Agent WebUI...
call npm run restart:prod
if errorlevel 1 (
  echo.
  echo Agent WebUI could not be started. See the error above.
  pause
  exit /b 1
)

echo.
echo Configuring Tailscale HTTPS...
where tailscale >nul 2>nul
if errorlevel 1 (
  echo Tailscale was not found. Local access is still available.
  goto ready
)

tailscale serve --bg http://127.0.0.1:3457
if errorlevel 1 (
  echo Tailscale Serve could not be configured. Local access is still available.
  goto ready
)
set "TAILSCALE_READY=1"

echo.
tailscale serve status

:ready
echo.
echo Agent WebUI local:  http://127.0.0.1:3457/
if defined TAILSCALE_READY (
  echo Agent WebUI HTTPS:  https://lggram.tail6c8b6c.ts.net/
  echo Do not add :3457 to the HTTPS URL.
)
timeout /t 3 /nobreak >nul
