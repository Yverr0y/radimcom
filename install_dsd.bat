@echo off
rem Downloads the DSD-FME decoder for the DSD mode (not part of the RADIMCOM package, see install_dsd.py).
cd /d "%~dp0"
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" install_dsd.py
) else (
  python install_dsd.py
)
pause
