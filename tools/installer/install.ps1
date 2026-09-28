# MakePixel3D "online" installation - run by the installer (Setup.exe built with Inno Setup), but it can also be run by hand:
#
#   powershell -ExecutionPolicy Bypass -File tools\installer\install.ps1 -AppDir "C:\...\MakePixel3D" -Repo "Oui42/MakePixel3D"
#
# What it does (every step skips what is already there - running it again does not download things twice):
#   0. checks the system (64-bit Windows, RAM, free disk space) and the servers it downloads from;
#   1. downloads the LATEST program release from GitHub (latest.json -> ZIP -> SHA-256) and extracts it to AppDir
#      (with -Local it copies the files from the current working copy - for tests without a GitHub release);
#   2. Python 3.12 - uses an installed one or downloads the installer from python.org and installs it;
#   3. the .venv environment + PyTorch (NVIDIA card -> cu128, none -> cpu; -Torch cpu|cu128 forces) + libraries (requirements.txt);
#   4. TripoSR code (ZIP from GitHub - no Git needed) and the AI models (~1.8 GB, server\models_setup.py);
#   5. WebView2 (program window; usually present on Windows 11) and the "MakePixel3D" shortcut.
# Exit code 0 = everything ready; anything else = error (the installer shows a message). The program cannot work
# without the models, so a failed model download is an error too (there is no "success with a warning").
param(
    [Parameter(Mandatory = $true)][string]$AppDir,
    [string]$Repo = "Oui42/MakePixel3D",       # GitHub owner/repository
    [ValidateSet("auto", "cpu", "cu128")][string]$Torch = "auto",
    [switch]$Local,                              # program files from the working copy this script lives in (test without GitHub)
    [switch]$NoDesktopShortcut,
    [string]$StatusFile = ""                     # the wizard reads progress from here: step|total|title|detail (ASCII)
)
$ErrorActionPreference = "Stop"
trap { Write-Host $_.ScriptStackTrace; Fail $_.Exception.Message }
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$PythonVersion = "3.12.10"
$PythonUrl = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-amd64.exe"
$TripoSRUrl = "https://github.com/VAST-AI-Research/TripoSR/archive/refs/heads/main.zip"
$InstantMeshUrl = "https://github.com/TencentARC/InstantMesh/archive/refs/heads/main.zip"   # code for the "better back side" feature
$WebView2Url = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"   # Evergreen Bootstrapper
# The ?nocache=<time> suffix bypasses GitHub's cache: for a few minutes after an asset is replaced (same name),
# "latest/download/latest.json" can still return the OLD file while the ZIP is already new -> false "SHA-256 mismatch".
$NoCache = "?nocache=" + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$ManifestUrl = "https://github.com/$Repo/releases/latest/download/latest.json$NoCache"
$MinFreeGB = 6
$Tmp = Join-Path $env:TEMP "MakePixel3D-setup"
$Steps = 7
$script:Step = 0

# Log of the whole installation (for the user and for bug reports): <AppDir>\logs\install.log
New-Item -ItemType Directory -Force (Join-Path $AppDir "logs") | Out-Null
try { Start-Transcript -Path (Join-Path $AppDir "logs\install.log") -Append | Out-Null } catch {}

$script:Title = ""
function Status($detail) {
    if ($StatusFile) { try { [IO.File]::WriteAllText($StatusFile, "$script:Step|$Steps|$script:Title|$detail") } catch {} }
}
function Step($text) { $script:Step++; $script:Title = "[$script:Step/$Steps] $text"; Write-Host ""; Write-Host $script:Title -ForegroundColor Cyan; Status "" }
function Info($text) { Write-Host "  $text"; Status $text }
function Fail($text) {
    Write-Host ""; Write-Host "ERROR: $text" -ForegroundColor Red
    if ($StatusFile) { try { [IO.File]::WriteAllText($StatusFile, "ERROR|$text") } catch {} }
    try { Stop-Transcript | Out-Null } catch {}
    exit 1
}

