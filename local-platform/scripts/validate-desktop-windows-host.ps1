<#
本文件在真实 Windows 主机执行桌面安装、WebView2、DPI、数据保留和启动门禁，并输出脱敏 JSON 证据。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ExpectedVersion,
  [string]$Installer,
  [string]$EvidenceDirectory = ".private/desktop-host-validation",
  [switch]$ExpectNoGpu
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# 使用纯 .NET 计算文件哈希，避免依赖 Windows PowerShell 模块自动加载。
function Get-DrawHimeSha256([string]$Path) {
  # SQLite 的 WAL/SHM 可能短暂保留共享句柄；只读哈希允许其他进程继续读写或删除。
  $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
  $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant() }
    finally { $sha.Dispose() }
  }
  finally { $stream.Dispose() }
}

# 只记录业务数据库文件名、大小和哈希，不读取账号、提示词或媒体内容。
function Get-DrawHimeDatabaseSnapshot([string]$Root) {
  if (-not (Test-Path -LiteralPath $Root)) { return @() }
  return @(Get-ChildItem -LiteralPath $Root -File -Filter "desktop.sqlite3*" | Sort-Object Name | ForEach-Object {
    [ordered]@{ name = $_.Name; bytes = $_.Length; sha256 = Get-DrawHimeSha256 $_.FullName }
  })
}

# 获取当前用户安装登记，确保验证的是实际安装版本而不是构建目录文件。
function Get-DrawHimeInstallation {
  return Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -eq "DrawHime Desktop" } |
    Select-Object -First 1
}

# 读取系统登记的 Evergreen WebView2 版本。
function Get-DrawHimeWebViewVersion {
  $versions = @()
  foreach ($path in @("HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\*", "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\*")) {
    $versions += @(Get-ItemProperty $path -ErrorAction SilentlyContinue | Where-Object { $_.name -like "*WebView2*" -and $_.pv } | ForEach-Object { [string]$_.pv })
  }
  return @($versions | Sort-Object -Unique | Select-Object -Last 1)[0]
}

# 通过 nvidia-smi 获取脱敏硬件摘要；无 NVIDIA GPU 时返回空数组。
function Get-DrawHimeGpuSummary {
  $command = Get-Command "nvidia-smi.exe" -ErrorAction SilentlyContinue
  if (-not $command) { return @() }
  $rows = & $command.Source "--query-gpu=name,memory.total,driver_version" "--format=csv,noheader,nounits" 2>$null
  if ($LASTEXITCODE -ne 0) { return @() }
  return @($rows | ForEach-Object {
    $columns = @($_ -split "," | ForEach-Object { $_.Trim() })
    if ($columns.Count -ge 3) { [ordered]@{ name = $columns[0]; memoryMiB = [int]$columns[1]; driverVersion = $columns[2] } }
  })
}

# 注册最小 Win32 DPI 探针，直接验证运行窗口使用 Per-Monitor V2。
function Initialize-DrawHimeDpiProbe {
  if ("DrawHimeWindowsProbe" -as [type]) { return }
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DrawHimeWindowsProbe {
  [DllImport("user32.dll")] public static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hwnd);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool AreDpiAwarenessContextsEqual(IntPtr first, IntPtr second);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
}
'@
}

$resolvedInstaller = if ($Installer) { (Resolve-Path -LiteralPath $Installer).Path } else { $null }
$os = Get-CimInstance Win32_OperatingSystem
$build = [int64]$os.BuildNumber
if (-not $os.Version.StartsWith("10.") -or $build -lt 17763) { throw "当前 Windows 构建不在支持范围：$($os.Version) ($build)" }

$businessRoot = Join-Path $env:APPDATA "ink.xanime.drawhime.desktop"
$existingProcesses = @(Get-Process -Name "drawhime-desktop" -ErrorAction SilentlyContinue)
$existingProcesses | Stop-Process -Force
$existingProcesses | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
$databaseBefore = Get-DrawHimeDatabaseSnapshot $businessRoot

$installerEvidence = $null
if ($resolvedInstaller) {
  $installerEvidence = [ordered]@{ path = [System.IO.Path]::GetFileName($resolvedInstaller); bytes = (Get-Item -LiteralPath $resolvedInstaller).Length; sha256 = Get-DrawHimeSha256 $resolvedInstaller }
  $installerProcess = Start-Process -FilePath $resolvedInstaller -ArgumentList "/S" -PassThru -Wait -WindowStyle Hidden
  if ($installerProcess.ExitCode -ne 0) { throw "NSIS 静默安装失败，退出码 $($installerProcess.ExitCode)" }
}

