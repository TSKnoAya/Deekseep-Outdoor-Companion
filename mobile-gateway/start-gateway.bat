@echo off
rem ===========================================================
rem  DSH Mobile Gateway launcher (ASCII only on purpose)
rem
rem  Why this file has no Chinese text:
rem  cmd.exe parses .bat with the console codepage, while node
rem  prints UTF-8. Mixing them makes one side garbled. So this
rem  launcher stays ASCII and switches the console to UTF-8,
rem  letting node print all the Chinese instructions correctly.
rem ===========================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"
chcp 65001 >nul

echo ============================================
echo   DSH Mobile Gateway
echo ============================================
echo.

rem -- find a usable node -----------------------------------
rem This PC may not have node on PATH (verified: only DSH ships one),
rem so try: PATH -> official install dir -> DSH bundled runtime.
set "NODE="
for %%C in (node.exe) do if not defined NODE if not "%%~$PATH:C"=="" set "NODE=%%~$PATH:C"

if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"

if not defined NODE if exist "D:\deepseek\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" set "NODE=D:\deepseek\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"

if not defined NODE if exist "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" set "NODE=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"

if not defined NODE (
  echo [ERROR] node.exe not found.
  echo   Install Node.js 22+ from https://nodejs.org/
  echo   or make sure DeepSeek Harness is installed ^(its bundled node is reused^).
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('"!NODE!" -v') do set "NODEVER=%%v"
echo node: !NODE!  (!NODEVER!)
echo.

rem -- firewall ------------------------------------------------
rem Inbound 8788 must be allowed or the phone can never connect.
rem Windows blocks inbound by default; adding a rule needs admin,
rem so this raises one UAC prompt (only the first time).
netsh advfirewall firewall show rule name="DSH-Mobile-Gateway-8788" >nul 2>nul
if errorlevel 1 (
  echo Allow inbound TCP 8788 in Windows Firewall ^(one UAC prompt, first run only^)...
  powershell -NoProfile -Command "Start-Process -FilePath netsh -ArgumentList 'advfirewall','firewall','add','rule','name=DSH-Mobile-Gateway-8788','dir=in','action=allow','protocol=TCP','localport=8788','profile=private' -Verb RunAs -WindowStyle Hidden" >nul 2>nul
  ping -n 4 127.0.0.1 >nul
  netsh advfirewall firewall show rule name="DSH-Mobile-Gateway-8788" >nul 2>nul
  if errorlevel 1 (
    echo [WARN] firewall rule not added. If the phone cannot connect,
    echo        right-click start-gateway.bat - Run as administrator once.
  ) else (
    echo firewall rule added.
  )
)
echo.

rem -- start gateway ----------------------------------------
rem  --listen 0.0.0.0:8788  let the phone connect (default is 127.0.0.1 = phone can't)
rem  --pair                 always print a fresh 6-digit pair code (valid 5 min)
echo Starting gateway... keep this window OPEN. Closing it stops the gateway.
echo.
echo --------------------------------------------
"!NODE!" src\main.js --listen 0.0.0.0:8788 --pair
set "EXITCODE=%ERRORLEVEL%"

echo.
echo --------------------------------------------
if not "%EXITCODE%"=="0" (
  echo Gateway exited with code %EXITCODE%. Screenshot the errors above.
) else (
  echo Gateway stopped. Double-click this file to start again.
)
echo.
pause