function Download($url, $dest, $what) {
    Info "Downloading: $what"
    $req = [Net.HttpWebRequest]::Create($url)
    $req.UserAgent = "MakePixel3D-installer"
    $req.Timeout = 30000
    $resp = $req.GetResponse()
    $total = $resp.ContentLength
    $in = $resp.GetResponseStream()
    $out = [IO.File]::Create($dest)
    try {
        $buf = New-Object byte[] 1048576
        $done = 0; $lastPct = -1
        while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
            $out.Write($buf, 0, $n); $done += $n
            if ($total -gt 0) {
                $pct = [int](100 * $done / $total)
                if ($pct -ne $lastPct -and $pct % 5 -eq 0) {
                    $txt = "$pct% ($([math]::Round($done/1MB,1)) / $([math]::Round($total/1MB,1)) MB)"
                    Write-Host -NoNewline "`r    $txt   "; Status "$what - $txt"; $lastPct = $pct
                }
            }
        }
        Write-Host ""
    } finally { $out.Dispose(); $in.Dispose(); $resp.Close() }
}

function Sha256($path) { (Get-FileHash -Algorithm SHA256 $path).Hash.ToLower() }

function Run($exe, [string[]]$argv, $what) {
    # Runs a program with visible output; a non-zero exit code ends the installation.
    & $exe @argv
    if ($LASTEXITCODE -ne 0) { Fail "$what (exit code $LASTEXITCODE)" }
}

# ---------------------------------------------------------------- 0. system and connection
Step "Checking this computer and the internet connection"
if (-not [Environment]::Is64BitOperatingSystem) { Fail "MakePixel3D requires 64-bit Windows." }
$os = Get-CimInstance Win32_OperatingSystem
$ramGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
Info "Windows $($os.Version), RAM: $ramGB GB"
if ($ramGB -lt 8) { Write-Host "  WARNING: less than 8 GB RAM - generating 3D models may be very slow or fail." -ForegroundColor Yellow }

$gpu = $null
try {
    $nv = Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match "NVIDIA" } | Select-Object -First 1
    if ($nv) { $gpu = $nv.Name }
} catch {}
if ($Torch -eq "auto") { $Torch = if ($gpu) { "cu128" } else { "cpu" } }
if ($gpu) { Info "NVIDIA card: $gpu -> PyTorch $Torch" } else { Info "No NVIDIA card -> PyTorch on the CPU ($Torch)" }

New-Item -ItemType Directory -Force $AppDir | Out-Null
New-Item -ItemType Directory -Force $Tmp | Out-Null
$drive = (Get-Item $AppDir).PSDrive
$freeGB = [math]::Round($drive.Free / 1GB, 1)
$needGB = if ($Torch -eq "cu128") { $MinFreeGB + 3 } else { $MinFreeGB }
Info "Free space on drive $($drive.Name): $freeGB GB (about $needGB GB needed)"
if ($freeGB -lt $needGB) { Fail "Not enough free space on drive $($drive.Name): ($freeGB GB available, about $needGB GB needed)." }

$targets = [ordered]@{
    "program release (github.com)"          = "https://github.com/$Repo/releases/latest"
    "Python (python.org)"                    = "https://www.python.org/ftp/python/"
    "Python libraries (pypi.org)"          = "https://pypi.org/simple/pip/"
    "PyTorch (download.pytorch.org)"         = "https://download.pytorch.org/whl/"
    "background removal model (github.com)"        = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx"
    "TripoSR 3D model (huggingface.co)"      = "https://huggingface.co/stabilityai/TripoSR/resolve/main/config.yaml"
}
if ($Local) { $targets.Remove("program release (github.com)") }
$offline = @()
foreach ($name in $targets.Keys) {
    try {
        Invoke-WebRequest -UseBasicParsing -Method Head -TimeoutSec 20 -Uri $targets[$name] | Out-Null
        Info "OK   $name"
    } catch {
        Info "FAIL $name"
        $offline += $name
    }
}
if ($offline.Count) { Fail "No internet connection or these servers are unreachable: $($offline -join ', '). The installer downloads the program, libraries and AI models (about 4 GB) - connect to the internet and run the installer again." }

