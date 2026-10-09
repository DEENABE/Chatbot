@echo off
setlocal
title Chanakya AI - build installer
cd /d "%~dp0frontend" || goto :fail

tasklist /FI "IMAGENAME eq Chanakya AI.exe" 2>nul | find /I "Chanakya AI.exe" >nul
if not errorlevel 1 (
  echo [!] Chanakya AI is running. Close it first, then run this again.
  goto :fail
)

echo.
echo [1/1] Clean offline release: backend runtime, vite build, electron-builder --win, package validation...
call npm run electron:release || goto :fail

echo.
echo ============================================================
echo  DONE. See the validated release-desktop directory printed above.
echo  Each build uses a fresh output and preserves previous app data.
echo ============================================================
pause
exit /b 0

:fail
echo.
echo [X] Build stopped. Scroll up for the first error.
pause
exit /b 1
