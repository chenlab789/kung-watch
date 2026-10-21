# เด้งหน้าต่าง (และแท็บ) ของแชท Claude Code ที่ระบุ ด้วย pid ของ claude.exe
# ใช้: focus.ps1 <claudePid> [-DryRun]
# Windows Terminal: ทุกแท็บอยู่หน้าต่างเดียว → เกาะคอนโซลของแชทนั้น ตั้งชื่อแท็บเป็นรหัสชั่วคราว
# หาแท็บที่ชื่อตรงด้วย UI Automation แล้วเลือก จากนั้นคืนชื่อเดิม
param([int]$ClaudePid, [switch]$DryRun)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class KWFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, IntPtr e);
  [DllImport("kernel32.dll")] public static extern bool FreeConsole();
  [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern uint GetConsoleTitle(StringBuilder b, uint n);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool SetConsoleTitle(string t);
}
"@
$UIA = [System.Windows.Automation.AutomationElement]
$TREE = [System.Windows.Automation.TreeScope]

# 1) ไล่ process แม่จาก claude.exe จนเจอตัวที่มีหน้าต่าง
$procs = @{}
Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name | ForEach-Object { $procs[[int]$_.ProcessId] = $_ }
if (-not $procs.ContainsKey($ClaudePid)) { "notfound"; exit 1 }
$p = $ClaudePid; $hwnd = [IntPtr]::Zero; $owner = ''
for ($i = 0; $i -lt 12 -and $procs.ContainsKey($p); $i++) {
  $h = (Get-Process -Id $p -ErrorAction SilentlyContinue).MainWindowHandle
  if ($procs[$p].Name -eq 'explorer.exe') { break }   # เปิดจาก .bat → แม่คือ explorer ไม่ใช่หน้าต่างแชท
  if ($h -and $h -ne [IntPtr]::Zero) { $hwnd = $h; $owner = $procs[$p].Name; break }
  $p = [int]$procs[$p].ParentProcessId
}
# ไม่เจอหน้าต่างแม่ แต่ Windows Terminal เปิดอยู่ = WT รับคอนโซลมาโฮสต์แทน (default terminal) → ไปหาแท็บแทน
if ($hwnd -eq [IntPtr]::Zero -and (Get-Process WindowsTerminal -ErrorAction SilentlyContinue)) { $owner = 'WindowsTerminal.exe' }
if ($hwnd -eq [IntPtr]::Zero -and $owner -ne 'WindowsTerminal.exe') { "notfound"; exit 1 }

# 2) Windows Terminal → หาแท็บของแชทนี้
$tabInfo = ''
if ($owner -eq 'WindowsTerminal.exe') {
  [KWFocus]::FreeConsole() | Out-Null
  if ([KWFocus]::AttachConsole([uint32]$ClaudePid)) {
    $sb = New-Object System.Text.StringBuilder 1024
    [KWFocus]::GetConsoleTitle($sb, 1024) | Out-Null
    $orig = $sb.ToString()
    $mark = "KW-" + [guid]::NewGuid().ToString('N').Substring(0, 8)
    $cond = New-Object System.Windows.Automation.PropertyCondition($UIA::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
    $wins = $UIA::RootElement.FindAll($TREE::Children,
      (New-Object System.Windows.Automation.PropertyCondition($UIA::ClassNameProperty, 'CASCADIA_HOSTING_WINDOW_CLASS')))
    # Claude Code อัปเดตชื่อแท็บเองเรื่อยๆ (spinner) → ตั้งรหัสซ้ำแล้วหาใหม่หลายรอบ
    for ($try = 0; $try -lt 6 -and -not $tabInfo; $try++) {
      [KWFocus]::SetConsoleTitle($mark) | Out-Null
      Start-Sleep -Milliseconds (80 + 40 * $try)
      foreach ($w in $wins) {
        $tabs = $w.FindAll($TREE::Descendants, $cond)
        for ($t = 0; $t -lt $tabs.Count; $t++) {
          if ($tabs[$t].Current.Name -like "*$mark*") {
            $tabInfo = "tab $t of $($tabs.Count)"
            if (-not $DryRun) { $tabs[$t].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select() }
            $hwnd = [IntPtr]$w.Current.NativeWindowHandle
            break
          }
        }
        if ($tabInfo) { break }
      }
    }
    [KWFocus]::SetConsoleTitle($orig) | Out-Null   # คืนชื่อแท็บเดิม
    [KWFocus]::FreeConsole() | Out-Null
  }
}

if ($hwnd -eq [IntPtr]::Zero) { "notfound"; exit 1 }
if ($DryRun) { "found $owner $tabInfo"; exit 0 }
if ([KWFocus]::IsIconic($hwnd)) { [KWFocus]::ShowWindow($hwnd, 9) | Out-Null }   # SW_RESTORE
# กด Alt หลอกหนึ่งที — Windows ยอมให้ SetForegroundWindow ทำงานจากโปรเซสเบื้องหลัง
[KWFocus]::keybd_event(0x12, 0, 0, [IntPtr]::Zero); [KWFocus]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)
[KWFocus]::SetForegroundWindow($hwnd) | Out-Null
"focused $owner $tabInfo"
