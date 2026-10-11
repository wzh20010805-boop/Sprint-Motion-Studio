$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$taskEnvironment = Join-Path $taskRoot '.venv-image'
if (!(Test-Path -LiteralPath $taskEnvironment)) {
    python -m venv $taskEnvironment
    if ($LASTEXITCODE -ne 0) { throw 'Image worker environment creation failed' }
}
$taskPython = Join-Path $taskEnvironment $(if ($IsWindows) { 'Scripts/python.exe' } else { 'bin/python' })
& $taskPython -m pip install --disable-pip-version-check -r (Join-Path $taskRoot 'workers/image/requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Image worker dependency installation failed' }
$taskModels = Join-Path $taskRoot '.models'
New-Item -ItemType Directory -Force -Path $taskModels | Out-Null
$taskTarget = Join-Path $taskModels 'u2netp.onnx'
$taskDigest = '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8'
if (!(Test-Path -LiteralPath $taskTarget)) {
    $taskDownload = $taskTarget + '.download'
    Invoke-WebRequest -Uri 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx' -OutFile $taskDownload
    if ((Get-FileHash -LiteralPath $taskDownload -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskDigest) { throw 'CPU model SHA256 mismatch' }
    Move-Item -LiteralPath $taskDownload -Destination $taskTarget
}
if ((Get-FileHash -LiteralPath $taskTarget -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskDigest) { throw 'CPU model SHA256 mismatch' }
& $taskPython -c 'import PIL,onnxruntime,rembg; print("Image worker imports ready")'
if ($LASTEXITCODE -ne 0) { throw 'Image worker import verification failed' }
