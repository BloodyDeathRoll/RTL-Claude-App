@echo off
REM Top-level build script for claude-rtl-fix-desktop.
REM
REM Run this on a Windows machine with:
REM   - Node 22+ on PATH
REM   - Inno Setup 6 installed at "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
REM     (or override via the ISCC env var)
REM
REM Output: installer\windows\Output\ClaudeRTLFix-Setup.exe

setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo === claude-rtl-fix build pipeline ===
echo.

REM 1) Check prerequisites
where node >nul 2>nul
if errorlevel 1 (
    echo [error] Node not found on PATH.
    echo         Install Node 22+ from https://nodejs.org/
    exit /b 1
)

if "%ISCC%"=="" set ISCC=C:\Program Files (x86)\Inno Setup 6\ISCC.exe
if not exist "%ISCC%" (
    echo [error] Inno Setup not found at "%ISCC%".
    echo         Install Inno Setup 6 from https://jrsoftware.org/isinfo.php
    echo         or set the ISCC environment variable to its ISCC.exe path.
    exit /b 1
)

echo [check] node:       OK
echo [check] Inno Setup: OK
echo.

REM 2) Bundle the patcher JS
cd patcher

if not exist node_modules (
    echo [step 1/4] installing patcher npm deps...
    call npm install --no-fund --no-audit
    if errorlevel 1 exit /b 1
) else (
    echo [step 1/4] npm deps already present, skipping install.
)

echo.
echo [step 2/4] bundling patcher...
call node build.js
if errorlevel 1 exit /b 1

echo.
echo [step 3/4] sealing patcher into claude-rtl-patch.exe...
call build-windows.cmd
if errorlevel 1 exit /b 1

cd ..

REM 3) Compile the installer
echo.
echo [step 4/4] compiling installer with Inno Setup...
"%ISCC%" /Qp installer\windows\installer.iss
if errorlevel 1 exit /b 1

echo.
echo === Build complete ===
echo.
for %%F in (installer\windows\Output\ClaudeRTLFix-Setup.exe) do (
    echo Output: %%~fF
    echo   size: %%~zF bytes
)
echo.
echo Ship this single .exe to end users. They double-click it, accept the UAC
echo prompt, and the patch is installed plus the background watcher is set up.
echo.

endlocal
