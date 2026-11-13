#requires -Version 7.0
# Real NSIS on the current Windows user; all mutable host integration is redirected.
param([Parameter(Mandatory)][string]$OutputDirectory, [string]$AppDirectory,
    [string]$MakeNSIS = 'makensis.exe', [string]$PackagingDirectory = (Join-Path $PSScriptRoot '../packaging/windows'),
    [switch]$Baseline)
$ErrorActionPreference = 'Stop'
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
function Run-Setup([string]$installDir, [string]$phase, [int]$expected) {
    $report = Join-Path $root ($phase + '.json')
    $process = Start-Process -FilePath $setup -ArgumentList @('/S','/DESKTOPSHORTCUT=1','/STARTMENUSHORTCUT=1',('/DIAGNOSTICS="' + $report + '"'),('/D=' + $installDir)) -WindowStyle Hidden -PassThru
    try {
        if (!$process.WaitForExit(600000)) { throw "NSIS timed out in $phase" }
        $script:reports[$phase] = Get-Content -Raw -LiteralPath $report | ConvertFrom-Json
        Assert ($process.ExitCode -eq $expected) "$phase returned $($process.ExitCode): $(Get-Content -Raw -LiteralPath $report)"
    } finally { $process.Dispose() }
}
try {
    foreach ($name in 'Cage.ico','installation-files.ps1','verified-file-deletion.cs') { Copy-Item -LiteralPath (Join-Path $PackagingDirectory $name) -Destination $build }
    $source = Get-Content -Raw -LiteralPath (Join-Path $PackagingDirectory 'Cage.nsi')
    $source = $source.Replace('Software\Microsoft\Windows\CurrentVersion\Uninstall\ClaudeCage',$keyName).Replace('Global\Cage.Installation',('Local\CageInstallerTests.' + $id))
    $source = $source.Replace('SetCompressorDictSize 32', 'SetCompress off')
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
        $files = @(Get-ChildItem -LiteralPath $AppDirectory -File | ForEach-Object { @{path=$_.Name; sha256=(Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant()} })
        @{version=1; files=$files} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $AppDirectory 'Cage.install-files.json')
    }
    $AppDirectory = (Get-Item -LiteralPath $AppDirectory).FullName
    $version = (Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '../VERSION')).Trim()
    & $MakeNSIS /V2 /INPUTCHARSET UTF8 "/DAPP_DIR=$AppDirectory" "/DVERSION=$version" "/DVERSION_NUMERIC=$(($version -split '-')[0]).0" "/DFILE_MANIFEST=$AppDirectory\Cage.install-files.json" "/DOUTPUT_FILE=$setup" (Join-Path $build 'Cage.nsi')
    Assert ($LASTEXITCODE -eq 0) 'Could not compile NSIS'
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
        $locked = [IO.File]::Open($disk, 'Open', 'Read', 'None')
        try { Run-Setup $target 'unrelated-lock' 2 } finally { $locked.Dispose() }
        $failure = $reports['unrelated-lock']
        Assert ($failure.phase -eq 'moving_previous_application' -and $failure.helperExit -match '^win32_[1-9][0-9]*$') 'Missing OS error for directory rename'
        Assert (!(Test-Path -LiteralPath ($target + '.cage-installation.json'))) 'Unrelated failed move left an unresolved transaction'
    }
    $junction = New-Item -ItemType Junction -Path (Join-Path $profileDir 'state') -Target (Split-Path $instance -Parent)
    $bound.instance_directory = Join-Path $junction.FullName (Split-Path $instance -Leaf)
    $bound | ConvertTo-Json | Set-Content -LiteralPath $binding
    $before = (Get-FileHash -LiteralPath $binding).Hash
    $diskBefore = (Get-FileHash -LiteralPath $disk).Hash
    $diskTime = [IO.File]::GetLastWriteTimeUtc($disk)
    $locked = [IO.File]::Open($disk, 'Open', 'Read', 'None')
    try {
        Run-Setup $target 'bound-same-directory' 2
        $failure = $reports['bound-same-directory']
        if ($Baseline) {
            Assert ($failure.phase -eq 'moving_previous_application') 'Original installer did not reproduce the directory rename failure'
            return
        }
        Assert ($failure.phase -eq 'checking_bound_vm_location' -and $failure.helperExit -eq '108') 'Missing actionable VM diagnostic'
        Assert ((Get-ItemProperty -LiteralPath $key).InstallLocation -eq $target) 'Refused update changed registration'
        Assert (!(Test-Path -LiteralPath ($target + '.cage-installation.json'))) 'Refused update created a rollback transaction'
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
