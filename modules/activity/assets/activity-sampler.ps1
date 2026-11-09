# 采集器：每 N 毫秒吐一行 JSON —— 前台窗口标题 / 进程名 / 空闲秒数 / CPU
# 供 dsh-nuonuo-activity 插件读取。单独跑也行：
#   powershell -NoProfile -ExecutionPolicy Bypass -File activity-sampler.ps1 -Once
#   powershell -NoProfile -ExecutionPolicy Bypass -File activity-sampler.ps1 -IntervalMs 5000
#
# 注：进程名走 OpenProcess + QueryFullProcessImageNameW，
# 因为 Process.GetProcessById 在这台机上对部分进程会抛 "not running"。
param(
  [int]$IntervalMs = 5000,
  [switch]$Once,
  [switch]$NoCpu
)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8

Add-Type -AssemblyName System.Windows.Forms | Out-Null

if (-not ('NuonuoActivity' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class NuonuoActivity {
    [StructLayout(LayoutKind.Sequential)]
    struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder buf, ref int size);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    public static string ForegroundTitle() {
        IntPtr h = GetForegroundWindow();
        if (h == IntPtr.Zero) return "";
        StringBuilder sb = new StringBuilder(1024);
        GetWindowTextW(h, sb, sb.Capacity);
        return sb.ToString();
    }

    public static string ForegroundProcess() {
        IntPtr h = GetForegroundWindow();
        if (h == IntPtr.Zero) return "";
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        if (pid == 0) return "";
        IntPtr ph = OpenProcess(0x1000, false, pid);   // PROCESS_QUERY_LIMITED_INFORMATION
        if (ph == IntPtr.Zero) return "";
        try {
            int size = 1024;
            StringBuilder path = new StringBuilder(size);
            if (!QueryFullProcessImageNameW(ph, 0, path, ref size)) return "";
            string full = path.ToString();
            int slash = full.LastIndexOf('\\');
            return slash >= 0 ? full.Substring(slash + 1) : full;
        } finally { CloseHandle(ph); }
    }

    public static long IdleSeconds() {
        LASTINPUTINFO li = new LASTINPUTINFO();
        li.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
        if (!GetLastInputInfo(ref li)) return -1;
        uint now = (uint)Environment.TickCount;
        return (long)((now - li.dwTime) / 1000u);
    }
}
'@
}

function Get-Cpu {
  if ($NoCpu) { return $null }
  try {
    $v = (Get-Counter '\Processor(_Total)\% Processor Time' -SampleInterval 1 -MaxSamples 1 -ErrorAction Stop).CounterSamples[0].CookedValue
    return [math]::Round($v, 1)
  } catch { return $null }
}

function Get-Sample {
  $title = ''
  $proc = ''
  try { $title = [NuonuoActivity]::ForegroundTitle() } catch {}
  try { $proc = [NuonuoActivity]::ForegroundProcess() } catch {}
  $idle = -1
  try { $idle = [NuonuoActivity]::IdleSeconds() } catch {}
  $cpu = Get-Cpu
  $o = [ordered]@{
    t      = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    title  = $title
    proc   = $proc
    idle   = $idle
    cpu    = $cpu
    fg     = [bool]($title -ne '' -or $proc -ne '')
  }
  return ($o | ConvertTo-Json -Compress)
}

if ($Once) {
  [Console]::Out.WriteLine((Get-Sample))
  exit 0
}

while ($true) {
  [Console]::Out.WriteLine((Get-Sample))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds $IntervalMs
}
