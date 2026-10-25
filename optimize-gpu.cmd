@echo off
setlocal
title Chanakya AI - automatic hardware inspection
cd /d "%~dp0" || exit /b 1

set "CHANAKYA_HARDWARE_NODE="
if defined CHANAKYA_NODE_EXE if exist "%CHANAKYA_NODE_EXE%" set "CHANAKYA_HARDWARE_NODE=%CHANAKYA_NODE_EXE%"
if not defined CHANAKYA_HARDWARE_NODE for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined CHANAKYA_HARDWARE_NODE set "CHANAKYA_HARDWARE_NODE=%%N"
if not defined CHANAKYA_HARDWARE_NODE if exist "%ProgramFiles%\nodejs\node.exe" set "CHANAKYA_HARDWARE_NODE=%ProgramFiles%\nodejs\node.exe"
if not defined CHANAKYA_HARDWARE_NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "CHANAKYA_HARDWARE_NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined CHANAKYA_HARDWARE_NODE if exist "%~dp0runtime\node.exe" set "CHANAKYA_HARDWARE_NODE=%~dp0runtime\node.exe"
if not defined CHANAKYA_HARDWARE_NODE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "CHANAKYA_HARDWARE_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined CHANAKYA_HARDWARE_NODE (
  echo [X] Node.js was not found. Install Node.js 20 or newer to inspect this source checkout.
  if /i not "%~1"=="--no-pause" pause
  exit /b 1
)

"%CHANAKYA_HARDWARE_NODE%" "%~dp0backend\scripts\hardware-info.mjs" %*
set "CHANAKYA_HARDWARE_RESULT=%ERRORLEVEL%"
if /i not "%~1"=="--no-pause" if /i not "%~1"=="--json" pause
exit /b %CHANAKYA_HARDWARE_RESULT%
