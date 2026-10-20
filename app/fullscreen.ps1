# Prints "1" when a full-screen app / game / presentation is in front, "0" when it is gone (only on change).
# Uses SHQueryUserNotificationState — the same signal Windows uses to hold back toasts.
param([int]$ParentPid = 0)   # KungWatch's pid — exit when it is gone (crash/kill skips its cleanup)
Add-Type -Namespace KW -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);'
$last = ''
while ($true) {
  if ($ParentPid -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit }
  $s = 0
  [void][KW.Shell]::SHQueryUserNotificationState([ref]$s)
  # 2 = busy (full-screen app), 3 = full-screen Direct3D game, 4 = presentation mode
  $now = if ($s -in 2, 3, 4) { '1' } else { '0' }
  if ($now -ne $last) { [Console]::Out.WriteLine($now); [Console]::Out.Flush(); $last = $now }
  Start-Sleep -Milliseconds 1500
}
