#requires -Version 5.1
[CmdletBinding(DefaultParameterSetName='Close')]
param(
    [Parameter(Mandatory,ParameterSetName='CheckElevation')][Parameter(Mandatory,ParameterSetName='Close')][Parameter(ParameterSetName='RequestElevation')][string]$Target,
    [Parameter(Mandatory,ParameterSetName='Close')][string]$Backend,
    [Parameter(ParameterSetName='Close')][switch]$StopEnvironment,
    [Parameter(ParameterSetName='Close')][switch]$CloseIdleClient,
    [Parameter(ParameterSetName='Close')][Parameter(Mandatory,ParameterSetName='RequestElevation')][Parameter(Mandatory,ParameterSetName='CheckWizard')][int]$WizardProcessId,
    [Parameter(ParameterSetName='Close')][Parameter(Mandatory,ParameterSetName='RequestElevation')][Parameter(Mandatory,ParameterSetName='CheckWizard')][string]$Installer,
    [Parameter(Mandatory,ParameterSetName='RequestElevation')][switch]$RequestElevation,
    [Parameter(Mandatory,ParameterSetName='CheckWizard')][switch]$CheckWizard,
    [Parameter(Mandatory,ParameterSetName='CheckElevation')][switch]$CheckElevation
)
$ErrorActionPreference = 'Stop'
# No output from controllers or configuration records (they can contain private information).
trap {
    $cause = $_.Exception.GetBaseException()
    [Console]::Error.WriteLine(("Close helper: line {0}, {1}." -f $_.InvocationInfo.ScriptLineNumber, $cause.GetType().Name))
    if ($cause -is [UnauthorizedAccessException] -or
        ($cause -is [ComponentModel.Win32Exception] -and $cause.NativeErrorCode -eq 5)) { exit 114 }
    exit 110
}

function Assert-PlainPath([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    while ($null -ne $item) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked installation path.' }
        $item = if ($item -is [IO.FileInfo]) { $item.Directory } else { $item.Parent }
    }
}

function Test-TargetController {
    $matched = $false
    foreach ($directory in $profiles) {
        $record = Join-Path $directory 'control.json'
        if (!(Test-Path -LiteralPath $record -PathType Leaf)) { continue }
        Assert-PlainPath $record
        $control = Get-Content -LiteralPath $record -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($backends | Where-Object { $_.Id -eq $control.pid -and !$_.HasExited -and [CageInstallProcess]::IsCurrentUserSession($_) }) {
            $matched = $true
        } elseif (Get-Process -Id ([int]$control.pid) -ErrorAction SilentlyContinue) {
            exit 111
        }
    }
    return $matched
}

function Assert-GuestStopped {
    $guests = [CageInstallProcess]::AtPath((Join-Path $Target 'resources/runtime/qemu/qemu-system-x86_64.exe'))
    try {
        if ($guests.Count) { exit 112 }
    } finally { foreach ($guest in $guests) { $guest.Dispose() } }
}

function Get-UpdateStatus([string]$Options) {
    if ($wizard -and $wizard.HasExited) { exit 111 }
    # The Go backend writes UTF-8 JSON regardless of the Windows console code page.
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $Backend
    $start.Arguments = "prepare-update --json $Options"
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false, $true)
    $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($start)
    try {
        $discardErrors = $process.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
        $reply = $process.StandardOutput.ReadToEnd()
        $process.WaitForExit()
        $discardErrors.GetAwaiter().GetResult() | Out-Null
        if ($process.ExitCode -eq 0) { return ($reply | ConvertFrom-Json).status }
    } finally { $process.Dispose() }
}

