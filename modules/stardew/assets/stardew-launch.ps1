# 星露谷：把游戏开起来，然后点进存档。
# 只做两件事，判断交给调用方（JS 那边读 MCP 状态更可靠，PowerShell 里比中文容易踩编码坑）。
#
#   -Launch   没有进程就启动 SMAPID，并等 18080 通
#   -Click    把窗口抢到前台，点「加载」、再点存档第一行
#   两个都给就都做（默认）
#
# 结果写进 -OutFile（UTF-8，纯 ASCII 字段）：{"launched":true,"portUp":true,"clicked":true,"note":"..."}
#
# 踩过的坑：
#   1. SendKeys 不可靠，按键可能打进别的程序 → 改坐标点击。
#   2. 抢前台要「最小化再还原 + BringWindowToTop + SetForegroundWindow」，否则点不到。
#   3. 标题画面加载要十几秒，抢太早点空 → 先等一会儿。
#   4. PowerShell 里比较中文字符串容易因编码变乱码、判断永远为真 → 校验全部交给 JS。

param(
  [string]$GameDir = 'D:\game\xlgwyv1.6.15',
  [int]$Port = 18080,
  [int]$WaitSeconds = 150,
  [switch]$Launch,
  [switch]$Click,
  [switch]$Focus,
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Continue'

if (-not $Launch -and -not $Click -and -not $Focus) { $Launch = $true; $Click = $true }

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SdwWin3 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, int e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public struct RECT { public int L; public int T; public int R; public int B; }
}
"@

$r = [ordered]@{ launched = $false; portUp = $false; clicked = $false; note = '' }

function Save-Result {
  $json = ConvertTo-Json $r -Compress
  if ($OutFile) {
    [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
  }
  Write-Output $json
}

function Test-Port([int]$p) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $ok = $c.ConnectAsync('127.0.0.1', $p).Wait(800)
    $c.Close()
    return $ok
  } catch { return $false }
}

function Get-GameProc {
  Get-Process | Where-Object { $_.ProcessName -eq 'StardewModdingAPI' } | Select-Object -First 1
}

function Force-Foreground($h) {
  if ([SdwWin3]::IsIconic($h)) { [SdwWin3]::ShowWindow($h, 9) | Out-Null; Start-Sleep -Milliseconds 400 }
  [SdwWin3]::ShowWindow($h, 6) | Out-Null
  Start-Sleep -Milliseconds 450
  [SdwWin3]::ShowWindow($h, 9) | Out-Null
  Start-Sleep -Milliseconds 550
  [SdwWin3]::BringWindowToTop($h) | Out-Null
  [SdwWin3]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 700
  return ([SdwWin3]::GetForegroundWindow() -eq $h)
}

function Click-Ratio($h, [double]$rx, [double]$ry) {
  $rect = New-Object SdwWin3+RECT
  [SdwWin3]::GetWindowRect($h, [ref]$rect) | Out-Null
  $w = $rect.R - $rect.L
  $ht = $rect.B - $rect.T
  if ($w -lt 100 -or $ht -lt 100) { return $false }
  $x = [int]($rect.L + $w * $rx)
  $y = [int]($rect.T + $ht * $ry)
  [SdwWin3]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 350
  [SdwWin3]::mouse_event(0x0002, 0, 0, 0, 0)
  Start-Sleep -Milliseconds 100
  [SdwWin3]::mouse_event(0x0004, 0, 0, 0, 0)
  Start-Sleep -Milliseconds 250
  return $true
}

# 1. 启动
$proc = Get-GameProc
if ($Launch -and -not $proc) {
  $exe = Join-Path $GameDir 'StardewModdingAPI.exe'
  if (-not (Test-Path $exe)) { $r.note = 'no-exe'; Save-Result; exit 0 }
  Start-Process -FilePath $exe -WorkingDirectory $GameDir
  $r.launched = $true
}

# 2. 等端口
$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
  if (Test-Port $Port) { $r.portUp = $true; break }
  Start-Sleep -Milliseconds 1500
}
if (-not $r.portUp) { $r.note = 'port-not-up'; Save-Result; exit 0 }

if ($Focus) {
  $pr = Get-GameProc
  if ($pr -and $pr.MainWindowHandle -ne 0) { Force-Foreground $pr.MainWindowHandle | Out-Null }
  $r.note = 'focused'
  Save-Result
  exit 0
}

if (-not $Click) { $r.note = 'launch-only'; Save-Result; exit 0 }

# 3. 等窗口
$proc = $null
for ($i = 0; $i -lt 60; $i++) {
  $proc = Get-GameProc
  if ($proc -and $proc.MainWindowHandle -ne 0) { break }
  Start-Sleep -Milliseconds 800
}
if (-not $proc -or $proc.MainWindowHandle -eq 0) { $r.note = 'no-window'; Save-Result; exit 0 }
$h = $proc.MainWindowHandle

# 4. 抢前台 + 点「加载」
Start-Sleep -Seconds 6
Force-Foreground $h | Out-Null
Click-Ratio $h 0.39 0.83 | Out-Null
Start-Sleep -Seconds 5

# 5. 点存档第一行
Force-Foreground $h | Out-Null
Click-Ratio $h 0.46 0.315 | Out-Null
$r.clicked = $true
$r.note = 'clicked'
Save-Result
