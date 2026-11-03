@echo off
rem Wizard for the first configuration of the dongles (assignment to VFOs, serial numbers in the EEPROM).
cd /d "%~dp0"
set "PY=python"
if exist ".venv\Scripts\python.exe" set "PY=.venv\Scripts\python.exe"
"%PY%" setup_sdr.py
