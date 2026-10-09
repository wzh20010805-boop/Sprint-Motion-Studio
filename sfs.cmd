@echo off
setlocal
set "SFS_BUN=%~dp0..\.runtime\node_modules\@oven\bun-windows-x64\bin\bun.exe"
if not exist "%SFS_BUN%" (
  echo {"schema_version":"1.0","ok":false,"status":"failed","error":{"code":"DEPENDENCY_MISSING","message":"Run scripts/setup_sfs.ps1 first"}}
  exit /b 3
)
"%SFS_BUN%" "%~dp0apps\cli\src\index.ts" %*
exit /b %errorlevel%
