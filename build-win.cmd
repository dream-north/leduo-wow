@echo off
setlocal

cd /d "%~dp0"

echo.
echo [Leduo Wow] Building Windows package...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-win.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
set "SETUP_EXE="

echo.
if not "%EXIT_CODE%"=="0" (
  echo [Leduo Wow] Build failed with exit code %EXIT_CODE%.
  echo Please scroll up to review the error details.
  pause
  exit /b %EXIT_CODE%
)

for /f "delims=" %%F in ('dir /b /o-d "%~dp0dist\leduo-wow-*-setup.exe" 2^>nul') do (
  if not defined SETUP_EXE set "SETUP_EXE=%~dp0dist\%%F"
)

echo [Leduo Wow] Build completed successfully.
if defined SETUP_EXE (
  echo Installer: "%SETUP_EXE%"
)
echo.
pause
exit /b 0
