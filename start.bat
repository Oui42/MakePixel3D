@echo off
rem Starts MakePixel3D in its own window, without a console (pythonw.exe). This console window closes immediately.
rem More convenient: the "MakePixel3D" shortcut (created by the installer, install.bat or tools\create_shortcut.bat).
rem Startup problems? start-debug.bat shows messages in a console; the log is in logs\makepixel3d.log
rem (or %LOCALAPPDATA%\MakePixel3D\logs when the program is installed in Program Files).
cd /d "%~dp0"
if not exist .venv\Scripts\pythonw.exe (echo Run install.bat first & pause & exit /b 1)
set HF_HUB_DISABLE_SYMLINKS_WARNING=1
set PYTHONIOENCODING=utf-8
start "" ".venv\Scripts\pythonw.exe" server\launch.py %*
