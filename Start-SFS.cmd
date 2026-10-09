@echo off
setlocal
call "%~dp0sfs.cmd" gui %*
if errorlevel 1 pause
