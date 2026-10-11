param([string]$ModelFile)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskPython = Join-Path $taskRoot '.venv-image/Scripts/python.exe'
if (!(Test-Path -LiteralPath $taskPython)) { python -m venv (Join-Path $taskRoot '.venv-image') }
Write-Host 'Preparing local CPU Rembg. No video or image is uploaded.'
& $taskPython -m pip install -r (Join-Path $taskRoot 'workers/image/requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Python dependencies failed' }
$taskModels = Join-Path $taskRoot '.models'
New-Item -ItemType Directory -Force -Path $taskModels | Out-Null
$taskTarget = Join-Path $taskModels 'u2netp.onnx'
if ($ModelFile) { Copy-Item -LiteralPath $ModelFile -Destination ($taskTarget + '.download') }
elseif (!(Test-Path -LiteralPath $taskTarget)) {
  Write-Host 'Downloading u2netp (~4.7 MB) from official rembg GitHub release.'
  Invoke-WebRequest -Uri 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx' -OutFile ($taskTarget + '.download')
}
if (Test-Path -LiteralPath ($taskTarget + '.download')) {
  if ((Get-FileHash -LiteralPath ($taskTarget + '.download') -Algorithm MD5).Hash.ToLowerInvariant() -ne '8e83ca70e441ab06c318d82300c84806') { throw 'Model checksum mismatch; download retained for inspection' }
  Move-Item -LiteralPath ($taskTarget + '.download') -Destination $taskTarget -Force
}
if ((Get-FileHash -LiteralPath $taskTarget -Algorithm MD5).Hash.ToLowerInvariant() -ne '8e83ca70e441ab06c318d82300c84806') { throw 'Model checksum mismatch' }
Write-Host "Ready: $taskTarget"
