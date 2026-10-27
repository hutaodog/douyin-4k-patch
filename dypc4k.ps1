#requires -version 5
<#
  抖音 PC 客户端「固定 4K」一键补丁（双击即用版）
  =====================================================================
  给不装 Node、不会敲命令的人用的：双击「一键开启4K.cmd」即可。
  原理：把一段注入脚本追加到客户端的 preload.js 末尾（preload 在页面脚本之前执行），
        每帧先把清晰度写成「超清 4K」，并改写服务端 AB 配置里的自动降档开关。

  用法：
    双击 一键开启4K.cmd        按默认（4K）安装
    双击 恢复原版.cmd          还原（用备份覆盖回去）
    手动： powershell -ExecutionPolicy Bypass -File dypc4k.ps1 -Mode status
           powershell -ExecutionPolicy Bypass -File dypc4k.ps1 -Mode apply -Target 4khdr
           powershell -ExecutionPolicy Bypass -File dypc4k.ps1 -Mode restore
#>
[CmdletBinding()]
param(
  [ValidateSet('apply', 'restore', 'status')]
  [string]$Mode = 'apply',
  [ValidateSet('4khdr', '4k', '2k', '1080p')]
  [string]$Target = '4k',
  [string]$InstallRoot = '',
  [switch]$CloseClient,
  [switch]$StartAfter,
  [switch]$Pause
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Snippet = Join-Path $Here 'preload-snippet.js'
$Mark = '==== dypc4k begin ===='
$MarkEnd = '==== dypc4k end ===='

function Say($msg, $color = 'Gray') {
  Write-Host $msg -ForegroundColor $color
}
function Ok($msg) { Say "  [√] $msg" 'Green' }
function Warn($msg) { Say "  [!] $msg" 'Yellow' }
function Die($msg) {
  Say ""
  Say "  [×] $msg" 'Red'
  Say ""
  if ($Pause) { Read-Host '按回车退出' | Out-Null }
  exit 1
}

function Line() { Say ('  ' + ('-' * 62)) 'DarkGray' }

# ---------------------------------------------------------------- 定位安装目录
function Find-InstallRoot([string]$hint) {
  $found = @()

  if ($hint) { $found += $hint }

  # 1) 注册表（最可靠）
  $keys = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($k in $keys) {
    try {
      Get-ItemProperty $k -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -match '抖音|douyin' -and $_.InstallLocation } |
        ForEach-Object { $found += $_.InstallLocation.TrimEnd('\') }
    } catch {}
  }

  # 2) 正在运行的进程
  try {
    Get-Process -Name douyin -ErrorAction SilentlyContinue |
      Where-Object { $_.Path } |
      ForEach-Object { $found += (Split-Path -Parent $_.Path) }
  } catch {}

  # 3) 常见安装位置
  $found += @(
    'D:\软件\抖音\douyin',
    "$env:ProgramFiles\douyin",
    "${env:ProgramFiles(x86)}\douyin",
    "$env:LOCALAPPDATA\Programs\douyin",
    "$env:LOCALAPPDATA\douyin",
    'C:\douyin'
  ) | Where-Object { $_ }

  foreach ($p in ($found | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $p)) { continue }
    # 这个目录下得有 版本号子目录 + resources\app.asar.unpacked\preload.js
    $ver = Get-ChildItem -LiteralPath $p -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } |
      Sort-Object { [version]$_.Name } -Descending |
      Select-Object -First 1
    if (-not $ver) { continue }
    $pre = Join-Path $ver.FullName 'resources\app.asar.unpacked\preload.js'
    if (Test-Path -LiteralPath $pre) {
      return [pscustomobject]@{ Root = $p; Version = $ver.Name; Preload = $pre }
    }
  }
  return $null
}

function Get-ClientProcesses { Get-Process -Name douyin, douyin_tray -ErrorAction SilentlyContinue }

# ---------------------------------------------------------------- 提权
function Ensure-Elevated([string[]]$extraArgs) {
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if ($isAdmin) { return $true }

  Warn '安装目录写不进去，需要管理员权限，正在申请…'
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"") + $extraArgs
  try {
    Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs | Out-Null
  } catch {
    return $false
  }
  return $false
}

