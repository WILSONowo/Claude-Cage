#requires -Version 5.1
# The SCM replies are fixtures. All process images, locks, waits, atomic
# swaps and backup contents below use ordinary Windows processes and NTFS.
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'install-windows-host-manager.ps1'
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$null, [ref]$errors)
if ($errors.Count) { throw $errors[0] }
foreach ($function in 'Assert-NoLink','Get-FixedManagerService','Stop-FixedManager','Replace-StoppedManager','Resume-PreviousManager') {
    $node = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $function }, $true)
    if (!$node) { throw "Missing production function $function" }
    . ([scriptblock]::Create($node.Extent.Text))
}

$root = Join-Path ([IO.Path]::GetTempPath()) ('manager-test-' + [guid]::NewGuid().ToString('N'))
$null = [IO.Directory]::CreateDirectory($root)
$exe = Join-Path $root 'Cage.HyperVManager.exe'
$binary = '"'+$exe+'" service --binding "'+(Join-Path $root 'binding.json')+'"'
$name = 'CageHV-'+[guid]::NewGuid().ToString('D')
$payload = Join-Path $root 'manager-prepare.exe'
$backup = Join-Path $root 'manager-rollback.exe'
$ping = Join-Path $env:SystemRoot 'System32/ping.exe'
$new = Join-Path $env:SystemRoot 'System32/whoami.exe'
$record = [pscustomobject]@{ State='Stopped'; ProcessId=0; PathName=$binary; StartName='LocalSystem' }
$script:stops = 0
$script:reads = 0
$script:onRead = {}
$children = [Collections.ArrayList]::new()
function Get-CimInstance($ClassName, $Filter, $ErrorAction) {
    if ($ClassName -ne 'Win32_Service' -or $Filter -cne "Name='$name'") { throw 'Unexpected service query' }
    $script:reads++
    & $script:onRead
    $record.PSObject.Copy()
}
function Stop-Service($Name, $ErrorAction) {
    if ($Name -cne $script:name) { throw 'Unexpected service stop' }
    $script:stops++
    # An SCM STOPPED notification does not terminate a still-mapped process.
    $record.State = 'Stopped'
    $record.ProcessId = 0
}
function Start-Service($Name, $ErrorAction) {
    if ($Name -cne $script:name -or $record.State -ne 'Stopped') { throw 'Unexpected service start' }
    $record.State = 'Running'
}
function Protect-ManagerPath($Path) {
    if ($script:failAfterReplace) {
        $script:failAfterReplace = $false
        throw 'injected post-replacement failure'
    }
}
function Get-Service($Name) {
    if ($Name -cne $script:name) { throw 'Unexpected service lookup' }
    $service = [pscustomobject]@{}
    $service | Add-Member ScriptMethod WaitForStatus { param($state,$timeout) if ($record.State -ne $state) { throw 'Unexpected service state' } }
    $service
}
function Start-Image($Path,$Count) {
    $p = Start-Process $Path -ArgumentList "-n $Count 127.0.0.1" -WindowStyle Hidden -PassThru
    $null = $children.Add($p)
    $p
}
function Check($Condition,$Message) { if (!$Condition) { throw $Message } }
function Must-Fail($Action,$Pattern) {
    try { & $Action } catch { if ($_.Exception.Message -match $Pattern) { return }; throw }
    throw "Expected failure matching $Pattern"
}

