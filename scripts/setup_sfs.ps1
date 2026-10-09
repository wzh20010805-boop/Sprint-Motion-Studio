param([switch]$IncludeDesktop, [switch]$IncludeValidationPython)
$ErrorActionPreference = 'Stop'
$sfsRepo = Split-Path -Parent $PSScriptRoot
$sfsRuntime = Join-Path (Split-Path -Parent $sfsRepo) '.runtime'
$sfsBun = Join-Path $sfsRuntime 'node_modules\@oven\bun-windows-x64\bin\bun.exe'
if (-not (Test-Path -LiteralPath $sfsBun)) {
    & npm.cmd install --prefix $sfsRuntime --no-audit --no-fund --ignore-scripts --save-exact '@oven/bun-windows-x64@1.4.2'
    if ($LASTEXITCODE -ne 0) { throw '隔离 Bun 安装失败' }
}
Push-Location $sfsRepo
try {
    & $sfsBun install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw '锁定依赖安装失败' }
    foreach ($sfsTool in @('ffmpeg','ffprobe')) {
        if (-not (Get-Command $sfsTool -ErrorAction SilentlyContinue)) { throw "PATH 缺少 $sfsTool；请先配置现有 FFmpeg" }
    }
    if ($IncludeDesktop) {
        Push-Location (Join-Path $sfsRepo 'probes\desktop')
        try {
            & $sfsBun install --frozen-lockfile
            if ($LASTEXITCODE -ne 0) { throw 'Electron 开发宿主安装失败' }
        } finally { Pop-Location }
    }
    if ($IncludeValidationPython) {
        $sfsPython = Join-Path $sfsRepo '.venv-image\Scripts\python.exe'
        if (-not (Test-Path -LiteralPath $sfsPython)) {
            & py -3.11 -m venv (Join-Path $sfsRepo '.venv-image')
            if ($LASTEXITCODE -ne 0) { throw '需要 Python 3.11 的 py 启动器' }
        }
        & $sfsPython -m pip install 'Pillow==12.0.0' 'pytest==8.4.2'
        if ($LASTEXITCODE -ne 0) { throw '隔离验证依赖安装失败' }
    }
    & $sfsBun (Join-Path $sfsRepo 'apps\cli\src\index.ts') doctor --json
    if ($LASTEXITCODE -ne 0) { throw '本地体检未通过' }
} finally { Pop-Location }
