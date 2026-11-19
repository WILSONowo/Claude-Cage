#requires -Version 7.0
# Real NSIS on the current Windows user; all mutable host integration is redirected.
param([Parameter(Mandatory)][string]$OutputDirectory, [string]$AppDirectory,
    [string]$MakeNSIS = 'makensis.exe', [string]$PackagingDirectory = (Join-Path $PSScriptRoot '../packaging/windows'),
    [switch]$Baseline, [string]$PreviousAppDirectory, [switch]$UpdateRunningDesktop)
$ErrorActionPreference = 'Stop'
if ($PreviousAppDirectory -and (!$AppDirectory -or !(Test-Path -LiteralPath (Join-Path $AppDirectory 'resources/cage.exe')))) {
    throw 'Live upgrade requires a complete new application payload.'
}
$id = [guid]::NewGuid().ToString('N')
$root = [IO.Directory]::CreateDirectory((Join-Path $OutputDirectory $id)).FullName
$build = [IO.Directory]::CreateDirectory((Join-Path $root 'build')).FullName
$keyName = 'Software\CageInstallerTests\' + $id
$key = 'HKCU:\' + $keyName
$target = Join-Path $root 'old'
$other = Join-Path $root 'updated'
$profileDir = [IO.Directory]::CreateDirectory((Join-Path $root 'profile')).FullName
$previousConfig = $env:CLAUDE_CAGE_CONFIG
$env:CLAUDE_CAGE_CONFIG = Join-Path $profileDir 'config.json'
$setup = Join-Path $root 'fixture.exe'
$script:reports = [ordered]@{}
function Assert([bool]$condition, [string]$message) { if (!$condition) { throw $message } }
function Run-Setup([string]$installDir, [string]$phase, [int]$expected, [scriptblock]$afterStart, [switch]$Update) {
    $report = Join-Path $root ($phase + '.json')
    $options = @('/S','/DESKTOPSHORTCUT=1','/STARTMENUSHORTCUT=1')
    if ($Update) { $options += '/UPDATE' }
    $options += @(('/DIAGNOSTICS="' + $report + '"'), ('/D=' + $installDir))
    $process = Start-Process -FilePath $setup -ArgumentList $options -WindowStyle Hidden -PassThru
    try {
        if ($afterStart) { & $afterStart }
        if (!$process.WaitForExit(600000)) { throw "NSIS timed out in $phase" }
        $script:reports[$phase] = Get-Content -Raw -LiteralPath $report | ConvertFrom-Json
        Assert ($process.ExitCode -eq $expected) "$phase returned $($process.ExitCode): $(Get-Content -Raw -LiteralPath $report)"
    } finally {
        if (!$process.HasExited) { $process.Kill($true); $process.WaitForExit() }
        $process.Dispose()
    }
}
try {
    foreach ($name in 'Cage.ico','CageInstallerOptions.nsh','installation-files.ps1','verified-file-deletion.cs') { Copy-Item -LiteralPath (Join-Path $PackagingDirectory $name) -Destination $build }
    foreach ($name in 'close-installation.ps1','installer-process.cs') {
        $file = Join-Path $PackagingDirectory $name
        if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination $build }
    }
    $source = Get-Content -Raw -LiteralPath (Join-Path $PackagingDirectory 'Cage.nsi')
    $source = $source.Replace('Software\Microsoft\Windows\CurrentVersion\Uninstall\ClaudeCage',$keyName).Replace('Global\Cage.Installation',('Local\CageInstallerTests.' + $id))
    $source = $source.Replace('SetCompressorDictSize 32', 'SetCompress off')
    # Emulate a scanner holding the staging directory without delete sharing
    # exactly at publication. Only this isolated installer owns the handle.
    $holdStage = @'
  !insertmacro InstallPhase "publishing_application"
  IfFileExists "$INSTDIR.hold-stage" 0 +2
    System::Call 'kernel32::CreateFileW(w "$StageDir", i 1, i 1, p 0, i 3, i 0x02000000, p 0) p .r8'
