# Copy on select for the Reader: presses Ctrl+C in the herdr window, so the window's own Ctrl+C
# binding copies the text just selected in a message (a mod cannot read or copy that selection).
# Presses nothing unless herdr-app is the foreground window, so the key never lands in another app.
#   powershell -File copy-key.ps1 [-DryRun]   (-DryRun: print the foreground process, press nothing)
param([switch]$DryRun)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class HerdrKeys {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@

$fgPid = [uint32]0
[void][HerdrKeys]::GetWindowThreadProcessId([HerdrKeys]::GetForegroundWindow(), [ref]$fgPid)
$name = (Get-Process -Id $fgPid -ErrorAction SilentlyContinue).ProcessName
if ($DryRun) { "foreground: $name"; exit 0 }
if ($name -ne 'herdr-app') { exit 1 }

$CTRL = 0x11; $C = 0x43; $UP = 2
[HerdrKeys]::keybd_event($CTRL, 0, 0, [UIntPtr]::Zero)
[HerdrKeys]::keybd_event($C, 0, 0, [UIntPtr]::Zero)
[HerdrKeys]::keybd_event($C, 0, $UP, [UIntPtr]::Zero)
[HerdrKeys]::keybd_event($CTRL, 0, $UP, [UIntPtr]::Zero)
