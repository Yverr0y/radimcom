@echo off
rem Spustenie prijimaca; po chvili otvori stranku v prehliadaci.
cd /d "%~dp0"
set "PY=python"
if exist ".venv\Scripts\python.exe" set "PY=.venv\Scripts\python.exe"
start "" /min cmd /c "timeout /t 10 /nobreak >nul & start http://localhost:8434"
"%PY%" app.py
pause
