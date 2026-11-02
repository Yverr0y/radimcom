@echo off
rem Sprievodca prvotnou konfiguraciou kluceniek (priradenie k VFO, seriove cisla v EEPROM).
cd /d "%~dp0"
set "PY=python"
if exist ".venv\Scripts\python.exe" set "PY=.venv\Scripts\python.exe"
"%PY%" setup_sdr.py
