#requires -Version 7.0
[CmdletBinding()]
param([string]$PackagingDirectory = (Join-Path $PSScriptRoot '../packaging/windows'))
$ErrorActionPreference = 'Stop'
$root = [IO.Directory]::CreateTempSubdirectory('cage-installer-shutdown-').FullName
$target = Join-Path $root 'installed'
$profileDir = [IO.Directory]::CreateDirectory((Join-Path $root 'profile')).FullName
$resources = [IO.Directory]::CreateDirectory((Join-Path $target 'resources')).FullName
$fresh = [IO.Directory]::CreateDirectory((Join-Path $root 'stage')).FullName
$backend = Join-Path $fresh 'cage.exe'
$launcher = Join-Path $target 'Cage.exe'
$originalConfig = $env:CLAUDE_CAGE_CONFIG
$env:CLAUDE_CAGE_CONFIG = Join-Path $profileDir 'config.json'
$processes = [Collections.Generic.List[Diagnostics.Process]]::new()
$systemShell = Join-Path $env:WINDIR 'SysWOW64/WindowsPowerShell/v1.0/powershell.exe'
$runHelper = Join-Path $root 'run-helper.ps1'

function Start-Fixture($file, $arguments) {
    $p = Start-Process $file -ArgumentList $arguments -WindowStyle Hidden -PassThru
    $processes.Add($p)
    return $p
}
function Check-Close($expected, [switch]$StopEnvironment, [switch]$CloseIdleClient, [switch]$CheckElevation) {
    $argsForHelper = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        ('"' + $runHelper + '"'), '-Helper', ('"' + (Join-Path $PackagingDirectory 'close-installation.ps1') + '"'),
        '-Target', ('"' + $target + '"'), '-Backend', ('"' + $backend + '"'))
    if ($StopEnvironment) { $argsForHelper += '-StopEnvironment' }
    if ($CloseIdleClient) { $argsForHelper += '-CloseIdleClient' }
    if ($CheckElevation) { $argsForHelper += '-CheckElevation' }
    # A separate console keeps the simulated Simplified Chinese code page local.
    $shell = Start-Process $systemShell -ArgumentList $argsForHelper -WindowStyle Hidden -PassThru
    try {
        if (!$shell.WaitForExit(60000)) { throw 'Installer shutdown test timed out' }
        if ($shell.ExitCode -ne $expected) { throw "Expected helper exit $expected, received $($shell.ExitCode)" }
    } finally { $shell.Dispose() }
}
try {
    @'
param([string]$Helper, [string]$Target, [string]$Backend, [switch]$StopEnvironment, [switch]$CloseIdleClient, [switch]$CheckElevation)
[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(936)
if ($CheckElevation) { & $Helper -Target $Target -CheckElevation }
else { & $Helper -Target $Target -Backend $Backend -StopEnvironment:$StopEnvironment -CloseIdleClient:$CloseIdleClient }
exit $LASTEXITCODE
'@ | Set-Content -LiteralPath $runHelper
    $src = Join-Path $root 'fixture.cs'
    @'
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Windows.Forms;

class Fixture : Form {
    [DllImport("advapi32", SetLastError=true)]
    static extern bool SetKernelObjectSecurity(IntPtr handle, int flags, byte[] descriptor);

    static void RestrictInspection(bool denyTerminate) {
        // Some real desktops allow query, wait and termination but refuse
        // PROCESS_ALL_ACCESS. Deny VM_READ to reproduce that condition.
        var sid = WindowsIdentity.GetCurrent().User.Value;
        var mask = denyTerminate ? "0x11" : "0x10";
        var acl = new RawSecurityDescriptor("D:(D;;" + mask + ";;;" + sid + ")(A;;GA;;;" + sid + ")(A;;GA;;;SY)");
        var bytes = new byte[acl.BinaryLength];
        acl.GetBinaryForm(bytes, 0);
        using (var self = Process.GetCurrentProcess())
            if (!SetKernelObjectSecurity(self.Handle, 4, bytes))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    protected override void WndProc(ref Message m) {
        if (m.Msg == 0x11) { m.Result = IntPtr.Zero; return; } // refuse graceful shutdown
        base.WndProc(ref m);
    }
    [STAThread]
    static int Main(string[] args) {
        var profile = Path.GetDirectoryName(Environment.GetEnvironmentVariable("CLAUDE_CAGE_CONFIG"));
        var running = Path.Combine(profile, "running");
        if (args[0] == "prepare-update") {
            bool stop = Array.IndexOf(args, "--stop") >= 0;
            File.AppendAllText(Path.Combine(profile, "calls"), stop ? "S" : "P");
            if (stop && File.Exists(Path.Combine(profile, "stop-failed"))) return 1;
            var swap = Path.Combine(profile, "swap-record");
            if (!stop && File.Exists(swap)) File.Copy(swap, Path.Combine(profile, "control.json"), true);
            if (stop) File.Delete(running);
            var reply = File.Exists(running) ? "{\"status\":\"stop_required\",\"message\":\"请保存文件后确认停止环境并安装更新。终端任务会结束，项目和登录状态会保留。\"}" : "{\"status\":\"prepared\"}";
            var bytes = Encoding.UTF8.GetBytes(reply);
            Console.OpenStandardOutput().Write(bytes, 0, bytes.Length);
            return 0;
        }
        if (args[0] == "wait") {
            using (var parent = Process.GetProcessById(int.Parse(args[1]))) parent.WaitForExit();
            return 0;
        }
        if (args[0] == "controller") {
            while (File.Exists(running)) Thread.Sleep(20);
            return 0;
        }
        RestrictInspection(args[0] == "deny-terminate");
        var dir = args.Length > 1 ? args[1] : profile;
        string scope = WindowsIdentity.GetCurrent().User.Value + "\0" + Path.GetFullPath(dir).ToUpperInvariant();
        using (var sha = SHA256.Create()) {
            var name = "Cage-" + BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(scope)), 0, 12).Replace("-", "");
            var pipeThread = new Thread(() => {
                while (true) using (var pipe = new NamedPipeServerStream(name, PipeDirection.In)) {
                    File.WriteAllText(Path.Combine(dir, "ready"), "");
                    pipe.WaitForConnection(); pipe.ReadByte();
                }
            });
            pipeThread.IsBackground = true; pipeThread.Start();
            using (var form = new Fixture()) { var handle = form.Handle; Application.Run(); }
        }
        return 0;
    }
}
'@ | Set-Content -LiteralPath $src -Encoding utf8BOM
    & "$env:WINDIR/Microsoft.NET/Framework64/v4.0.30319/csc.exe" /nologo /platform:x64 /r:System.Windows.Forms.dll "/out:$launcher" $src
    if ($LASTEXITCODE) { throw 'Failed to compile isolated test executable' }
    $oldBackend = Join-Path $resources 'cage.exe'
    Copy-Item -LiteralPath $launcher -Destination $backend
    Copy-Item -LiteralPath $launcher -Destination $oldBackend
    $client = Start-Fixture $launcher 'window'
    $limit = [DateTime]::UtcNow.AddSeconds(8)
    while (!(Test-Path -LiteralPath "$profileDir/ready")) {
        if ($client.HasExited -or [DateTime]::UtcNow -gt $limit) { throw 'Window pipe did not start' }
        Start-Sleep -Milliseconds 50
    }
    # Same image and user, another profile: refuse before touching either window.
    $otherDir = [IO.Directory]::CreateDirectory((Join-Path $root 'other profile')).FullName
    $other = Start-Fixture $launcher ('window "' + $otherDir + '"')
    Check-Close 111 -StopEnvironment
    if ($other.HasExited -or $client.HasExited) { throw 'Foreign profile closed' }
    $other.Kill(); $other.WaitForExit()

    $helper = Start-Fixture $oldBackend "wait $($client.Id)"
    $qemuDir = [IO.Directory]::CreateDirectory((Join-Path $resources 'runtime/qemu')).FullName
    $qemu = Join-Path $qemuDir 'qemu-system-x86_64.exe'
    Copy-Item -LiteralPath $launcher -Destination $qemu
    $guest = Start-Fixture $qemu "wait $PID"
    Check-Close 112 -StopEnvironment
    if ($guest.HasExited -or $client.HasExited -or $helper.HasExited) { throw 'Live VM or window closed' }
    $guest.Kill(); $guest.WaitForExit()

    $record = Join-Path $profileDir 'control.json'
    $calls = Join-Path $profileDir 'calls'
    $running = Join-Path $profileDir 'running'
    [IO.File]::WriteAllText($running, '')
    @{pid=$PID} | ConvertTo-Json | Set-Content -LiteralPath $record
    Check-Close 111 -StopEnvironment
    @{pid=$helper.Id} | ConvertTo-Json | Set-Content -LiteralPath $record
    [IO.File]::WriteAllText($calls, '')
    $closeScript = Join-Path $PackagingDirectory 'close-installation.ps1'
    & $systemShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $closeScript -Target $target -Backend $backend -WizardProcessId $client.Id
    if ($LASTEXITCODE -ne 111) { throw 'Shutdown accepted an unpaired wizard PID' }
    & $systemShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $closeScript -RequestElevation -Installer $launcher -WizardProcessId $PID
    if ($LASTEXITCODE -ne 111) { throw 'UAC handoff accepted a PID from a different executable' }
    & $systemShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $closeScript -Target $target -Backend $backend -WizardProcessId $client.Id -Installer $launcher -StopEnvironment
    if ($LASTEXITCODE -ne 111) { throw 'Shutdown accepted a wizard running at the same privilege level' }
    Check-Close 0 -CheckElevation
    if ($client.HasExited -or [IO.File]::ReadAllText($calls) -ne '') { throw 'Elevation check performed shutdown work' }
    Check-Close 109 -CloseIdleClient
    if ($client.HasExited -or !(Test-Path -LiteralPath $running) -or [IO.File]::ReadAllText($calls) -ne 'P') {
        throw 'Idle-only cleanup did not wait for permission to stop an active environment'
    }
    [IO.File]::WriteAllText((Join-Path $profileDir 'stop-failed'), '')
    Check-Close 117 -StopEnvironment
    if ($client.HasExited -or $helper.HasExited -or !(Test-Path -LiteralPath $running)) {
        throw 'Failed guest shutdown closed the application or its helper'
    }
    Remove-Item -LiteralPath (Join-Path $profileDir 'stop-failed')
    Remove-Item -LiteralPath $record
    Check-Close 111 -StopEnvironment
    if ($client.HasExited -or !(Test-Path -LiteralPath $running)) { throw 'Unregistered controller was stopped' }

    # Unregistered helper cannot exit until the frontend releases it.
    Remove-Item -LiteralPath $running
    [IO.File]::WriteAllText($calls, '')
    Check-Close 0 -CloseIdleClient
    if (!$client.HasExited -or !$helper.HasExited -or ([IO.File]::ReadAllText($calls) -ne 'P')) {
        throw 'Idle handoff did not close the window before waiting for its helper'
    }
    [IO.File]::WriteAllText($running, '')
    [IO.File]::WriteAllText($calls, '')
    $controller = Start-Fixture $oldBackend 'controller'
    @{pid=$controller.Id} | ConvertTo-Json | Set-Content -LiteralPath $record
    $swap = Join-Path $profileDir 'swap-record'
    @{pid=$PID} | ConvertTo-Json | Set-Content -LiteralPath $swap
    Check-Close 111 -StopEnvironment
    if ($controller.HasExited -or [IO.File]::ReadAllText($calls) -ne 'P') { throw 'Changed owner accepted before stopping the environment' }
    Remove-Item -LiteralPath $swap
    [IO.File]::WriteAllText($calls, '')
    @{pid=$controller.Id} | ConvertTo-Json | Set-Content -LiteralPath $record
    Check-Close 0 -StopEnvironment
    if (!$controller.HasExited -or [IO.File]::ReadAllText($calls) -ne 'PS') {
        throw 'A registered running environment did not stop after its initial probe'
    }
    Remove-Item -LiteralPath $record, "$profileDir/ready"
    $protectedClient = Start-Fixture $launcher 'deny-terminate'
    $limit = [DateTime]::UtcNow.AddSeconds(8)
    while (!(Test-Path -LiteralPath "$profileDir/ready")) {
        if ($protectedClient.HasExited -or [DateTime]::UtcNow -gt $limit) { throw 'Protected window did not start' }
        Start-Sleep -Milliseconds 50
    }
    Check-Close 114 -StopEnvironment
    if ($protectedClient.HasExited) { throw 'Process protection was bypassed' }
    Write-Host 'Installer shutdown passed: 32-bit PowerShell, pinned 64-bit window, active and idle handoff, VM and profile isolation, parent-dependent helper.'
} finally {
    $env:CLAUDE_CAGE_CONFIG = $originalConfig
    foreach ($p in $processes) {
        try { if (!$p.HasExited) { $p.Kill(); $p.WaitForExit() } } finally { $p.Dispose() }
    }
    $full = [IO.Path]::GetFullPath($root)
    if ([IO.Directory]::GetParent($full).FullName -eq [IO.Path]::GetTempPath().TrimEnd('\') -and
        [IO.Path]::GetFileName($full).StartsWith('cage-installer-shutdown-')) { Remove-Item -LiteralPath $full -Recurse -Force }
}
