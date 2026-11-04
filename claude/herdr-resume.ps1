# Resumes Claude sessions in herdr panes after herdr-core recovers a lost
# terminal (reboot, logout, core crash) as a bare shell. The core keeps the
# terminal's address and labels, so the session is recorded on the terminal
# as hc labels: claude.session, claude.mode and claude.cwd.
#
#   SessionStart -> herdr-resume.ps1 start   records the session, mode and folder
#   SessionEnd   -> herdr-resume.ps1 end     a deliberate exit clears it
#   $PROFILE     -> & herdr-resume.ps1 shell resumes it (runs in the shell itself)

param([string]$Action = "")

if (-not $env:HC_TERMINAL_ID) { return }
$terminal = $env:HC_TERMINAL_ID

if ($Action -eq "shell") {
    try { $t = hc get $terminal --json 2>$null | ConvertFrom-Json } catch { return }
    # Only the terminal's root shell, so a nested powershell never resumes.
    if (-not $t -or $t.pid -ne $PID) { return }
    $id = $t.labels.'claude.session'
    if (-not $id -or -not $t.labels.'herdr.space') { return }
    $mode = if ($t.labels.'claude.mode') { $t.labels.'claude.mode' } else { "auto" }
    # The core recovers the shell in the launch folder; sessions are stored per folder.
    $cwd = $t.labels.'claude.cwd'
    if ($cwd -and (Test-Path $cwd)) { Set-Location $cwd }
    Write-Host "herdr-resume: claude --resume $id --permission-mode $mode" -ForegroundColor DarkGray
    claude --resume $id --permission-mode $mode
    return
}

try { $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json } catch { exit 0 }
if (-not $payload.session_id) { exit 0 }

if ($Action -eq "start") {
    # Background jobs and other child sessions inherit HC_TERMINAL_ID from the
    # pane that launched them. Only the interactive session owns the pane.
    $sessionFile = Join-Path $env:USERPROFILE ".claude\sessions\$($env:CLAUDE_PID).json"
    if (-not $env:CLAUDE_PID -or -not (Test-Path $sessionFile)) { exit 0 }
    try { $session = Get-Content $sessionFile -Raw | ConvertFrom-Json } catch { exit 0 }
    if ($session.kind -ne "interactive") { exit 0 }
    $mode = if ($payload.permission_mode) { $payload.permission_mode } else { "auto" }
    & hc label $terminal "claude.session=$($payload.session_id)" "claude.mode=$mode" "claude.cwd=$($payload.cwd)" 2>$null | Out-Null
}
elseif ($Action -eq "end") {
    # The session file is gone by now, so match the recorded session instead.
    # "other" is what a killed or shut-down session reports: keep it to resume.
    if ($payload.reason -notin @("prompt_input_exit", "logout", "bypass_permissions_disabled")) { exit 0 }
    try { $t = hc get $terminal --json 2>$null | ConvertFrom-Json } catch { exit 0 }
    if ($t.labels.'claude.session' -eq $payload.session_id) {
        & hc label $terminal "claude.session=" "claude.mode=" "claude.cwd=" 2>$null | Out-Null
    }
}
exit 0