# ---------------------------------------------------------------- 1. program files
Step "Program files"
if ($Local) {
    $src = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
    Info "Copying from $src"
    if ($src.TrimEnd('\') -ne $AppDir.TrimEnd('\')) {
        foreach ($d in "server", "web", "tools", "assets") {
            robocopy "$src\$d" "$AppDir\$d" /E /NFL /NDL /NJH /NJS /XD third_party __pycache__ _test | Out-Null
        }
        foreach ($f in "version.json", "requirements.txt", "install.bat", "start.bat", "start-debug.bat", "README.md", "LICENSE.txt") {
            if (Test-Path "$src\$f") { Copy-Item "$src\$f" $AppDir -Force }
        }
    }
} else {
    $manifest = Invoke-RestMethod -Uri $ManifestUrl -Headers @{ "User-Agent" = "MakePixel3D-installer"; "Cache-Control" = "no-cache" } -TimeoutSec 30
    $current = $null
    if (Test-Path "$AppDir\version.json") { try { $current = (Get-Content "$AppDir\version.json" -Raw | ConvertFrom-Json).version } catch {} }
    $have = if ($current) { " (installed: $current)" } else { "" }
    Info "Latest release: $($manifest.version)$have"
    # A new package = a SHA-256 different from the one saved at the last installation (release.sha256). The version
    # number alone is not enough: a release can be re-uploaded with the same number while it is being polished.
    $marker = Join-Path $AppDir "release.sha256"
    $installedSha = if (Test-Path $marker) { (Get-Content $marker -Raw).Trim().ToLower() } else { "" }
    if ($installedSha -eq $manifest.sha256.ToLower() -and (Test-Path "$AppDir\server\launch.py")) {
        Info "Program files are up to date."
    } else {
        $zip = Join-Path $Tmp "MakePixel3D-$($manifest.version).zip"
        if (-not (Test-Path $zip) -or (Sha256 $zip) -ne $manifest.sha256) { Download "$($manifest.url)$NoCache" $zip "MakePixel3D $($manifest.version) ($([int]($manifest.size/1KB)) KB)" }
        if ((Sha256 $zip) -ne $manifest.sha256) {
            # second attempt: fresh manifest and fresh ZIP (GitHub-side cache)
            Info "Checksum mismatch - retrying with a fresh download..."
            $NoCache = "?nocache=" + ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + 1)
            $manifest = Invoke-RestMethod -Uri "https://github.com/$Repo/releases/latest/download/latest.json$NoCache" -Headers @{ "User-Agent" = "MakePixel3D-installer"; "Cache-Control" = "no-cache" } -TimeoutSec 30
            Download "$($manifest.url)$NoCache" $zip "MakePixel3D $($manifest.version) ($([int]($manifest.size/1KB)) KB)"
        }
        if ((Sha256 $zip) -ne $manifest.sha256) { Fail "The downloaded program file is corrupted (SHA-256 mismatch). Run the installer again in a few minutes." }
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $z = [IO.Compression.ZipFile]::OpenRead($zip)
        try {
            foreach ($e in $z.Entries) {
                if (-not $e.Name) { continue }
                $dest = Join-Path $AppDir $e.FullName
                $full = [IO.Path]::GetFullPath($dest)
                if (-not $full.StartsWith([IO.Path]::GetFullPath($AppDir))) { continue }   # protection against "../"
                New-Item -ItemType Directory -Force (Split-Path $full) | Out-Null
                [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $full, $true)
            }
        } finally { $z.Dispose() }
        Set-Content $marker $manifest.sha256.ToLower() -Encoding ASCII
        Info "Extracted $($manifest.version) to $AppDir"
    }
}
if (-not (Test-Path "$AppDir\server\launch.py")) { Fail "Program files are missing in $AppDir." }

