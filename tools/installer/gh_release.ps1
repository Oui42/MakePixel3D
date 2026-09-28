# Creates (or updates) a GitHub release and uploads the files from dist/ - the token comes from Git Credential Manager
# (git credential fill) and is never printed. The tag is taken from the version in dist\latest.json (written by release.py).
#   powershell -ExecutionPolicy Bypass -File tools\installer\gh_release.ps1 [-Repo Oui42/MakePixel3D] [-Tag v0.1.0]
# Release assets that are no longer in dist/ are removed; assets with the same name are replaced.
param([string]$Repo = "Oui42/MakePixel3D", [string]$Tag = "", [string]$Dist = "dist")
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$in = Join-Path $env:TEMP "mp3d_cred_in.txt"; [IO.File]::WriteAllText($in, "protocol=https`nhost=github.com`n`n"); $cred = cmd /c "git credential fill < `"$in`""; [IO.File]::Delete($in)
$token = ($cred | Where-Object { $_ -like "password=*" }) -replace "^password=", ""
if (-not $token) { Write-Host "No GitHub token (sign in with Git Credential Manager first)"; exit 1 }
$h = @{ Authorization = "Bearer $token"; Accept = "application/vnd.github+json"; "User-Agent" = "MakePixel3D-release" }
$latest = Get-Content "$Dist\latest.json" -Raw | ConvertFrom-Json
$notes = $latest.notes
if (-not $Tag) { $Tag = "v$($latest.version)" }
$existing = $null
try { $existing = Invoke-RestMethod -Headers $h -Uri "https://api.github.com/repos/$Repo/releases/tags/$Tag" } catch {}
if ($existing) { $rel = $existing; Write-Host "Release $Tag already exists (id $($rel.id))" } else {
    $body = @{ tag_name = $Tag; target_commitish = "master"; name = "MakePixel3D $($Tag.TrimStart('v'))"; body = $notes; draft = $false; prerelease = $false } | ConvertTo-Json
    $rel = Invoke-RestMethod -Method Post -Headers $h -Uri "https://api.github.com/repos/$Repo/releases" -Body ([Text.Encoding]::UTF8.GetBytes($body)) -ContentType "application/json"
    Write-Host "Created release $Tag (id $($rel.id))"
}
foreach ($a in $rel.assets) {
    if (-not (Test-Path (Join-Path $Dist $a.name))) {
        Invoke-RestMethod -Method Delete -Headers $h -Uri "https://api.github.com/repos/$Repo/releases/assets/$($a.id)" | Out-Null
        Write-Host "Removed from the release: $($a.name)"
    }
}
foreach ($f in Get-ChildItem $Dist -File) {
    $old = $rel.assets | Where-Object { $_.name -eq $f.Name }
    if ($old) { Invoke-RestMethod -Method Delete -Headers $h -Uri "https://api.github.com/repos/$Repo/releases/assets/$($old.id)" | Out-Null }
    $ct = if ($f.Extension -eq ".json") { "application/json" } else { "application/octet-stream" }
    $up = "https://uploads.github.com/repos/$Repo/releases/$($rel.id)/assets?name=$($f.Name)"
    $r = Invoke-RestMethod -Method Post -Headers $h -Uri $up -InFile $f.FullName -ContentType $ct
    Write-Host "Uploaded: $($r.name) ($([int]($r.size/1KB)) KB) -> $($r.browser_download_url)"
}
Write-Host "https://github.com/$Repo/releases/tag/$Tag"
