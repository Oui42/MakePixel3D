# Builds the installer dist\MakePixel3D-Setup.exe (Inno Setup 6 must be installed: winget install JRSoftware.InnoSetup).
#   powershell -ExecutionPolicy Bypass -File tools\installer\build.ps1 [-Repo Oui42/MakePixel3D]
# The version comes from version.json. The installer does NOT contain the program - it downloads the latest release from
# GitHub (see MakePixel3D.iss), so the release order is: version.json -> release.py -> build.ps1 -> gh_release.ps1.
# The file name is fixed (MakePixel3D-Setup.exe) so the link .../releases/latest/download/MakePixel3D-Setup.exe never changes.
param([string]$Repo = "Oui42/MakePixel3D")
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$version = (Get-Content (Join-Path $root "version.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
$iscc = @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { Write-Host "Inno Setup 6 not found (winget install JRSoftware.InnoSetup)"; exit 1 }
& $iscc "/DAppVersion=$version" "/DRepo=$Repo" "/Qp" (Join-Path $PSScriptRoot "MakePixel3D.iss")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$out = Join-Path $root "dist\MakePixel3D-Setup.exe"
Write-Host "Installer: $out ($([int]((Get-Item $out).Length / 1KB)) KB)"