# ---------------------------------------------------------------- 2. Python
Step "Python $PythonVersion"
function Find-Python {
    foreach ($key in "HKCU:\Software\Python\PythonCore\3.12\InstallPath", "HKLM:\Software\Python\PythonCore\3.12\InstallPath") {
        try {
            $p = (Get-ItemProperty $key -ErrorAction Stop).ExecutablePath
            if ($p -and (Test-Path $p)) { return $p }
            $dir = (Get-ItemProperty $key -ErrorAction Stop)."(default)"
            if ($dir -and (Test-Path "$dir\python.exe")) { return "$dir\python.exe" }
        } catch {}
    }
    foreach ($c in "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe", "$env:ProgramFiles\Python312\python.exe") {
        if (Test-Path $c) { return $c }
    }
    return $null
}
$python = Find-Python
if ($python) {
    Info "Found: $python"
} else {
    $exe = Join-Path $Tmp "python-$PythonVersion-amd64.exe"
    if (-not (Test-Path $exe)) { Download $PythonUrl $exe "Python $PythonVersion (about 25 MB)" }
    # With administrator rights (installation to C:\Program Files) Python is installed for all users so that .venv
    # works on every account; without them - for the current user only.
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $allUsers = if ($admin) { 1 } else { 0 }
    Info "Installing Python ($(if ($admin) { 'for all users' } else { 'for the current user' }))..."
    $p = Start-Process $exe -ArgumentList "/quiet InstallAllUsers=$allUsers PrependPath=0 Include_launcher=0 Include_test=0 Include_doc=0 Include_tcltk=0 Shortcuts=0 AssociateFiles=0" -Wait -PassThru
    if ($p.ExitCode -ne 0) { Fail "The Python installer exited with code $($p.ExitCode)." }
    $python = Find-Python
    if (-not $python) { Fail "Python was installed but cannot be found." }
    Info "Installed: $python"
}

# ---------------------------------------------------------------- 3. environment and libraries
Step "Libraries (PyTorch $Torch and the rest) - the longest step"
$venv = Join-Path $AppDir ".venv"
$py = Join-Path $venv "Scripts\python.exe"
if (-not (Test-Path $py)) {
    Info "Creating the Python environment (.venv)..."
    Run $python @("-m", "venv", $venv) "Could not create the Python environment"
}
Run $py @("-m", "pip", "install", "--upgrade", "pip", "-q", "--disable-pip-version-check", "--progress-bar", "off") "Updating pip"
$torchOk = $false
try { & $py -c "import torch; import sys; sys.exit(0 if ('$Torch' == 'cpu') == (not torch.version.cuda) else 1)" 2>$null; $torchOk = ($LASTEXITCODE -eq 0) } catch {}
if ($torchOk) { Info "PyTorch ($Torch) is already installed." } else {
    $size = if ($Torch -eq "cu128") { "about 3 GB" } else { "about 300 MB" }
    Info "Installing PyTorch ($Torch, $size) - this can take 5-15 minutes..."
    Run $py @("-m", "pip", "install", "torch", "torchvision", "--index-url", "https://download.pytorch.org/whl/$Torch", "--disable-pip-version-check", "--progress-bar", "off") "Installing PyTorch"
}
Info "Installing libraries from requirements.txt..."
Run $py @("-m", "pip", "install", "-r", (Join-Path $AppDir "requirements.txt"), "--disable-pip-version-check", "--progress-bar", "off") "Installing libraries"
New-Item -ItemType Directory -Force (Join-Path $AppDir "config") | Out-Null
@{ torch = $Torch; python = $python; installed = (Get-Date -Format "yyyy-MM-dd") } | ConvertTo-Json | Set-Content (Join-Path $AppDir "config\install.json") -Encoding UTF8

