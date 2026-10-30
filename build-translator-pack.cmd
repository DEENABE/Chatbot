@echo off
setlocal
title Chanakya AI - build offline translator pack
cd /d "%~dp0" || goto :fail
echo.
echo Builds a folder with the translator, its own Python and the 3 models, to copy to another PC.
echo Needs about 5 GB free disk. Close the app first so the models are not in use.
echo.
node scripts\build-translator-pack.mjs %*
if errorlevel 1 goto :fail
pause
exit /b 0
:fail
echo.
echo [X] Stopped. Scroll up for the first error.
pause
exit /b 1
