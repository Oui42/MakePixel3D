@echo off
rem MakePixel3D installation from source. Usage:  install.bat        (NVIDIA card, e.g. RTX 5070)
rem                                              install.bat cpu    (no NVIDIA card - slower)
rem End users should use the installer (MakePixel3D-Setup.exe from GitHub Releases) instead of this script.
rem Installation REQUIRES the internet: it downloads libraries and AI models (about 1.8 GB). The program cannot work
rem without them, so a missing connection or a failed model download ends the installation with an error.
setlocal
cd /d "%~dp0"

where python >nul 2>nul || (echo Python not found. Install Python 3.11-3.13 from python.org ^(check "Add to PATH"^). & pause & exit /b 1)
where git >nul 2>nul || (echo Git not found. Install Git for Windows from git-scm.com. & pause & exit /b 1)

echo [0/6] Checking the internet connection...
powershell -NoProfile -ExecutionPolicy Bypass -File tools\check_online.ps1
if errorlevel 1 (
  echo.
  echo ERROR: no internet connection or the servers required for installation are unreachable ^(see the list above^).
  echo The installation downloads libraries and AI models - connect to the internet and run install.bat again.
  pause & exit /b 1
)

if not exist .venv (
  echo [1/6] Creating the Python environment...
  python -m venv .venv || (pause & exit /b 1)
)
set PY=.venv\Scripts\python.exe
%PY% -m pip install --upgrade pip

echo [2/6] Installing PyTorch...
if /i "%1"=="cpu" (
  %PY% -m pip install torch --index-url https://download.pytorch.org/whl/cpu || (pause & exit /b 1)
) else (
  rem CUDA 12.8 - required by RTX 50xx cards (Blackwell)
  %PY% -m pip install torch --index-url https://download.pytorch.org/whl/cu128 || (pause & exit /b 1)
)

echo [3/6] Installing libraries...
%PY% -m pip install -r requirements.txt || (pause & exit /b 1)

echo [4/6] Downloading TripoSR (3D model code, MIT license)...
if not exist server\third_party\TripoSR (
  git clone --depth 1 https://github.com/VAST-AI-Research/TripoSR.git server\third_party\TripoSR || (pause & exit /b 1)
)

echo [5/6] Downloading AI models (about 1.8 GB, once; afterwards the program works offline)...
%PY% server\models_setup.py
if errorlevel 1 (
  echo.
  echo ERROR: could not download the AI models - the program cannot work without them.
  echo Check the internet connection and run install.bat again ^(files already downloaded are not downloaded twice^).
  pause & exit /b 1
)

echo [6/6] MakePixel3D shortcut (program folder and desktop)...
call tools\create_shortcut.bat

echo.
echo Done. Start the program with the "MakePixel3D" desktop shortcut (or start.bat).
pause
