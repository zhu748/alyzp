@echo off
REM v0.0.0.3: Chromium is now bundled in the zip under chromium\ directory.
REM No separate installation needed - just extract and run.
REM
REM We set PLAYWRIGHT_BROWSERS_PATH to point at the bundled chromium\
REM directory so Playwright finds chrome.exe without needing a system
REM install. The captcha-playwright.ts module also auto-detects ./chromium
REM if this env var is missing, but setting it explicitly is faster and
REM works even if the user runs zcode-proxy.exe from a different CWD.

REM Resolve the script's own directory (zip extraction folder).
REM %~dp0 expands to the drive+path of this batch file, with trailing backslash.
set "APP_DIR=%~dp0"
set "PLAYWRIGHT_BROWSERS_PATH=%APP_DIR%chromium"

echo.
echo ============================================
echo          zcode-proxy Manager
echo ============================================
echo.
echo   1. Start proxy server
echo   2. OAuth login (Bigmodel) - Coding Plan
echo   3. OAuth login (Z.AI) - Coding Plan
echo   4. OAuth login (Bigmodel) - Start Plan
echo   5. OAuth login (Z.AI) - Start Plan
echo   6. Import key from ZCode (Bigmodel) - Coding Plan
echo   7. Import key from ZCode (Z.AI) - Coding Plan
echo   8. Import key from ZCode (Bigmodel) - Start Plan
echo   9. Import key from ZCode (Z.AI) - Start Plan
echo   a. Check login status
echo   b. Logout
echo   c. Export credential for Render/cloud deploy
echo   0. Exit
echo.
set /p choice=Select:

if "%choice%"=="1" goto serve
if "%choice%"=="2" goto login_bigmodel_cp
if "%choice%"=="3" goto login_zai_cp
if "%choice%"=="4" goto login_bigmodel_sp
if "%choice%"=="5" goto login_zai_sp
if "%choice%"=="6" goto import_bigmodel_cp
if "%choice%"=="7" goto import_zai_cp
if "%choice%"=="8" goto import_bigmodel_sp
if "%choice%"=="9" goto import_zai_sp
if "%choice%"=="a" goto status
if "%choice%"=="b" goto logout
if "%choice%"=="c" goto export
if "%choice%"=="0" exit
goto end

:serve
echo.
echo Starting proxy server...
echo.
echo (Chromium bundled at: %PLAYWRIGHT_BROWSERS_PATH%)
echo.
zcode-proxy.exe serve config.yaml
pause
goto end

:login_bigmodel_cp
echo.
echo Starting Bigmodel OAuth login (Coding Plan)...
zcode-proxy.exe auth login bigmodel --plan=coding-plan
pause
goto end

:login_zai_cp
echo.
echo Starting Z.AI OAuth login (Coding Plan)...
zcode-proxy.exe auth login zai --plan=coding-plan
pause
goto end

:login_bigmodel_sp
echo.
echo Starting Bigmodel OAuth login (Start Plan)...
zcode-proxy.exe auth login bigmodel --plan=start-plan
pause
goto end

:login_zai_sp
echo.
echo Starting Z.AI OAuth login (Start Plan)...
zcode-proxy.exe auth login zai --plan=start-plan
pause
goto end

:import_bigmodel_cp
echo.
echo Importing key from ZCode (Bigmodel, Coding Plan)...
zcode-proxy.exe auth login bigmodel --import --plan=coding-plan
pause
goto end

:import_zai_cp
echo.
echo Importing key from ZCode (Z.AI, Coding Plan)...
zcode-proxy.exe auth login zai --import --plan=coding-plan
pause
goto end

:import_bigmodel_sp
echo.
echo Importing key from ZCode (Bigmodel, Start Plan)...
zcode-proxy.exe auth login bigmodel --import --plan=start-plan
pause
goto end

:import_zai_sp
echo.
echo Importing key from ZCode (Z.AI, Start Plan)...
zcode-proxy.exe auth login zai --import --plan=start-plan
pause
goto end

:status
echo.
zcode-proxy.exe auth status
pause
goto end

:logout
echo.
zcode-proxy.exe auth logout
pause
goto end

:export
echo.
echo Exporting credential as base64 for ZCODE_OAUTH_CREDENTIAL env var...
echo (Used for Render / Fly.io / K8s deployment in oauth mode)
echo.
zcode-proxy.exe auth export
pause
goto end

:end