'@
    $source = $source.Replace('  !insertmacro InstallPhase "publishing_application"', $holdStage.TrimEnd())
    $failedPublish = @'
  ${If} ${Errors}
    IfFileExists "$INSTDIR.hold-stage" 0 +2
      System::Call 'kernel32::CloseHandle(p r8)'
    ${If} $BackupDir != ""
'@
    $source = [regex]::Replace($source, '(?m)^  \$\{If\} \$\{Errors\}\r?\n    \$\{If\} \$BackupDir != ""', [Text.RegularExpressions.MatchEvaluator]{ param($m) $failedPublish.TrimEnd() })
    foreach ($item in @(@('$DESKTOP','Desktop'),@('$SMPROGRAMS','Programs'))) {
        $directory = [IO.Directory]::CreateDirectory((Join-Path $root $item[1])).FullName
        $source = $source.Replace($item[0], $directory.Replace('$','$$'))
    }
    Assert (!$source.Contains('$DESKTOP') -and !$source.Contains('$SMPROGRAMS') -and !$source.Contains('Uninstall\ClaudeCage')) 'Unsafe NSIS fixture integration'
    Set-Content -LiteralPath (Join-Path $build 'Cage.nsi') -Value $source -Encoding utf8NoBOM
    if (!$AppDirectory) {
        $AppDirectory = [IO.Directory]::CreateDirectory((Join-Path $root 'payload')).FullName
        [IO.File]::WriteAllText((Join-Path $AppDirectory 'Cage.install-id'), 'io.github.lee-xeo.claude-cage')
        [IO.File]::WriteAllText((Join-Path $AppDirectory 'LICENSE.txt'), 'Isolated installation test')
        $src = Join-Path $build 'fixture.cs'
        Set-Content -LiteralPath $src 'class Fixture { static int Main() { return 0; } }'
        & "$env:WINDIR/Microsoft.NET/Framework64/v4.0.30319/csc.exe" /nologo "/out:$AppDirectory/Cage.exe" $src
        Assert ($LASTEXITCODE -eq 0) 'Could not build fixture launcher'
        $fixtureResources = [IO.Directory]::CreateDirectory((Join-Path $AppDirectory 'resources')).FullName
        Copy-Item -LiteralPath (Join-Path $AppDirectory 'Cage.exe') -Destination (Join-Path $fixtureResources 'cage.exe')
        $files = @(Get-ChildItem -LiteralPath $AppDirectory -File -Recurse | ForEach-Object { @{path=[IO.Path]::GetRelativePath($AppDirectory, $_.FullName).Replace('\','/'); sha256=(Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant()} })
        @{version=1; files=$files} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $AppDirectory 'Cage.install-files.json')
    }
    $AppDirectory = (Get-Item -LiteralPath $AppDirectory).FullName
    $version = (Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '../VERSION')).Trim()
    & $MakeNSIS /V2 /INPUTCHARSET UTF8 "/DAPP_DIR=$AppDirectory" "/DVERSION=$version" "/DVERSION_NUMERIC=$(($version -split '-')[0]).0" "/DFILE_MANIFEST=$AppDirectory\Cage.install-files.json" "/DOUTPUT_FILE=$setup" (Join-Path $build 'Cage.nsi')
    Assert ($LASTEXITCODE -eq 0) 'Could not compile NSIS'
    if (!$Baseline) {
        # Exercise the real close-only extraction, nsExec, and PowerShell compiler.
        # A test runner is never a valid wizard. Reaching the identity rejection
        # proves the component loaded without performing any shutdown.
        $probe = Start-Process -FilePath $setup -ArgumentList "/S /CAGECLOSE=$PID" -WindowStyle Hidden -PassThru
        try {
            Assert ($probe.WaitForExit(60000)) 'Close-only bootstrap timed out'
            Assert ($probe.ExitCode -eq 111) "Close-only bootstrap failed before wizard verification: $($probe.ExitCode)"
            $reports.closeHelperLoaded = $true
        } finally {
            if (!$probe.HasExited) { $probe.Kill($true); $probe.WaitForExit() }
            $probe.Dispose()
        }
    }
    if ($PreviousAppDirectory) {
        $previous = (Get-Item -LiteralPath $PreviousAppDirectory).FullName
        Copy-Item -LiteralPath $previous -Destination $target -Recurse
        $sentinel = Join-Path $target 'personal-upgrade-check.txt'
        [IO.File]::WriteAllText($sentinel, $id)
        $oldVersion = (Get-Content -Raw -LiteralPath (Join-Path $target 'version.txt')).Trim()
        $expectedVersion = (Get-Content -Raw -LiteralPath (Join-Path $AppDirectory 'version.txt')).Trim()
        $oldBackend = Join-Path $target 'resources/cage.exe'
        $record = Join-Path $profileDir 'desktop-entry/control.json'
        $old = Start-Process -FilePath (Join-Path $target 'Cage.exe') -WorkingDirectory $target -WindowStyle Hidden -PassThru
        $fileLock = $null
        $controller = $null
        try {
            $until = [DateTime]::UtcNow.AddSeconds(45)
            do {
                Start-Sleep -Milliseconds 100
                $old.Refresh()
                if ($old.HasExited) { throw 'The isolated old desktop exited before upgrade.' }
            } until ((Test-Path -LiteralPath $record) -or [DateTime]::UtcNow -ge $until)
            $pidRecord = (Get-Content -Raw -LiteralPath $record | ConvertFrom-Json).pid
            $controller = Get-Process -Id $pidRecord
            Assert ($controller.Path -eq $oldBackend) 'Unexpected old controller path.'
            if ($old.MainWindowHandle -ne 0) { $null = $old.CloseMainWindow() }
            do { Start-Sleep -Milliseconds 100; $old.Refresh() }
            until ($old.MainWindowHandle -eq 0 -or $old.HasExited -or [DateTime]::UtcNow -ge $until)
            Assert (!$old.HasExited -and $old.MainWindowHandle -eq 0 -and !$controller.HasExited) 'The old desktop and its controller must both be running in the tray case.'

            # A reader such as an inventory tool can retain an executable briefly
            # after the app exits. Keep that file open across the process handoff.
            $fileLock = [IO.File]::Open((Join-Path $target 'resources/mihomo.exe'), 'Open', 'Read', 'Read')
            $expectedExit = if ($Baseline) { 2 } else { 0 }
            Run-Setup $target 'upgrade-running-desktop' $expectedExit -Update:$UpdateRunningDesktop -afterStart {
                if (!$old.WaitForExit(120000)) { throw 'The installer did not stop the old tray application.' }
                Start-Sleep -Seconds 2
                $fileLock.Dispose()
            }
            Assert ($controller.WaitForExit(5000)) 'The old controller survived the upgrade.'
            Assert (([IO.File]::ReadAllText($sentinel)) -eq $id) 'The upgrade changed a personal file.'
            $reports.oldVersion = $oldVersion
            $reports.oldTrayExited = $old.HasExited
            $reports.oldControllerExited = $controller.HasExited
            if ($Baseline) {
                Assert ($reports['upgrade-running-desktop'].phase -eq 'checking_stopped_processes') 'The baseline failed outside the expected locked-file check.'
            } else {
                Assert ((Get-Content -LiteralPath (Join-Path $target 'version.txt') -Raw).Trim() -eq $expectedVersion) 'Wrong replacement version.'
                Assert ((Get-ItemProperty -LiteralPath $key).InstallLocation -eq $target) 'Upgrade registration missing.'
                . (Join-Path $PSScriptRoot 'windows-common.ps1')
                $previousTemp = $env:RUNNER_TEMP
                $env:RUNNER_TEMP = $root
                try { Assert-WindowsWorkbench $target } finally { $env:RUNNER_TEMP = $previousTemp }
                $reports.newVersion = $expectedVersion
                $reports.nativeWorkbench = $true
            }
            return
        } finally {
            if ($fileLock) { $fileLock.Dispose() }
            # These are pinned handles to the isolated copies we started.
            if (!$old.HasExited) { $old.Kill($true); $old.WaitForExit() }
            $old.Dispose()
            if ($controller) {
                if (!$controller.HasExited -and !$controller.WaitForExit(3000)) { $controller.Kill(); $controller.WaitForExit() }
                $controller.Dispose()
            }
        }
    }
    if (!$Baseline) {
        $publishTarget = Join-Path $root 'fresh-locked-stage'
        $holdMarker = "$publishTarget.hold-stage"
        [IO.File]::WriteAllText($holdMarker, '')
        Run-Setup $publishTarget 'held-stage' 2
        Remove-Item -LiteralPath $holdMarker
        $receipt = "$publishTarget.cage-installation.json"
        Assert ($reports['held-stage'].phase -eq 'publishing_application' -and $reports['held-stage'].win32Error -in @(5,32,33)) "Fresh publish hid the sharing error; receipt remains: $(Test-Path -LiteralPath $receipt)"
        Assert (!(Test-Path -LiteralPath $receipt)) 'Failed fresh publication blocked its retry with an empty receipt'
        # An older failed wizard left this exact receipt on disk. Pending
        # transfer entries must still block a retry, even if their paths vanished.
        $stale = @{kind='cage-installation'; version=1; installPath=$publishTarget; stagePath=(Join-Path $root 'absent-stage'); backupPath=''; files=@(); directories=@(); moves=@(@{path='project.txt'; state='prepared'})}
        $stale | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $receipt
        $before = (Get-FileHash -LiteralPath $receipt).Hash
        Run-Setup $publishTarget 'unresolved-fresh-receipt' 2
        Assert ((Get-FileHash -LiteralPath $receipt).Hash -eq $before) 'An unresolved receipt was changed'
        $stale.moves = @()
        $stale | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $receipt
        Run-Setup $publishTarget 'held-stage-retry' 0
    }
    Run-Setup $target 'fresh' 0
    $instance = [IO.Directory]::CreateDirectory((Join-Path $target 'CageData/state/windows-00000000000000000000000000000001')).FullName
    $disk = Join-Path $instance 'system.vhdx'
    [IO.File]::WriteAllText($disk, 'fixture VM disk only')
    $external = [IO.Directory]::CreateDirectory((Join-Path ($target + '-external') 'state/windows-00000000000000000000000000000001')).FullName
    $binding = Join-Path $profileDir 'windows-guest.json'
    $bound = @{version=1; vm_id='00000000-0000-0000-0000-000000000001'; instance_directory=$external}
    $bound | ConvertTo-Json | Set-Content -LiteralPath $binding
    Run-Setup $target 'external-binding-same-directory' 0
    if (!$Baseline) {
        $personal = Join-Path $target 'unrelated-project'
        $null = [IO.Directory]::CreateDirectory($personal)
        $locked = [IO.File]::Open((Join-Path $personal 'open.txt'), 'CreateNew', 'ReadWrite', 'None')
        try { Run-Setup $target 'unrelated-lock' 2 } finally { $locked.Dispose() }
        $failure = $reports['unrelated-lock']
        $detail = Get-Content (Join-Path $root 'unrelated-lock.json.helper.json') -Raw | ConvertFrom-Json
        Assert ($failure.phase -eq 'moving_previous_application' -and $detail.blocked -eq 'personal') 'Missing category for a blocked personal file'
        Assert (!(Test-Path -LiteralPath ($target + '.cage-installation.json'))) 'Failed move left an unresolved transaction'
        $bound.instance_directory = $personal
        $bound | ConvertTo-Json | Set-Content -LiteralPath $binding
        Run-Setup $target 'guest-outside-kept-tree' 2
        Assert ($reports['guest-outside-kept-tree'].helperExit -eq '108') 'Installer would move an active registration outside CageData'
    }
    $junction = New-Item -ItemType Junction -Path (Join-Path $profileDir 'state') -Target (Split-Path $instance -Parent)
    $bound.instance_directory = Join-Path $junction.FullName (Split-Path $instance -Leaf)
    $bound | ConvertTo-Json | Set-Content -LiteralPath $binding
    $before = (Get-FileHash -LiteralPath $binding).Hash
    $diskBefore = (Get-FileHash -LiteralPath $disk).Hash
    $diskTime = [IO.File]::GetLastWriteTimeUtc($disk)
    $locked = [IO.File]::Open($disk, 'Open', 'Read', 'None')
    try {
        if ($Baseline) {
            Run-Setup $target 'bound-same-directory' 2
            Assert ($reports['bound-same-directory'].phase -eq 'moving_previous_application') 'Original installer did not reproduce the directory rename failure'
            return
        }
        # Test a pre-manifest installation with a registered, exclusively locked disk.
        Remove-Item -LiteralPath (Join-Path $target 'Cage.install-files.json')
        Run-Setup $target 'bound-same-directory' 0
        Assert (Test-Path -LiteralPath (Join-Path $target 'Cage.install-files.json')) 'Legacy update did not publish the new manifest'
        Assert ((Get-ItemProperty -LiteralPath $key).InstallLocation -eq $target) 'In-place update changed registration'
        Assert (!(Test-Path -LiteralPath ($target + '.cage-installation.json'))) 'Successful update left an unfinished transaction'
        Run-Setup $other 'independent-directory' 0
        Assert ((Get-ItemProperty -LiteralPath $key).InstallLocation -eq $other) 'New installation registered the wrong path'
        $shortcut = Join-Path $root 'Desktop/Cage.lnk'
        Assert ((New-Object -ComObject WScript.Shell).CreateShortcut($shortcut).TargetPath -eq (Join-Path $other 'Cage.exe')) 'Desktop shortcut did not follow the new registration'
        $report = Join-Path $root 'superseded-uninstall.json'
        $p = Start-Process -FilePath (Join-Path $target 'Uninstall.exe') -ArgumentList @('/S',('/DIAGNOSTICS="' + $report + '"')) -WindowStyle Hidden -PassThru
        try { Assert ($p.WaitForExit(60000)) 'Uninstaller timed out' } finally { $p.Dispose() }
        $limit = [DateTime]::UtcNow.AddSeconds(120)
        do {
            Start-Sleep -Milliseconds 100
            try { $uninstall = Get-Content -Raw -LiteralPath $report -ErrorAction Stop | ConvertFrom-Json } catch { $uninstall = $null }
        } until ($uninstall.status -eq 'success' -or [DateTime]::UtcNow -gt $limit)
        Assert ($uninstall.status -eq 'success') 'Superseded uninstaller did not finish'
        Assert ((Get-ItemProperty -LiteralPath $key).InstallLocation -eq $other -and (Test-Path -LiteralPath $shortcut)) 'Old uninstaller removed new registration or shortcut'
    } finally { $locked.Dispose() }
    Assert ((Get-FileHash -LiteralPath $binding).Hash -eq $before -and (Get-FileHash -LiteralPath $disk).Hash -eq $diskBefore -and [IO.File]::GetLastWriteTimeUtc($disk) -eq $diskTime) 'Disk or binding changed'
    Assert ((Test-Path -LiteralPath (Join-Path $bound.instance_directory 'system.vhdx'))) 'Original junction binding no longer resolves'
    $reports['diskBindingPreserved'] = $true
    $reports['launchPath'] = Join-Path $other 'Cage.exe'
    if ($AppDirectory -eq (Join-Path $root 'payload')) {
        $process = Start-Process -FilePath $reports['launchPath'] -WindowStyle Hidden -Wait -PassThru
        try { Assert ($process.ExitCode -eq 0) 'New fixture program failed to start' } finally { $process.Dispose() }
        $reports['fixtureStarted'] = $true
    } else {
        . (Join-Path $PSScriptRoot 'windows-common.ps1')
        $previousTemp = $env:RUNNER_TEMP
        $env:RUNNER_TEMP = $root
        try { Assert-WindowsWorkbench $other } finally { $env:RUNNER_TEMP = $previousTemp }
        $reports['nativeWorkbench'] = $true
    }
} finally {
    if ((Test-Path -LiteralPath $key) -and $key.StartsWith('HKCU:\Software\CageInstallerTests\') -and (Split-Path $key -Leaf) -eq $id) {
        Remove-Item -LiteralPath $key
    }
    $env:CLAUDE_CAGE_CONFIG = $previousConfig
    $reports | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root 'results.json')
    Write-Output "NSIS fixture results: $root"
}
