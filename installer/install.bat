@echo off
rem Installation of the RADIMCOM receiver on a new PC:
rem Python packages into .venv, drivers (Zadig, FTDI D3XX), dongle configuration and a desktop shortcut.
setlocal
cd /d "%~dp0"
title RADIMCOM - installation
echo ============================================
echo   RADIMCOM receiver - installation
echo ============================================
echo.

rem ---- 1. Python 3.9+ ----
set "PY="
py -3 -c "import sys; sys.exit(sys.version_info < (3, 9))" >nul 2>nul && set "PY=py -3"
if not defined PY python -c "import sys; sys.exit(sys.version_info < (3, 9))" >nul 2>nul && set "PY=python"
if not defined PY (
  echo Python 3.9 or newer was not found.
  echo Install it from https://www.python.org/downloads/windows/
  echo and tick "Add python.exe to PATH" in the installer. Then run install.bat again.
  start "" https://www.python.org/downloads/windows/
  pause
  exit /b 1
)
for /f "delims=" %%v in ('%PY% --version') do echo [1/5] %%v found

rem ---- 2. virtual environment and packages ----
echo [2/5] Installing Python packages (needs internet, about 60 MB - may take a few minutes)...
rem python.exe in .venv is only a launcher: it exists even when the Python it points to (pyvenv.cfg) is gone,
rem e.g. .venv from an earlier attempt or a removed Python - so it has to be run, not just looked for.
set "VENV_OK="
if exist ".venv\Scripts\python.exe" ".venv\Scripts\python.exe" -c "import pip" >nul 2>nul && set "VENV_OK=1"
if not defined VENV_OK if exist ".venv" (
  echo    The existing .venv does not work, creating it again...
  rmdir /s /q ".venv"
)
if not defined VENV_OK %PY% -m venv .venv
if errorlevel 1 (echo Could not create .venv & pause & exit /b 1)
".venv\Scripts\python.exe" -c "import pip" >nul 2>nul
if errorlevel 1 (
  echo.
  echo .venv was created but it does not start. This is a problem with the Python installation, not with the internet.
  echo Python used:
  %PY% -c "import sys; print('  ', sys.executable); print('  ', sys._base_executable)"
  echo .venv points to:
  type ".venv\pyvenv.cfg"
  echo.
  echo Try to run install.bat without "Run as administrator". If it does not help, install Python
  echo from https://www.python.org/downloads/windows/ with "Add python.exe to PATH" and run install.bat again.
  pause
  exit /b 1
)
rem no -q: on a slow internet connection the download progress is visible
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check --only-binary=numpy,scipy,lameenc -r requirements.txt
if errorlevel 1 (echo Package installation failed - check the internet connection. & pause & exit /b 1)
rem PyFT8 is only for the FT8 decoder; if it fails, the receiver works without it.
rem --no-deps: PyAudio (sound card) is not needed and has no ready package for new Python versions
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check --no-deps PyFT8
if errorlevel 1 echo    (PyFT8 not installed - the FT8 decoder will not be available)
echo    OK

rem ---- 3. drivers ----
echo.
echo [3/5] USB drivers
echo    RTL-SDR dongles need the WinUSB driver (installed with Zadig).
echo    In Zadig: Options - List All Devices, select "Bulk-In, Interface (Interface 0)"
echo    (or "RTL2838UHIDIR"), driver WinUSB, click Replace Driver. Repeat for every dongle.
choice /c YN /m "   Run Zadig now (RTL-SDR)"
if not errorlevel 2 start "" /wait "drivers\zadig.exe"
echo.
echo    LimeSDR Mini needs the FTDI D3XX driver.
choice /c YN /m "   Install the FTDI D3XX driver now (LimeSDR)"
if not errorlevel 2 start "" /wait "drivers\FTD3XXDriver_WHQLCertified_v1.3.0.4_Installer.exe"

rem ---- 4. dongle configuration ----
echo.
echo [4/5] SDR setup: connect all dongles (and the LimeSDR) now.
choice /c YN /m "   Run the SDR setup now"
if not errorlevel 2 ".venv\Scripts\python.exe" setup_sdr.py --no-start

rem ---- 5. desktop shortcut ----
echo.
echo [5/5] Creating desktop shortcuts...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$w = New-Object -ComObject WScript.Shell; $d = [Environment]::GetFolderPath('Desktop');" ^
  "$s = $w.CreateShortcut(\"$d\RADIMCOM.lnk\"); $s.TargetPath = '%~dp0start.bat'; $s.WorkingDirectory = '%~dp0'; $s.IconLocation = 'shell32.dll,138'; $s.Save();" ^
  "$s = $w.CreateShortcut(\"$d\RADIMCOM SDR setup.lnk\"); $s.TargetPath = '%~dp0setup.bat'; $s.WorkingDirectory = '%~dp0'; $s.IconLocation = 'shell32.dll,21'; $s.Save()"
echo.
echo Done. Start the receiver with the RADIMCOM shortcut (or start.bat);
echo the page opens at http://localhost:8434
echo Dongles can be configured again any time with setup.bat.
echo Optional, for the DSD mode (digital voice): run install_dsd.bat, it downloads the decoder.
echo.
choice /c YN /m "Start the receiver now"
if not errorlevel 2 start "RADIMCOM" "%~dp0start.bat"
