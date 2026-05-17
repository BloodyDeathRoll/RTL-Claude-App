@echo off
REM Windows-side step of the patcher build.
REM Run this on a Windows machine with Node 22 installed.
REM Assumes you've already run `node build.js` on a *nix box (or here) so that
REM dist\patcher.bundled.js exists.

setlocal enabledelayedexpansion

cd /d "%~dp0"

if not exist dist\patcher.bundled.js (
    echo dist\patcher.bundled.js not found. Run `node build.js` first.
    exit /b 1
)

REM 1) Write the SEA config inside dist\
> dist\sea-config.json (
    echo {
    echo   "main": "patcher.bundled.js",
    echo   "output": "sea-prep.blob",
    echo   "disableExperimentalSEAWarning": true,
    echo   "useSnapshot": false,
    echo   "useCodeCache": false
    echo }
)

REM 2) Generate the SEA blob
echo [build-win] generating SEA blob...
pushd dist
node --experimental-sea-config sea-config.json
if errorlevel 1 (
    popd
    echo SEA blob generation failed.
    exit /b 1
)
popd

REM 3) Copy node.exe to our output
echo [build-win] copying node.exe...
for /f "delims=" %%i in ('where node') do set NODE_EXE=%%i
copy /Y "!NODE_EXE!" dist\claude-rtl-patch.exe >nul
if errorlevel 1 (
    echo Could not copy node.exe.
    exit /b 1
)

REM 4) Inject blob with postject
echo [build-win] postject inject...
call npx --yes postject dist\claude-rtl-patch.exe NODE_SEA_BLOB dist\sea-prep.blob ^
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
if errorlevel 1 (
    echo postject failed.
    exit /b 1
)

echo.
echo [build-win] Done. Output:
dir /b dist\claude-rtl-patch.exe
for %%F in (dist\claude-rtl-patch.exe) do echo   size: %%~zF bytes
echo.
echo Test with:   dist\claude-rtl-patch.exe --help
echo.

endlocal
