#requires -Version 7.0
[CmdletBinding()]
param([string]$Compiler, [switch]$CheckNativeDialog)
. (Join-Path $PSScriptRoot 'windows-common.ps1')
if (!$Compiler) { $Compiler = Get-BuildCommand @('makensis.exe', 'makensis') }
$packaging = (Resolve-Path (Join-Path $PSScriptRoot '../packaging/windows')).Path
$installer = Get-Content -LiteralPath (Join-Path $packaging 'Cage.nsi') -Raw
$closer = Get-Content -LiteralPath (Join-Path $packaging 'close-installation.ps1') -Raw
$temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$root = Join-Path $temp ('cage-confirmation-' + [guid]::NewGuid().ToString('N'))
$target = Join-Path $root 'Cage target'
$setup = Join-Path $root 'fixture.exe'
$trace = Join-Path $root 'trace.txt'

function Get-InstallerFunction([string]$Name) {
    $match = [regex]::Match($installer, "(?ms)^Function $Name\r?\n.*?^FunctionEnd\b")
    if (!$match.Success) { throw "Installer function missing: $Name" }
    return $match.Value
}

try {
    $null = New-Item -ItemType Directory -Path $target -Force
    [IO.File]::WriteAllText((Join-Path $target 'Cage.install-id'), 'io.github.lee-xeo.claude-cage')
    $null = New-Item -ItemType Directory -Path (Join-Path $root resources)
    Set-Content -LiteralPath (Join-Path $root resources/cage.exe) -Value "Fixture backend sentinel"
    # Only this double is bundled. It cannot enumerate or terminate processes.
    $double = @'
param([string]$Target, [string]$Backend, [switch]$StopEnvironment,
      [switch]$CloseIdleClient, [switch]$RequestElevation, [switch]$CheckElevation, [switch]$CheckWizard,
      [int]$WizardProcessId, [string]$Installer)
$ErrorActionPreference = 'Stop'

function Record([string]$Value) {
    [IO.File]::AppendAllText($env:CAGE_TEST_TRACE, "$Value`n")
}
if ($RequestElevation) {
    Record 'uac'
    if ($env:CAGE_TEST_UAC -eq 'deny') { exit 1223 }
    if ($Installer -ne $env:CAGE_TEST_SETUP -or $WizardProcessId -le 0) { throw 'Invalid relaunch' }
    $env:CAGE_TEST_CHILD = '1'
    $child = Start-Process -FilePath $Installer -ArgumentList __RELAUNCH_ARGUMENTS__ -WindowStyle Hidden -PassThru
    [IO.File]::WriteAllText($env:CAGE_TEST_CHILD_PID, [string]$child.Id)
    [Console]::Write($child.Id)
    exit 0
}
if ($CheckWizard) {
    if ($Installer -ne $env:CAGE_TEST_SETUP -or $WizardProcessId -le 0) { exit 111 }
    exit 0
}
if ($Target -ne $env:CAGE_TEST_TARGET) { throw "Unexpected target: $Target" }
$side = if ($env:CAGE_TEST_CHILD -eq '1') { 'child' } else { 'parent' }
$operation = if ($CheckElevation) { 'check' } elseif ($StopEnvironment) { 'stop' } elseif ($CloseIdleClient) { 'idle' } else { 'probe' }
Record "$side/$operation"
if ($side -eq 'child' -and ($Installer -ne $env:CAGE_TEST_SETUP -or $WizardProcessId -le 0)) { throw 'Missing parent proof' }
if ($side -eq 'parent' -and $env:CAGE_TEST_ELEVATED -eq '1') { exit 115 }
if (!$CheckElevation -and !$StopEnvironment -and $env:CAGE_TEST_RUNNING -eq '1') { exit 109 }
exit 0
'@
    $arguments = [regex]::Match($closer, '(?m)^\s*\$start\.Arguments = ("[^"\r\n]*CAGECLOSE[^"\r\n]*")')
    if (!$arguments.Success) { throw 'Missing close-only relaunch arguments' }
    $double.Replace('__RELAUNCH_ARGUMENTS__', $arguments.Groups[1].Value) | Set-Content -LiteralPath (Join-Path $root 'close-installation.ps1')
    Set-Content -LiteralPath (Join-Path $root 'installer-process.cs') -Value '// fixture'
    $functions = @(foreach ($name in 'RunCloseWithConsent','RunElevatedClose','PrepareReplacement','WriteInstallDiagnostic','CloseBroker','LaunchCloseBroker','StartCloseBroker','RequestBrokerClose') {
        Get-InstallerFunction $name
    }) -join "`n"
    # Exercise the ordinary wizard on runners launched with either token.
    $functions = $functions.Replace("System::Call 'shell32::IsUserAnAdmin() i.r0'", 'StrCpy $0 0')
    # An unexpected new prompt must fail CI rather than opening a window.
    $functions = [regex]::Replace($functions, '(?m)^\s*MessageBox\s+([^\r\n]+)', {
        param($match)
        $arguments = $match.Groups[1].Value
        if ($arguments -notmatch '/SD' -and $arguments -match 'MB_(YESNO|OKCANCEL)\|' -and $arguments -match '\bID(?:YES|OK)\s+(\w+)') {
            return ('  !insertmacro Record "confirm"' + "`n" +
                '  ReadEnvStr $R9 CAGE_TEST_NATIVE_DIALOG' + "`n" +
                '  ${If} $R9 == 1' + "`n    MessageBox " + $arguments + "`n  " + '${Else}' + "`n" +
                '  ReadEnvStr $R9 CAGE_TEST_CONSENT' + "`n" +
                '  StrCmp $R9 yes ' + $Matches[1] + "`n  " + '${EndIf}')
        }
        if ($arguments -match 'MB_RETRYCANCEL') { return '  !insertmacro Record "retry"' }
        throw "Unrecognized installer prompt: $arguments"
    })
    $variables = [regex]::Matches($installer, '(?m)^Var \w+\b') | ForEach-Object Value
    $dispatch = [regex]::Match((Get-InstallerFunction '\.onInit'),
        '(?ms)^  Call ParseCageInstallOptions\r?\n.*?^  \$\{EndIf\}\r?$')
    if (!$dispatch.Value.Contains('Call RunElevatedClose')) { throw 'Missing close-only startup path' }
    $startup = [regex]::Match((Get-InstallerFunction '\.onInit'), '(?ms)^  \$\{IfNot\} \$\{Silent\}\r?\n    Call StartCloseBroker.*?^  \$\{EndIf\}\r?$')
    if (!$startup.Success) { throw 'Missing startup authorization in installer initialization' }
    $source = @'
Unicode true
RequestExecutionLevel user
OutFile "fixture.exe"
!include "LogicLib.nsh"
!include "${OPTIONS}"
LangString CageConfirmStop 1033 "Cage isolated shutdown test"
__VARIABLES__
!macro Record text
  FileOpen $R8 "$EXEDIR\trace.txt" a
  FileSeek $R8 0 END
  FileWrite $R8 "${text}$\r$\n"
  FileClose $R8
!macroend
!macro InstallPhase name
  StrCpy $InstallPhase "${name}"
!macroend
!macro AbortTransaction reason
  Call CloseBroker
  Quit
!macroend
__FUNCTIONS__
Function .onInit
__DISPATCH__
  StrCmp $CageOptionError "" +3
    SetErrorLevel 3
    Quit
__STARTUP__
  !insertmacro Record "wizard"
  ReadEnvStr $R9 CAGE_TEST_LEAVE
  ${If} $R9 == 1
    Call CloseBroker
    SetErrorLevel 0
    Quit
  ${EndIf}
  StrCpy $INSTDIR $CageInstallDirectory
  StrCpy $StageDir "$EXEDIR\stage"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "close-installation.ps1"
  File "installer-process.cs"
  Call PrepareReplacement
  Call CloseBroker
  !insertmacro Record "continue"
  SetErrorLevel 0
  Quit
FunctionEnd
Section
SectionEnd
'@
    $source = $source.Replace('__VARIABLES__', ($variables -join "`n")).Replace('__FUNCTIONS__', $functions).Replace('__DISPATCH__', $dispatch.Value).Replace('__STARTUP__', $startup.Value)
    if ($source -match '(?im)^\s*(?:ExecShell|ExecWait|WriteReg)') { throw 'Unexpected live OS boundary in fixture' }
    $nsi = Join-Path $root 'fixture.nsi'
    $source | Set-Content -LiteralPath $nsi -Encoding utf8
    Invoke-BuildTool $Compiler @('/V2',"/DAPP_DIR=$root",'/INPUTCHARSET','UTF8',"/DOPTIONS=$packaging\CageInstallerOptions.nsh",$nsi)
    function Test-Consent([string]$Name, [string]$Running, [string]$Elevated, [string]$Uac, [string]$Consent,
                          [string]$Options, [int]$Code, [string]$Expected, [switch]$NativeDialog) {
        [IO.File]::WriteAllText($trace,'')
        $start = [Diagnostics.ProcessStartInfo]::new($setup)
        $start.UseShellExecute = $false
        $start.Arguments = "$Options /D=$target".Trim()
        $childPidPath = Join-Path $root 'child.pid'
        if (Test-Path $childPidPath) { Remove-Item -LiteralPath $childPidPath }
        $start.Environment['CAGE_TEST_CHILD_PID'] = $childPidPath
        $start.Environment['CAGE_TEST_LEAVE'] = [int]($Name -eq 'leave wizard')
        $start.Environment['CAGE_TEST_SETUP'] = $setup
        $start.Environment['CAGE_TEST_TARGET'] = $target
        $start.Environment['CAGE_TEST_TRACE'] = $trace
        $start.Environment['CAGE_TEST_RUNNING'] = $Running
        $start.Environment['CAGE_TEST_ELEVATED'] = $Elevated
        $start.Environment['CAGE_TEST_UAC'] = $Uac
        $start.Environment['CAGE_TEST_CONSENT'] = $Consent
        $start.Environment['CAGE_TEST_CHILD'] = '0'
        $start.Environment['CAGE_TEST_NATIVE_DIALOG'] = [int]$NativeDialog.IsPresent
        $process = [Diagnostics.Process]::Start($start)
        try {
            if ($NativeDialog) {
                $time = [Diagnostics.Stopwatch]::StartNew()
                $answered = $false
                while (!$process.HasExited -and $time.Elapsed.TotalSeconds -lt 10) {
                    # Use the window of the child launched by this fixture.
                    if (!(Test-Path $childPidPath)) { Start-Sleep -Milliseconds 50; continue }
                    $broker = Get-Process -Id ([int](Get-Content $childPidPath -Raw))
                    try { $window = $broker.MainWindowHandle } finally { $broker.Dispose() }
                    if ($window -ne [IntPtr]::Zero -and [CageConsentFixture]::GetDlgItem($window, 6) -ne [IntPtr]::Zero -and [CageConsentFixture]::GetDlgItem($window, 7) -ne [IntPtr]::Zero) {
                        $button = if ($Consent -eq 'yes') { 6 } else { 7 }
                        $control = [CageConsentFixture]::GetDlgItem($window, $button)
                        if (![CageConsentFixture]::PostMessage($control, 0xF5, 0, 0)) { throw 'Could not answer fixture dialog' }
                        $answered = $true
                        break
                    }
                    Start-Sleep -Milliseconds 50
                }
                if (!$answered) { throw 'Close-only fixture did not display its consent dialog' }
            }
            if (!$process.WaitForExit(60000)) { $process.Kill($true); throw "$Name timed out" }
            $actual = [IO.File]::ReadAllLines($trace) -join ' '
            if ($process.ExitCode -ne $Code -or $actual -ne $Expected) {
                throw "$Name returned $($process.ExitCode) [$actual], expected $Code [$Expected]"
            }
        } finally {
            if (!$process.HasExited) { $process.Kill($true); $process.WaitForExit() }
            $process.Dispose()
        }
    }
    Test-Consent 'UAC denied before wizard' 1 1 deny yes '' 1223 'uac'
    Test-Consent 'leave wizard' 1 1 allow no '' 0 'uac wizard'
    Test-Consent 'idle' 0 0 allow no '' 0 'uac wizard child/idle continue'
    Test-Consent 'running, accept' 1 0 allow yes '' 0 'uac wizard child/idle confirm child/stop continue'
    Test-Consent 'running, decline' 1 0 allow no '' 1223 'uac wizard child/idle confirm'
    Test-Consent 'unattended running' 1 0 allow yes '/S' 2 'wizard parent/probe'
    Test-Consent 'unattended elevated' 1 1 allow yes '/S' 2 'wizard parent/probe'
    Test-Consent 'authorized silent update' 1 0 allow no '/S /UPDATE' 0 'wizard parent/stop continue'
    Test-Consent 'close-only cannot run updates' 1 0 allow yes '/S /CAGECLOSE=42 /UPDATE' 2 ''
    if ($CheckNativeDialog) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CageConsentFixture {
    [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr window, int id);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
}
'@
        Test-Consent 'native close-only consent' 1 1 allow yes '' 0 'uac wizard child/idle confirm child/stop continue' -NativeDialog
        Test-Consent 'native close-only cancel' 1 1 allow no '' 1223 'uac wizard child/idle confirm' -NativeDialog
    }
    Write-Host 'Windows installer shutdown consent tests passed.'
} finally {
    if ([IO.Path]::GetDirectoryName($root) -eq $temp.TrimEnd('\') -and (Test-Path -LiteralPath $root)) {
        Remove-Item -LiteralPath $root -Recurse -Force
    }
}
