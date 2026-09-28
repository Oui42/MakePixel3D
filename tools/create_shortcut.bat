@echo off
rem Creates the "MakePixel3D" shortcut (with icon, no console) in the program folder and on the desktop.
rem Usage: tools\create_shortcut.bat           (program folder + desktop)
rem        tools\create_shortcut.bat nodesktop (program folder only)
setlocal
cd /d "%~dp0.."
set "APPDIR=%CD%"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$w = New-Object -ComObject WScript.Shell;" ^
  "$targets = @('%APPDIR%\MakePixel3D.lnk');" ^
  "if ('%~1' -ne 'nodesktop') { $targets += (Join-Path ([Environment]::GetFolderPath('Desktop')) 'MakePixel3D.lnk') };" ^
  "foreach ($t in $targets) { $s = $w.CreateShortcut($t);" ^
  "  $s.TargetPath = '%APPDIR%\.venv\Scripts\pythonw.exe';" ^
  "  $s.Arguments = 'server\launch.py';" ^
  "  $s.WorkingDirectory = '%APPDIR%';" ^
  "  $s.IconLocation = '%APPDIR%\assets\makepixel3d.ico,0';" ^
  "  $s.Description = 'MakePixel3D - photo to 3D pixel art';" ^
  "  $s.Save(); Write-Host ('Created shortcut: ' + $t) }"