try {
    Add-Type -Path (Join-Path $PSScriptRoot 'installer-process.cs') -ErrorAction Stop
} catch {
    [Console]::Error.WriteLine('Could not load the installer process inspection component.')
    exit 116
}
$clients = @()
$backends = @()
$wizard = $null
$installerProcesses = @()
try {
    if ($PSBoundParameters.ContainsKey('WizardProcessId') -or $PSBoundParameters.ContainsKey('Installer')) {
        if ($WizardProcessId -le 0 -or !$Installer) { exit 111 }
        try {
            $Installer = [IO.Path]::GetFullPath($Installer)
            $installerProcesses = [CageInstallProcess]::AtPath($Installer)
            $wizard = $installerProcesses | Where-Object { $_.Id -eq $WizardProcessId -and [CageInstallProcess]::IsUnelevatedWizard($_, !$RequestElevation) }
        } catch { exit 111 }
        if (!$wizard) { exit 111 }
    }
    if ($CheckWizard) { exit 0 }
    if ($RequestElevation) {
        Assert-PlainPath $Installer
        $start = New-Object Diagnostics.ProcessStartInfo
        $start.FileName = $Installer
        $start.Arguments = "/S /CAGECLOSE=$WizardProcessId"
        $start.WorkingDirectory = [Environment]::SystemDirectory
        $start.UseShellExecute = $true
        $start.Verb = 'runas'
        if ($wizard.HasExited) { exit 111 }
        try { $child = [Diagnostics.Process]::Start($start) } catch {
            $cause = $_.Exception.GetBaseException()
            if ($cause -is [ComponentModel.Win32Exception] -and $cause.NativeErrorCode -eq 1223) { exit 1223 }
            throw
        }
        try { [Console]::Write($child.Id); exit 0 } finally { $child.Dispose() }
    }
    $Target = [IO.Path]::GetFullPath($Target)
    Assert-PlainPath $Target
    $client = Join-Path $Target 'Cage.exe'
    $oldBackend = Join-Path $Target 'resources/cage.exe'
    if ($wizard) {
        $marker = Join-Path $Target 'Cage.install-id'
        if (!(Test-Path -LiteralPath $marker -PathType Leaf)) { exit 111 }
        Assert-PlainPath $marker
        if ([IO.File]::ReadAllText($marker) -cne 'io.github.lee-xeo.claude-cage') { exit 111 }
    }
    $clients = [CageInstallProcess]::AtPath($client)
    $backends = [CageInstallProcess]::AtPath($oldBackend)
    if ([CageInstallProcess]::NeedsElevation($clients) -or [CageInstallProcess]::NeedsElevation($backends)) { exit 115 }
    if ($PSCmdlet.ParameterSetName -eq 'CheckElevation') { exit 0 }
    $clientOnly = Test-Path -LiteralPath (Join-Path $Target 'resources/client-only') -PathType Leaf
    $profile = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.claude-cage'
    if ($clientOnly) { $profile = Join-Path $profile 'client' }
    $config = if ($env:CLAUDE_CAGE_CONFIG) { [IO.Path]::GetFullPath($env:CLAUDE_CAGE_CONFIG) } else { Join-Path $profile 'config.json' }
    $profile = Split-Path -Parent $config
    $matched = $false
    $allowTerminate = $false
    if ($clients.Count -or $backends.Count) {
        if ($clients.Count) { Assert-PlainPath $client }
        if ($backends.Count) { Assert-PlainPath $oldBackend }
        Assert-PlainPath $Backend
        $profiles = @($profile)
        $newClientOnly = Test-Path -LiteralPath (Join-Path (Split-Path -Parent $Backend) 'client-only') -PathType Leaf
        if (!$clientOnly -or !$newClientOnly) { $profiles += (Join-Path $profile 'desktop-entry') }
        $matched = Test-TargetController
        $allowTerminate = $CloseIdleClient -or $StopEnvironment
        foreach ($process in $clients) {
            if ($process.HasExited -or [CageInstallProcess]::OwnsWindowPipe($process, $profile)) { continue }
            # Older launchers had only a per-user pipe. Retain graceful shutdown
            # when their controller matched; never force a legacy window closed.
            if ($process.HasExited) { continue }
            if (!$matched -or ![CageInstallProcess]::OwnsWindowPipe($process, '')) { exit 111 }
            $allowTerminate = $false
        }
    }
    if ($clients.Count -or $matched) {
        $env:CLAUDE_CAGE_CONFIG = $config
        # A clean response also verifies the profile lock and any remaining VM
        # when no controller record exists. Preserve idle handoff for old apps.
        $status = Get-UpdateStatus
        if ($status -eq 'stop_required') {
            if (!$StopEnvironment) { exit 109 }
            if (!(Test-TargetController)) { exit 111 }
            $status = Get-UpdateStatus '--stop'
            if ($status -ne 'prepared') { exit 117 }
        }
        if ($status -ne 'prepared') { exit 110 }
    }
    Assert-GuestStopped
    if ($wizard -and $wizard.HasExited) { exit 111 }
    [CageInstallProcess]::CloseWindows($clients, $client, $allowTerminate)
    # A helper blocked on its parent's pipe can exit only after the window closes.
    # Unregistered backends may serve another profile: wait but never kill them.
    $wait = [Diagnostics.Stopwatch]::StartNew()
    foreach ($process in $backends) {
        if (!$process.WaitForExit([int][Math]::Max(0L, 5000L - $wait.ElapsedMilliseconds))) { exit 111 }
    }
    $proxyPath = Join-Path $Target 'resources/mihomo.exe'
    $proxies = [CageInstallProcess]::AtPath($proxyPath)
    try {
        if ($proxies.Count) {
            Assert-PlainPath $proxyPath
            Assert-PlainPath $Backend
            Assert-GuestStopped
            $env:CLAUDE_CAGE_CONFIG = $config
            # Double trailing backslashes before the closing Windows argv quote.
            $quotedTarget = '"' + ($Target -replace '(\\+)$', '$1$1') + '"'
            if ((Get-UpdateStatus "--release-orphan-proxy $quotedTarget") -ne 'prepared') {
                if ($proxies | Where-Object { !$_.HasExited }) { exit 113 }
            }
        }
    } finally { foreach ($process in $proxies) { $process.Dispose() } }

} finally {
    foreach ($process in @($clients) + @($backends) + @($installerProcesses)) { $process.Dispose() }
}
