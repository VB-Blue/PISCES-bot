[CmdletBinding()]
param(
    [ValidateSet('Inventory','Close')][string]$Action = 'Inventory',
    [Parameter(Mandatory)][string]$WorkspaceRoot,
    [int]$ExcludeId = 0,
    [int]$TargetId = 0,
    [string]$ExpectedExecutable = '',
    [string]$ExpectedStartTime = ''
)
$ErrorActionPreference = 'Stop'
$allowedRoot = [IO.Path]::GetFullPath($WorkspaceRoot).TrimEnd('\') + '\'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PiscesRestartManager {
  [StructLayout(LayoutKind.Sequential)] public struct FileTime { public uint Low; public uint High; }
  [StructLayout(LayoutKind.Sequential)] public struct UniqueProcess { public uint Pid; public FileTime Started; }
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] public static extern int RmStartSession(out uint handle, uint flags, StringBuilder key);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] public static extern int RmRegisterResources(uint handle, uint files, string[] filenames, uint count, UniqueProcess[] processes, uint services, string[] serviceNames);
  [DllImport("rstrtmgr.dll")] public static extern int RmShutdown(uint handle, uint flags, IntPtr callback);
  [DllImport("rstrtmgr.dll")] public static extern int RmEndSession(uint handle);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
}
'@
function Get-DesktopProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name = 'PISCES AI.exe' OR Name = 'electron.exe'" | Where-Object {
        $_.ProcessId -ne $ExcludeId -and $_.ExecutablePath -and
        $_.ExecutablePath.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase) -and
        $_.CommandLine -notmatch '--(?:type|task-host|desktop-launcher)(?:\s|=|$)'
    } | ForEach-Object {
        $desktopProcess = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
        if ($desktopProcess) {
            [pscustomobject]@{ pid = $_.ProcessId; executable = $_.ExecutablePath; started = $desktopProcess.StartTime.ToFileTimeUtc().ToString(); visible = [PiscesRestartManager]::IsWindowVisible($desktopProcess.MainWindowHandle) }
        }
    })
}
if ($Action -eq 'Inventory') { ConvertTo-Json -InputObject @(Get-DesktopProcesses) -Compress; return }
if ($TargetId -le 0 -or !$ExpectedExecutable -or !$ExpectedStartTime) { throw '缺少明确的待退出界面身份' }
$selectedProcess = @(Get-DesktopProcesses | Where-Object pid -EQ $TargetId)
if (!$selectedProcess.Count) { '{"closed":true,"alreadyExited":true}'; return }
if ($selectedProcess[0].executable -ne $ExpectedExecutable -or $selectedProcess[0].started -ne $ExpectedStartTime) { throw '待退出进程身份已变化，停止交接' }
$startedValue = [uint64]::Parse($ExpectedStartTime)
$uniqueProcess = New-Object PiscesRestartManager+UniqueProcess
$uniqueProcess.Pid = [uint32]$TargetId
$uniqueProcess.Started.Low = [uint32]($startedValue -band [uint64]4294967295)
$uniqueProcess.Started.High = [uint32]($startedValue -shr 32)
[uint32]$restartSession = 0
$sessionKey = New-Object Text.StringBuilder 33
$startResult = [PiscesRestartManager]::RmStartSession([ref]$restartSession, 0, $sessionKey)
if ($startResult) { throw "无法建立应用交接会话（$startResult）" }
try {
    $registerResult = [PiscesRestartManager]::RmRegisterResources($restartSession, 0, $null, 1, @($uniqueProcess), 0, $null)
    if ($registerResult) { throw "无法登记待退出界面（$registerResult）" }
    $shutdownResult = [PiscesRestartManager]::RmShutdown($restartSession, 0, [IntPtr]::Zero)
    if ($shutdownResult) { throw "旧界面未能正常退出（$shutdownResult）" }
    $remainingProcess = Get-Process -Id $TargetId -ErrorAction SilentlyContinue
    if ($remainingProcess -and !$remainingProcess.WaitForExit(8000)) { throw '旧界面退出超时' }
    '{"closed":true,"graceful":true}'
} finally { [void][PiscesRestartManager]::RmEndSession($restartSession) }
