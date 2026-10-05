@echo off
echo Starting NovaNotes server...
cd /d "%~dp0"
:: Open the app once the server is up
start "" cmd /c "timeout /t 1 >nul & start http://localhost:4000"
node server.js