# ---------------------------------------------------------------- 4. TripoSR + models
Step "3D model: TripoSR code and AI models (about 1.8 GB, once)"
$tsr = Join-Path $AppDir "server\third_party\TripoSR"
if (Test-Path (Join-Path $tsr "tsr")) { Info "TripoSR code is already present." } else {
    $zip = Join-Path $Tmp "TripoSR-main.zip"
    if (-not (Test-Path $zip)) { Download $TripoSRUrl $zip "TripoSR code (MIT license)" }
    $ex = Join-Path $Tmp "TripoSR-extract"
    if (Test-Path $ex) { Remove-Item $ex -Recurse -Force }
    Expand-Archive $zip $ex -Force
    $inner = Get-ChildItem $ex -Directory | Select-Object -First 1
    New-Item -ItemType Directory -Force (Split-Path $tsr) | Out-Null
    if (Test-Path $tsr) { Remove-Item $tsr -Recurse -Force }
    Move-Item $inner.FullName $tsr
    Info "Extracted TripoSR."
}
$im = Join-Path $AppDir "server	hird_party\InstantMesh"
if (Test-Path (Join-Path $im "src\models\lrm_mesh.py")) { Info "InstantMesh code is already present." } else {
    $zip = Join-Path $Tmp "InstantMesh-main.zip"
    if (-not (Test-Path $zip)) { Download $InstantMeshUrl $zip "InstantMesh code (Apache-2.0)" }
    $ex = Join-Path $Tmp "InstantMesh-extract"
    if (Test-Path $ex) { Remove-Item $ex -Recurse -Force }
    Expand-Archive $zip $ex -Force
    $inner = Get-ChildItem $ex -Directory | Select-Object -First 1
    if (Test-Path $im) { Remove-Item $im -Recurse -Force }
    Move-Item $inner.FullName $im
    Info "Extracted InstantMesh."
}
$env:PYTHONIOENCODING = "utf-8"
Info "Downloading AI models (about 1.8 GB) - this can take a few minutes..."
& $py (Join-Path $AppDir "server\models_setup.py")
if ($LASTEXITCODE -ne 0) { Fail "Could not download the AI models - the program cannot work without them. Check the internet connection and run the installer again (files already downloaded are not downloaded twice)." }

# ---------------------------------------------------------------- 5. WebView2 + shortcut
Step "Program window (WebView2) and shortcut"
$wv = $false
foreach ($key in "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
                 "HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}") {
    if ((Test-Path $key) -and (Get-ItemProperty $key).pv) { $wv = $true }
}
if ($wv) { Info "WebView2 is installed." } else {
    $exe = Join-Path $Tmp "MicrosoftEdgeWebView2Setup.exe"
    if (-not (Test-Path $exe)) { Download $WebView2Url $exe "Microsoft Edge WebView2 (program window)" }
    $p = Start-Process $exe -ArgumentList "/silent /install" -Wait -PassThru
    if ($p.ExitCode -ne 0) { Write-Host "  WARNING: the WebView2 installer exited with code $($p.ExitCode). If the program window does not open, use start-debug.bat --browser." -ForegroundColor Yellow }
}
$w = New-Object -ComObject WScript.Shell
$links = @((Join-Path $AppDir "MakePixel3D.lnk"))
if (-not $NoDesktopShortcut) { $links += (Join-Path ([Environment]::GetFolderPath("Desktop")) "MakePixel3D.lnk") }
foreach ($t in $links) {
    $s = $w.CreateShortcut($t)
    $s.TargetPath = Join-Path $AppDir ".venv\Scripts\pythonw.exe"
    $s.Arguments = "server\launch.py"
    $s.WorkingDirectory = $AppDir
    $s.IconLocation = (Join-Path $AppDir "assets\makepixel3d.ico") + ",0"
    $s.Description = "MakePixel3D - photo to 3D pixel art"
    $s.Save()
    Info "Shortcut: $t"
}

# ---------------------------------------------------------------- 6. cleanup
Step "Cleaning up temporary files"
Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ""
Write-Host "Done. MakePixel3D is installed in: $AppDir" -ForegroundColor Green
if ($StatusFile) { try { [IO.File]::WriteAllText($StatusFile, "DONE|") } catch {} }
try { Stop-Transcript | Out-Null } catch {}
exit 0