# ---------------------------------------------------------------- 主流程
Say ""
Say '  ╔════════════════════════════════════════════════════════════╗' 'Cyan'
Say '  ║        抖音 PC 客户端  固定 4K  一键补丁  v1.0             ║' 'Cyan'
Say '  ╚════════════════════════════════════════════════════════════╝' 'Cyan'
Say ''

Say '  [1/5] 正在定位抖音安装目录…' 'White'
$info = Find-InstallRoot $InstallRoot
if (-not $info) {
  Line
  Die @'
没找到抖音客户端。

请确认：
  1) 这台电脑装的是「抖音」PC 客户端（不是网页版、不是手机模拟器）；
  2) 至少启动过一次。

如果装在自定义位置，可以右键本文件所在的 dypc4k.ps1，
用 PowerShell 这样跑一次（把路径换成你的）：
  .\dypc4k.ps1 -Mode apply -InstallRoot "D:\你的路径\douyin"
'@
}
Ok "安装目录 : $($info.Root)"
Ok "客户端版本: $($info.Version)"
Ok "补丁文件 : $($info.Preload)"
$preload = $info.Preload
$backup = "$preload.dypc4k.bak"

# ---------------------------------------------------------------- status
if ($Mode -eq 'status') {
  Say ''
  Say '  [状态]' 'White'
  $content = [System.IO.File]::ReadAllText($preload, [System.Text.Encoding]::UTF8)
  $patched = $content.Contains($Mark)
  Line
  Say ("  补丁状态 : " + $(if ($patched) { '已安装' } else { '未安装（原版）' })) $(if ($patched) { 'Green' } else { 'Yellow' })
  Say ("  备份文件 : " + $(if (Test-Path -LiteralPath $backup) { '有' } else { '无' }))
  if ($patched) {
    if ($content -match "var TARGET = '([^']+)';") { Say "  目标档位 : $($Matches[1])" }
  }
  Say ''
  if ($Pause) { Read-Host '按回车退出' | Out-Null }
  exit 0
}

# ---------------------------------------------------------------- 关闭客户端
Say ''
Say '  [2/5] 检查抖音是否在运行…' 'White'
$procs = Get-ClientProcesses
if ($procs) {
  Warn "抖音正在运行（$($procs.Count) 个进程）。补丁必须在它退出后写入。"
  $auto = $CloseClient
  if (-not $auto) {
    Say ''
    $ans = Read-Host '  现在帮你关掉抖音？关掉后会自动重新启动 (Y/n)'
    if ($ans -eq '' -or $ans -match '^[Yy]') { $auto = $true }
  }
  if (-not $auto) { Die '已取消：请先从托盘右键「退出」抖音，再运行本工具。' }

  Say '  正在关闭抖音…'
  try { Get-Process -Name douyin_tray -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue } catch {}
  try { Get-Process -Name douyin -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue } catch {}
  Start-Sleep -Milliseconds 1500
  if (Get-ClientProcesses) { Start-Sleep -Seconds 2 }
  if (Get-ClientProcesses) { Die '抖音没关掉（可能有进程占用）。请手动退出后重试。' }
  Ok '抖音已关闭'
} else {
  Ok '抖音未运行，可以直接改文件'
}

# ---------------------------------------------------------------- 备份
Say ''
Say '  [3/5] 备份原文件…' 'White'
if (-not (Test-Path -LiteralPath $backup)) {
  try {
    Copy-Item -LiteralPath $preload -Destination $backup -Force -ErrorAction Stop
  } catch {
    if (Ensure-Elevated @('-Mode', $Mode, '-Target', $Target, '-CloseClient')) { exit 0 }
    Die "备份失败（权限不足）：$($_.Exception.Message)"
  }
  Ok "已备份 -> $backup"
} else {
  Ok '已有备份，沿用（保证能还原到最原始版本）'
}
$origMd5 = (Get-FileHash -LiteralPath $backup -Algorithm MD5).Hash.ToLower()

