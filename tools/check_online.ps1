# Checks before installation that all servers the installation downloads from are reachable
# (Python libraries, PyTorch, TripoSR code, AI models). Without them the installation cannot succeed, so we stop
# right away instead of failing after several minutes. Exit code: 0 = everything reachable, 1 = no connection.
# Used by install.bat (the installer, tools\installer\install.ps1, has its own copy of this check).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$targets = [ordered]@{
    'Python libraries (pypi.org)'            = 'https://pypi.org/simple/pip/'
    'PyTorch (download.pytorch.org)'         = 'https://download.pytorch.org/whl/'
    'TripoSR code (github.com)'              = 'https://github.com/VAST-AI-Research/TripoSR'
    'background removal model (github.com)'  = 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx'
    'TripoSR 3D model (huggingface.co)'      = 'https://huggingface.co/stabilityai/TripoSR/resolve/main/config.yaml'
}

$failed = @()
foreach ($name in $targets.Keys) {
    try {
        Invoke-WebRequest -UseBasicParsing -Method Head -TimeoutSec 20 -Uri $targets[$name] | Out-Null
        Write-Host "  OK   $name"
    } catch {
        Write-Host "  FAIL $name"
        $failed += $name
    }
}
if ($failed.Count) { exit 1 }
exit 0
