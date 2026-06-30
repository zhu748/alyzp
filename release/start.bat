@echo off
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
echo   i. Install/Update Chromium (for start-plan captcha)
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
if "%choice%"=="i" goto install_chromium
if "%choice%"=="0" exit
goto end

:serve
echo.
echo Starting proxy server...
echo.
echo (If start-plan captcha fails with "Executable doesn't exist",
echo  run option i first to install Chromium.)
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

:install_chromium
echo.
echo ============================================
echo  Installing Chromium for Playwright captcha
echo ============================================
echo.
echo This downloads ~150MB Chromium binary to:
echo   %USERPROFILE%\AppData\Local\ms-playwright\
echo.
echo Required only for start-plan mode. Coding-plan users can skip.
echo.
echo Checking for bun...
where bun >nul 2>&1
if %ERRORLEVEL%==0 (
  echo Found bun, using it to install Chromium...
  bunx playwright install chromium
  goto chromium_done
)
echo Checking for npx...
where npx >nul 2>&1
if %ERRORLEVEL%==0 (
  echo Found npx, using it to install Chromium...
  npx playwright install chromium
  goto chromium_done
)
echo.
echo ERROR: Neither bun nor npx found in PATH.
echo Install Bun from https://bun.sh/ or Node.js from https://nodejs.org/
echo Then re-run this option.
echo.
pause
goto end
:chromium_done
echo.
echo Chromium installed successfully.
echo.
pause
goto end

:end
