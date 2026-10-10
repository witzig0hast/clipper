# Lädt OBS Studio (portable ZIP) nach vendor/obs, prüft die digitale Signatur und legt es für den Installer bereit.
# Aufruf: pwsh scripts/fetch-obs.ps1 [-Tag 31.0.3]     (ohne Tag: neueste Version)
param([string]$Tag = $env:OBS_VERSION, [string]$Dest = "vendor/obs")
$ErrorActionPreference = 'Stop'
$headers = @{ 'User-Agent' = 'clipper-build' }
if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $env:GITHUB_TOKEN" }
$base = 'https://api.github.com/repos/obsproject/obs-studio/releases'
$url = if ($Tag) { "$base/tags/$Tag" } else { "$base/latest" }
$rel = Invoke-RestMethod -Uri $url -Headers $headers
Write-Host "OBS-Release: $($rel.tag_name)"
$asset = $rel.assets | Where-Object { $_.name -match '^OBS-Studio-[\d\.]+(-rc\d+|-beta\d+)?-Windows(-x64)?\.zip$' } | Select-Object -First 1
if (-not $asset) {
  Write-Host 'Verfügbare Dateien:'; $rel.assets | ForEach-Object { Write-Host "  $($_.name)" }
  throw 'Kein passendes Windows-x64-ZIP gefunden.'
}
Write-Host "Lade $($asset.name) ($([math]::Round($asset.size/1MB)) MB) ..."
$zip = Join-Path $env:RUNNER_TEMP 'obs.zip'
if (-not $env:RUNNER_TEMP) { $zip = Join-Path ([IO.Path]::GetTempPath()) 'obs.zip' }
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -Headers @{ 'User-Agent' = 'clipper-build' }
if (Test-Path $Dest) { Remove-Item $Dest -Recurse -Force }
New-Item -ItemType Directory -Path $Dest -Force | Out-Null
Expand-Archive -Path $zip -DestinationPath $Dest -Force
$exe = Join-Path $Dest 'bin/64bit/obs64.exe'
if (-not (Test-Path $exe)) { throw "obs64.exe fehlt in $Dest" }
if (-not (Test-Path (Join-Path $Dest 'obs-plugins/64bit/obs-websocket.dll'))) { Write-Warning 'obs-websocket.dll nicht gefunden (evtl. in anderes Modul integriert).' }
$sig = Get-AuthenticodeSignature $exe
Write-Host "Signatur: $($sig.Status) – $($sig.SignerCertificate.Subject)"
if ($sig.Status -ne 'Valid') { throw 'OBS-Signatur ist nicht gültig – Abbruch.' }
Set-Content -Path (Join-Path $Dest 'CLIPPER_OBS_VERSION.txt') -Value $rel.tag_name
Write-Host "Fertig: $Dest ($($rel.tag_name))"
