param([string]$Version = '8.1')
$ErrorActionPreference = 'Stop'

# 两个平台都准备完整 FFmpeg 构建，不依赖 runner 偶然预装或开发者的 Downloads。
if (-not $env:RUNNER_TEMP -or -not $env:GITHUB_PATH) { throw '此脚本需要 GitHub runner 的临时目录和 PATH 文件' }
$isWindowsRunner = [System.OperatingSystem]::IsWindows()
$target = if ($isWindowsRunner) { 'win64' } else { 'linux64' }
$extension = if ($isWindowsRunner) { 'zip' } else { 'tar.xz' }
$archiveName = "ffmpeg-n$Version-latest-$target-gpl-$Version.$extension"
$release = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest'
$directory = Join-Path $env:RUNNER_TEMP "sfs-ffmpeg-$Version"
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$archive = Join-Path $directory $archiveName
$checksums = Join-Path $directory 'checksums.sha256'
Invoke-WebRequest "$release/$archiveName" -OutFile $archive
Invoke-WebRequest "$release/checksums.sha256" -OutFile $checksums
$pattern = '^([a-fA-F0-9]{64})\s+\*?' + [regex]::Escape($archiveName) + '\s*$'
$matching = @(Get-Content -LiteralPath $checksums | Where-Object { $_ -match $pattern })
if ($matching.Count -ne 1) { throw "找不到唯一的 $archiveName 校验值" }
$expected = [regex]::Match($matching[0], $pattern).Groups[1].Value
$actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
if ($actual -ne $expected) { throw 'FFmpeg 下载摘要不匹配' }
$extracted = Join-Path $directory 'extracted'
New-Item -ItemType Directory -Path $extracted -Force | Out-Null
if ($isWindowsRunner) { Expand-Archive -LiteralPath $archive -DestinationPath $extracted }
else {
    & tar -xJf $archive -C $extracted
    if ($LASTEXITCODE -ne 0) { throw 'FFmpeg 解压失败' }
}
$name = if ($isWindowsRunner) { 'ffmpeg.exe' } else { 'ffmpeg' }
$executables = @(Get-ChildItem -LiteralPath $extracted -Recurse -File -Filter $name)
if ($executables.Count -ne 1) { throw 'FFmpeg 安装路径不唯一或缺失' }
$bin = $executables[0].DirectoryName
$env:PATH = $bin + [IO.Path]::PathSeparator + $env:PATH
Add-Content -LiteralPath $env:GITHUB_PATH -Value $bin -Encoding utf8
$tools = @{}
foreach ($tool in @('ffmpeg', 'ffprobe')) {
    # Application 过滤可返回 PATH 中多个同名结果；首项才是实际执行的命令。
    $command = Get-Command $tool -CommandType Application -ErrorAction Stop | Select-Object -First 1
    if ((Split-Path -Parent $command.Source) -ne $bin) { throw "$tool 不是本轮安装的二进制" }
    $output = @(& $command.Source -version)
    if ($LASTEXITCODE -ne 0) { throw "$tool 不可执行" }
    $tools[$tool] = @{ path = $command.Source; version = $output[0] }
    Write-Output "$tool path: $($command.Source)"
    Write-Output $output[0]
}
$artifacts = Join-Path $PWD 'fixtures/generated/ci-artifacts'
New-Item -ItemType Directory -Path $artifacts -Force | Out-Null
@{ archive = "$release/$archiveName"; sha256 = $actual; tools = $tools } |
    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $artifacts 'ffmpeg.json') -Encoding utf8
