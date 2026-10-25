@echo off
call "%~dp0build-exe.cmd" %*
exit /b %errorlevel%