# ---------------------------------------------------------------- 还原
if ($Mode -eq 'restore') {
  Say ''
  Say '  [4/5] 还原原版…' 'White'
  try {
    Copy-Item -LiteralPath $backup -Destination $preload -Force -ErrorAction Stop
  } catch {
    if (Ensure-Elevated @('-Mode', 'restore', '-CloseClient')) { exit 0 }
    Die "还原失败（权限不足）：$($_.Exception.Message)"
  }
  $c = [System.IO.File]::ReadAllText($preload, [System.Text.Encoding]::UTF8)
  if ($c.Contains($Mark)) { Die '还原后仍检测到补丁，请重装客户端。' }
  Ok '已还原为原版'
  Say ''
  Say '  完成。重新启动抖音即为原版（不再强制 4K）。' 'Green'
  Say ''
  if ($StartAfter) {
    try { Start-Process (Join-Path $info.Root 'douyin.exe') } catch {}
  }
  if ($Pause) { Read-Host '按回车退出' | Out-Null }
  exit 0
}

# ---------------------------------------------------------------- 注入
Say ''
Say '  [4/5] 写入补丁…' 'White'
if (-not (Test-Path -LiteralPath $Snippet)) { Die "缺少文件：$Snippet（请把整个文件夹一起拷走）" }

$utf8 = New-Object System.Text.UTF8Encoding($false)
$content = [System.IO.File]::ReadAllText($preload, [System.Text.Encoding]::UTF8)

# 幂等：先剥掉旧补丁块（含各种探针）
$content = [regex]::Replace($content, "(?s)\r?\n?/\* ==== dypc4k begin ==== \*/.*?/\* ==== dypc4k end ==== \*/", '')
$content = [regex]::Replace($content, "(?s)\r?\n?/\* ==== dypc4k-probe begin ==== \*/.*?/\* ==== dypc4k-probe end ==== \*/", '')
$content = [regex]::Replace($content, "(?s)\r?\n?/\* ==== dypc4k-probe2 begin ==== \*/.*?/\* ==== dypc4k-probe2 end ==== \*/", '')

$snip = [System.IO.File]::ReadAllText($Snippet, [System.Text.Encoding]::UTF8)
$snip = $snip -replace "var TARGET = '[^']+';", "var TARGET = '$Target';"
$snip = $snip -replace "var FIGHT = (true|false);", 'var FIGHT = false;'
$snip = $snip -replace "var LOCK_CODEC = '[^']*';", "var LOCK_CODEC = 'h264';"
$snip = $snip -replace "var REFUSE = '[^']*';", "var REFUSE = 'vvc';"
$snip = $snip -replace "var AB_PATCH = (true|false);", 'var AB_PATCH = true;'

$new = $content.TrimEnd() + "`r`n`r`n" + $snip + "`r`n"
try {
  [System.IO.File]::WriteAllText($preload, $new, $utf8)
} catch {
  if (Ensure-Elevated @('-Mode', 'apply', '-Target', $Target, '-CloseClient')) { exit 0 }
  Die "写入失败（权限不足）：$($_.Exception.Message)"
}

# ---------------------------------------------------------------- 校验
Say ''
Say '  [5/5] 校验…' 'White'
$check = [System.IO.File]::ReadAllText($preload, [System.Text.Encoding]::UTF8)
if (-not $check.Contains($Mark)) { Die '写入后没找到补丁标记，写入可能被拦截了（杀软？）。' }
if (-not $check.Contains($MarkEnd)) { Die '补丁块不完整（缺少结束标记）。' }
$newMd5 = (Get-FileHash -LiteralPath $preload -Algorithm MD5).Hash.ToLower()
Ok "补丁已写入（$([math]::Round($check.Length/1024,1)) KB）"
Ok "原始 md5 : $origMd5"
Ok "当前 md5 : $newMd5"

Line
Say '  安装完成 ✔' 'Green'
Say ''
Say '  接下来：' 'White'
Say '    1) 启动抖音 PC 客户端；'
Say '    2) 随便点开一个视频，右上角清晰度应显示「超清 4K」；'
Say '    3) 如果想还原：双击同目录下的「恢复原版.cmd」。'
Say ''
Say '  说明：' 'DarkGray'
Say '    · 视频本身没有 4K 源时仍会显示较低档位（这是正常的，不是补丁失效）；' 
Say '    · 客户端自动更新后如果 4K 消失，重新双击「一键开启4K.cmd」即可；'
Say '    · 补丁只作用于本机的抖音客户端，不改系统、不联网。'
Say ''

if ($StartAfter) {
  try {
    Start-Process (Join-Path $info.Root 'douyin.exe')
    Ok '已启动抖音'
  } catch {}
}

if ($Pause) { Read-Host '按回车退出' | Out-Null }
exit 0