try {
    Copy-Item $ping $exe
    Copy-Item $new $payload
    $p = Start-Image $exe 3
    $record.ProcessId = $p.Id
    $record.State = 'Running'
    Stop-FixedManager $name $binary $exe
    Check ($script:stops -eq 1 -and $p.HasExited) 'SCM stop returned before the pinned process exited'
    Write-Output 'PASS: Running -> Stopped waits for the pinned native process.'

    # PID 0 prevents looking up the old process. This delay exceeds the
    # original ten-second File.Copy retry and reproduces its sharing error.
    $p = Start-Image $exe 13
    Stop-FixedManager $name $binary $exe
    $script:reads = 0
    Replace-StoppedManager $name $binary $exe $payload $backup
    Check ($p.HasExited) 'Replaced an active image'
    Check ((Get-FileHash $exe).Hash -eq (Get-FileHash $new).Hash) 'Wrong replacement image'
    Check ((Get-FileHash $backup).Hash -eq (Get-FileHash $ping).Hash) 'Original backup changed'
    Write-Output 'PASS: replacement waits for a mapped image even when PID is 0 for over 10 seconds.'

    $script:reads = 0
    $script:sawExclusiveWrite = $false
    $script:onRead = {
        if ($script:reads -eq 2) {
            try { $racer = Start-Image $exe 1 }
            catch { $script:sawExclusiveWrite = $true }
            # Abort the transaction at this boundary: the files must survive.
            $record.State = 'Start Pending'
        }
    }
    Must-Fail { Replace-StoppedManager $name $binary $exe $backup ([NullString]::Value) } 'restarted'
    $script:onRead = {}
    $record.State = 'Stopped'
    Check $script:sawExclusiveWrite 'Replacement did not exclude a concurrent image start'
    Write-Output 'PASS: execution excluded under the write lease at the final SCM check.'

    # Hold an external sharing lock during rollback. Simulate a service which
    # has been restarted by another caller while the installer was waiting.
    $lock = [IO.File]::Open($exe,'Open','Read','Read')
    try {
        $script:reads = 0
        $script:onRead = { if ($script:reads -eq 2) { $record.State = 'Running'; $record.ProcessId = $PID } }
        Must-Fail { Replace-StoppedManager $name $binary $exe $backup ([NullString]::Value) } 'restarted'
    } finally { $lock.Dispose(); $script:onRead = {} }
    Check ((Get-FileHash $exe).Hash -eq (Get-FileHash $new).Hash) 'Concurrent restart changed installed file'
    Check ((Get-FileHash $backup).Hash -eq (Get-FileHash $ping).Hash) 'Concurrency failure consumed backup'
    $record.State = 'Stopped'; $record.ProcessId = 0
    Replace-StoppedManager $name $binary $exe $backup ([NullString]::Value)
    Check ((Get-FileHash $exe).Hash -eq (Get-FileHash $ping).Hash) 'Rollback did not restore original'
    Write-Output 'PASS: rollback refuses concurrent restart, retains both files and restores the original on retry.'

    Must-Fail { Resume-PreviousManager $name $binary $exe ('0'*64) } 'safely restarted'
    Check ($record.State -eq 'Stopped') 'A changed binary was restarted'
    Resume-PreviousManager $name $binary $exe (Get-FileHash $ping).Hash
    Check ($record.State -eq 'Running') 'Verified previous manager was not restarted'
    Write-Output 'PASS: previous service resumes only with matching identity and original file hash.'

    $foreign = Start-Image $ping 4
    $record.State = 'Running'; $record.ProcessId = $foreign.Id
    Must-Fail { Stop-FixedManager $name $binary $exe } 'process image changed'
    Check (!$foreign.HasExited -and $script:stops -eq 1) 'Unrelated process was stopped'
    $record.StartName = 'LocalService'
    Must-Fail { Stop-FixedManager $name $binary $exe } 'identity changed'
    Check ($script:stops -eq 1) 'Changed service identity was stopped'
    Write-Output 'PASS: mismatched process image and service identity fail before stopping anything.'

    # Run the installer's real try/catch/finally transaction. Inject a missing
    # staged image before the swap and a failure immediately after it. Both
    # must restore the preceding running state using the original executable.
    $transaction = $ast.Find({ param($n)
        $n -is [Management.Automation.Language.TryStatementAst] -and
        $n.Body.Extent.Text.TrimStart('{').TrimStart().StartsWith('if($service)') -and
        $n.CatchClauses.Count -eq 1
    }, $true)
    Check $transaction 'Missing production upgrade transaction'
    $program = $root
    $service = [pscustomobject]@{Status='Running'}
    $record.StartName = 'LocalSystem'
    $wasRunning = $true
    foreach ($afterReplace in $false,$true) {
        $replaced = $false; $stopped = $false; $cleanupRollback = $false; $rollback = $null
        $p = Start-Image $exe 2
        $record.State = 'Running'; $record.ProcessId = $p.Id
        $stage = Join-Path $root 'transaction-stage.exe'
        if ($afterReplace) { Copy-Item $new $stage }
        $payload = [IO.FileInfo]::new($stage)
        $script:failAfterReplace = $afterReplace
        $failure = $null
        try { . ([scriptblock]::Create($transaction.Extent.Text)) } catch { $failure = $_ }
        Check $failure 'Injection did not reach the production failure handler'
        Check ($replaced -eq $afterReplace) 'Wrong side of the atomic swap'
        Check ($record.State -eq 'Running') 'Failed upgrade left the original service stopped'
        Check ((Get-FileHash $exe).Hash -eq (Get-FileHash $ping).Hash) 'Failed upgrade changed the original image'
        Check (!(Test-Path -LiteralPath $rollback)) 'Unexpected backup after verified recovery'
    }
    Write-Output 'PASS: installer transaction restores the previous running image after pre-swap and post-swap failures.'
} finally {
    foreach ($p in $children) { try { if (!$p.HasExited) { $p.Kill(); $p.WaitForExit() } } finally { $p.Dispose() } }
    foreach ($f in $exe,(Join-Path $root 'manager-prepare.exe'),$backup,(Join-Path $root 'transaction-stage.exe')) {
        if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f }
    }
    [IO.Directory]::Delete($root)
}
