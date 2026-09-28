@echo off
rem MakePixel3D with a visible console - for finding the cause of problems (messages and errors are shown live).
rem start-debug.bat --browser = run the program in the browser (http://127.0.0.1:7860) instead of its own window.
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (echo Run install.bat first & pause & exit /b 1)
set HF_HUB_DISABLE_SYMLINKS_WARNING=1
set PYTHONIOENCODING=utf-8
.venv\Scripts\python.exe server\launch.py %*
pause