$installation = Get-DrawHimeInstallation
if (-not $installation) { throw "未找到 DrawHime Desktop 当前用户安装登记" }
if ([string]$installation.DisplayVersion -ne $ExpectedVersion) { throw "安装版本不一致：$($installation.DisplayVersion) != $ExpectedVersion" }
$installRoot = ([string]$installation.InstallLocation).Trim('"')
$executable = Join-Path $installRoot "drawhime-desktop.exe"
if (-not (Test-Path -LiteralPath $executable)) { throw "安装目录缺少桌面主程序" }
$installedFiles = @(Get-ChildItem -LiteralPath $installRoot -File -Recurse)
$forbidden = @($installedFiles | Where-Object { $_.Extension -match "^\.(safetensors|ckpt|pt|pth|onnx)$" -or $_.Name -match "(?i)(trainer|tagger|checkpoint|lora)" })
if ($forbidden.Count -gt 0) { throw "安装目录包含模型或训练依赖" }

$databaseAfterInstall = Get-DrawHimeDatabaseSnapshot $businessRoot
$beforeJson = ConvertTo-Json $databaseBefore -Compress -Depth 4
$afterJson = ConvertTo-Json $databaseAfterInstall -Compress -Depth 4
if ($beforeJson -ne $afterJson) { throw "安装过程修改了既有业务数据库文件" }

$webViewVersion = Get-DrawHimeWebViewVersion
if (-not $webViewVersion) { throw "安装后未检测到 WebView2 Runtime" }

Initialize-DrawHimeDpiProbe
$process = Start-Process -FilePath $executable -PassThru
try {
  $windowHandle = [IntPtr]::Zero
  foreach ($attempt in 1..30) {
    Start-Sleep -Milliseconds 500
    $process.Refresh()
    if ($process.HasExited) { throw "桌面进程在启动阶段提前退出" }
    if ($process.MainWindowHandle -ne 0) { $windowHandle = [IntPtr]$process.MainWindowHandle; break }
  }
  if ($windowHandle -eq [IntPtr]::Zero) { throw "启动后未取得主窗口句柄" }
  $context = [DrawHimeWindowsProbe]::GetWindowDpiAwarenessContext($windowHandle)
  $perMonitorV2 = [DrawHimeWindowsProbe]::AreDpiAwarenessContextsEqual($context, [IntPtr](-4))
  $windowDpi = [DrawHimeWindowsProbe]::GetDpiForWindow($windowHandle)
  if (-not $perMonitorV2) { throw "桌面窗口未使用 Per-Monitor V2 DPI 模式" }
  Start-Sleep -Seconds 10
  $process.Refresh()
  if ($process.HasExited) { throw "桌面进程未通过十秒启动存活门禁" }
}
finally {
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
}

$gpuSummary = @(Get-DrawHimeGpuSummary)
if ($ExpectNoGpu.IsPresent -and $gpuSummary.Count -ne 0) { throw "当前验收机检测到 NVIDIA GPU，不能作为无 GPU 门禁证据" }

$result = [ordered]@{
  checkedAt = [DateTime]::UtcNow.ToString("o")
  os = [ordered]@{ caption = [string]$os.Caption; version = [string]$os.Version; build = $build; architecture = [string]$os.OSArchitecture }
  dpi = [ordered]@{ value = $windowDpi; scalePercent = [math]::Round($windowDpi / 96 * 100); perMonitorV2 = $perMonitorV2 }
  webView2Version = $webViewVersion
  gpus = $gpuSummary
  gpuGate = [ordered]@{ expectedNoNvidiaGpu = [bool]$ExpectNoGpu.IsPresent; detectedCount = $gpuSummary.Count; passed = (-not $ExpectNoGpu.IsPresent) -or $gpuSummary.Count -eq 0 }
  installer = $installerEvidence
  installation = [ordered]@{ version = [string]$installation.DisplayVersion; fileCount = $installedFiles.Count; totalBytes = ($installedFiles | Measure-Object Length -Sum).Sum; containsModelOrTrainer = $false }
  gates = [ordered]@{ supportedWindows = $true; databasePreservedByInstaller = $true; launchAliveTenSeconds = $true; perMonitorV2 = $true; webView2Present = $true }
}

$resolvedEvidence = [System.IO.Path]::GetFullPath($EvidenceDirectory)
[System.IO.Directory]::CreateDirectory($resolvedEvidence) | Out-Null
$evidencePath = Join-Path $resolvedEvidence ("windows-host-{0}-{1}dpi.json" -f $build, $windowDpi)
[System.IO.File]::WriteAllText($evidencePath, ($result | ConvertTo-Json -Depth 8), [System.Text.UTF8Encoding]::new($false))
Write-Output "Windows 主机验收通过：$evidencePath"
