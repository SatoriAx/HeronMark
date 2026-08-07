# build-updater.ps1 — 先编独立更新器，拷进 src-tauri\resources\ 供主程序 include_bytes! 内嵌
#
# 构建顺序（任何主程序构建前必须执行本脚本）：
#   1. tools\build-updater.ps1          （本脚本：编 updater bin + 拷贝资源）
#   2. cargo build --release / npx tauri build
# 原因：src\main.rs 在编译期把 resources\heronmark_updater.exe 嵌入主程序；
# 更新器自身不依赖该资源（include_bytes! 在主 bin，避免首次构建死锁）。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot  # tools/ 的上一级即项目根
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"

Push-Location (Join-Path $root 'src-tauri')
try {
    cargo build --release --bin heronmark_updater
    if ($LASTEXITCODE -ne 0) { throw "cargo build updater failed: $LASTEXITCODE" }
    New-Item -ItemType Directory -Force (Join-Path $root 'src-tauri\resources') | Out-Null
    Copy-Item (Join-Path $root 'src-tauri\target\release\heronmark_updater.exe') `
              (Join-Path $root 'src-tauri\resources\heronmark_updater.exe') -Force
    Write-Output "UPDATER OK -> src-tauri\resources\heronmark_updater.exe"
}
finally {
    Pop-Location
}
