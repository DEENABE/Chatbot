@echo off
setlocal DisableDelayedExpansion
title Chanakya AI - build installer
cd /d "%~dp0" || exit /b 1

rem A normal Node install, a portable Node path, or the desktop's bundled runtime works.
rem The installed build tools are invoked directly; npm does not have to be on PATH.
set "CHANAKYA_BUILD_NODE="
if defined CHANAKYA_NODE_EXE if exist "%CHANAKYA_NODE_EXE%" set "CHANAKYA_BUILD_NODE=%CHANAKYA_NODE_EXE%"
if not defined CHANAKYA_BUILD_NODE for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined CHANAKYA_BUILD_NODE set "CHANAKYA_BUILD_NODE=%%N"
if not defined CHANAKYA_BUILD_NODE if exist "%ProgramFiles%\nodejs\node.exe" set "CHANAKYA_BUILD_NODE=%ProgramFiles%\nodejs\node.exe"
if not defined CHANAKYA_BUILD_NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "CHANAKYA_BUILD_NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined CHANAKYA_BUILD_NODE if exist "%~dp0runtime\node.exe" set "CHANAKYA_BUILD_NODE=%~dp0runtime\node.exe"
if not defined CHANAKYA_BUILD_NODE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "CHANAKYA_BUILD_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined CHANAKYA_BUILD_NODE goto :missing_node

echo.
"%CHANAKYA_BUILD_NODE%" "%~dp0frontend\scripts\build-release.cjs" %*
set "CHANAKYA_BUILD_RESULT=%errorlevel%"
if not "%CHANAKYA_BUILD_RESULT%"=="0" goto :fail
if /i "%~1"=="--check" exit /b 0

echo.
echo ============================================================
echo  DONE. See the validated release-desktop directory printed above.
echo  Each build uses a fresh output and preserves previous app data.
echo ============================================================
if not defined CHANAKYA_NO_PAUSE pause
exit /b 0

:missing_node
echo [X] Node.js 20 or newer was not found.
echo Install Node.js, reopen this window, and run rebuild.cmd again.
echo A portable installation can also be selected with CHANAKYA_NODE_EXE.
set "CHANAKYA_BUILD_RESULT=1"
:fail
echo.
echo [X] Build stopped. Scroll up for the first error.
if /i "%~1"=="--check" exit /b %CHANAKYA_BUILD_RESULT%
if not defined CHANAKYA_NO_PAUSE pause
exit /b %CHANAKYA_BUILD_RESULT%
