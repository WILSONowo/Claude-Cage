#requires -Version 5.1
#requires -RunAsAdministrator
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][guid]$VMId,
    [Parameter(Mandatory)][string]$HostSID,
    [Parameter(Mandatory)][string]$PayloadExecutable,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$PayloadSHA256
)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
if($VMId -eq [guid]::Empty -or $HostSID -notmatch '^S-1-(5-21|12-1)-(\d+-){3}\d+$'){throw 'Select the exact VM and authorized host user.'}
# HostSID is the ordinary Cage user's identity carried across its UAC boundary.
# The administrator may be another account; its SID is never substituted here.
function Assert-NoLink([string]$Path){
    $item=Get-Item -LiteralPath $Path -Force
    while($item){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Manager files cannot traverse links.'};if($item -is [IO.FileInfo]){$item=$item.Directory}else{$item=$item.Parent}}
}
function Get-FixedManagerService([string]$Name,[string]$Binary){
    $record=Get-CimInstance Win32_Service -Filter ("Name='"+$Name+"'") -ErrorAction Stop
    if(!$record -or $record.PathName -cne $Binary -or $record.StartName -notin @('LocalSystem','NT AUTHORITY\SYSTEM')){
        throw 'The fixed manager service identity changed.'
    }
    return $record
}
function Stop-FixedManager([string]$Name,[string]$Binary,[string]$Executable){
    $service=Get-FixedManagerService $Name $Binary
    if($service.State -eq 'Stopped' -and $service.ProcessId -eq 0){return}
    if(!$service.ProcessId){throw 'The manager service is changing state. Retry the update.'}
    $process=$null
    try{
        $process=[Diagnostics.Process]::GetProcessById($service.ProcessId)
        $null=$process.Handle # Pin the process while validating the SCM PID.
        if(![string]::Equals($process.MainModule.FileName,$Executable,[StringComparison]::OrdinalIgnoreCase)){
            throw 'The fixed manager process image changed.'
        }
        $confirmed=Get-FixedManagerService $Name $Binary
        if($confirmed.ProcessId -ne $service.ProcessId){throw 'The fixed manager process changed.'}
        if($confirmed.State -notin @('Stop Pending','Stopped')){Stop-Service -Name $Name -ErrorAction Stop}
        try{
            (Get-Service -Name $Name).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(30))
            if(!$process.WaitForExit(30000)){throw 'The manager process did not exit within 30 seconds.'}
        }catch{
            throw "The manager stop did not finish: $($_.Exception.Message) The executable was preserved. Retry maintenance after the old process exits."
        }
    }finally{if($process){$process.Dispose()}}
}
function Replace-StoppedManager([string]$Name,[string]$Binary,[string]$Executable,[string]$Source,$Backup){
    # When SCM already reports PID 0 the old image can still be mapped.
    # A write handle detects this and prevents any new execution of the old
    # file through the last service check and the atomic NTFS replacement.
    $timer=[Diagnostics.Stopwatch]::StartNew()
    $lease=$null
    while(!$lease){
        $service=Get-FixedManagerService $Name $Binary
        if($service.State -ne 'Stopped' -or $service.ProcessId -ne 0){
            throw 'The fixed manager service restarted before replacement.'
        }
        try{
            $lease=[IO.File]::Open($Executable,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]'Read,Delete')
        }catch{
            $cause=$_.Exception.GetBaseException()
            if($cause -isnot [IO.IOException] -or ($cause.HResult -band 0xffff) -notin 32,33 -or $timer.Elapsed.TotalSeconds -ge 30){throw}
            Start-Sleep -Milliseconds 200
        }
    }
    try{
        $service=Get-FixedManagerService $Name $Binary
        if($service.State -ne 'Stopped' -or $service.ProcessId -ne 0){throw 'The fixed manager service restarted before replacement.'}
        [IO.File]::Replace($Source,$Executable,$Backup)
    }finally{$lease.Dispose()}
}
function Resume-PreviousManager([string]$Name,[string]$Binary,[string]$Executable,[string]$OriginalHash){
    $service=Get-FixedManagerService $Name $Binary
    if($service.State -eq 'Running'){return}
    if($service.State -ne 'Stopped' -or $service.ProcessId -ne 0 -or
        (Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash -cne $OriginalHash){
        throw 'The previous manager could not be safely restarted. Recheck the service state before retrying.'
    }
    Start-Service -Name $Name -ErrorAction Stop
    (Get-Service -Name $Name).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
}
function Protect-ManagerPath([string]$Path,[switch]$Shared){
    $item=Get-Item -LiteralPath $Path -Force
    if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Manager paths cannot be links.'}
    if($item -is [IO.DirectoryInfo]){$acl=[Security.AccessControl.DirectorySecurity]::new()}else{$acl=[Security.AccessControl.FileSecurity]::new()}
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'));$acl.SetAccessRuleProtection($true,$false)
    $reader=if($Shared){'S-1-5-32-545'}else{$HostSID}
    foreach($id in @('S-1-5-18','S-1-5-32-544',$reader)){
        $rights=if($id -ceq $reader){'ReadAndExecute'}else{'FullControl'}
        if($item -is [IO.DirectoryInfo]){$rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($id),$rights,'ContainerInherit,ObjectInherit','None','Allow')}else{$rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($id),$rights,'Allow')}
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}
$payload=Get-Item -LiteralPath $PayloadExecutable
if($payload -isnot [IO.FileInfo]){throw 'Select the built manager executable.'};Assert-NoLink $payload.FullName
if((Get-FileHash $payload.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $PayloadSHA256.ToLowerInvariant()){throw 'Manager payload checksum does not match.'}
$programRoot=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Cage Host Manager'
$program=Join-Path $programRoot $VMId.ToString('D');$exe=Join-Path $program 'Cage.HyperVManager.exe'
$cageDataRoot=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Cage'
$dataRoot=Join-Path $cageDataRoot 'HyperVManager'
$data=Join-Path $dataRoot $VMId.ToString('D');$bindingPath=Join-Path $data 'binding.json'
$name='CageHV-'+$VMId.ToString('D');$binary='"'+$exe+'" service --binding "'+$bindingPath+'"'
if(!$PSCmdlet.ShouldProcess($VMId,'Install the protected local fixed-VM manager; keep VM, disks, accounts and host networking')){return}
foreach($path in @($programRoot,$program,$cageDataRoot,$dataRoot,$data)){
    if(!(Test-Path -LiteralPath $path)){New-Item -ItemType Directory -Path $path|Out-Null};Assert-NoLink $path
    Protect-ManagerPath $path -Shared:($path -in @($programRoot,$cageDataRoot,$dataRoot))
}
$prepare=Join-Path $program ('manager-prepare-'+[guid]::NewGuid().ToString('N')+'.exe')
# Serialize the complete upgrade (including its possible rollback) for this VM.
$lockPath=Join-Path $program 'maintenance.lock'
if(Test-Path -LiteralPath $lockPath){Assert-NoLink $lockPath}
$maintenance=[IO.File]::Open($lockPath,'OpenOrCreate','ReadWrite','None')
try{
    # Hash and execute the same protected copy. The caller's original payload
    # may change while setup runs; it never becomes an execution authority.
    Copy-Item -LiteralPath $payload.FullName -Destination $prepare
    Protect-ManagerPath $prepare
    if((Get-FileHash $prepare -Algorithm SHA256).Hash.ToLowerInvariant() -cne $PayloadSHA256.ToLowerInvariant()){throw 'Protected manager preparation checksum does not match.'}
    $payload=Get-Item -LiteralPath $prepare
$service=Get-Service -Name $name -ErrorAction SilentlyContinue
if($service){
    $null=Get-FixedManagerService $name $binary
}
# Existing installations retain their protected authority and recovery journal.
# They can repair a stopped helper while its bound data volume is disconnected.
# Fresh registration verifies the actual VM using the protected payload copy.
$operation=if(Test-Path -LiteralPath $bindingPath){'binding'}else{'prepare'}
$raw=& $payload.FullName $operation --vm-id $VMId.ToString('D') --host-sid $HostSID
if($LASTEXITCODE -ne 0){throw 'The exact VM/disk binding could not be verified.'}
$binding=$raw|ConvertFrom-Json
if($binding.version -ne 1 -or [guid]$binding.vm_id -ne $VMId -or $binding.host_sid -cne $HostSID){throw 'The prepared manager binding does not match.'}
if(Test-Path -LiteralPath $bindingPath){
    Assert-NoLink $bindingPath;$old=Get-Content -LiteralPath $bindingPath -Raw -Encoding UTF8|ConvertFrom-Json
    foreach($key in @('version','vm_id','host_sid','disk_path','disk_volume','disk_file_id')){if([string]$old.$key -cne [string]$binding.$key){throw 'The existing protected VM/disk binding changed; preserved it.'}}
}
$rollback=$null;$replaced=$false;$stopped=$false;$cleanupRollback=$false;$wasRunning=$service -and $service.Status -eq 'Running'
try{
    if($service){
        Assert-NoLink $exe
        if($wasRunning){$originalHash=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash}
        $rollback=Join-Path $program ('manager-rollback-'+[guid]::NewGuid().ToString('N')+'.exe')
        Stop-FixedManager $name $binary $exe
        $stopped=$true
        Replace-StoppedManager $name $binary $exe $payload.FullName $rollback
        $replaced=$true
    }else{
        [IO.File]::Copy($payload.FullName,$exe,$true)
    }
    Protect-ManagerPath $exe
    if((Get-FileHash $exe -Algorithm SHA256).Hash.ToLowerInvariant() -cne $PayloadSHA256.ToLowerInvariant()){throw 'The copied manager checksum does not match.'}
    if(!(Test-Path -LiteralPath $bindingPath)){[IO.File]::WriteAllText($bindingPath,($binding|ConvertTo-Json -Depth 4),[Text.UTF8Encoding]::new($false))}
    Protect-ManagerPath $bindingPath
    if(!$service){New-Service -Name $name -BinaryPathName $binary -StartupType Automatic -DisplayName ('Cage fixed VM manager '+$VMId.ToString('D')) -Description ('Cage protected local VM manager '+$VMId.ToString('D'))|Out-Null}
    $sddl='O:SYG:SYD:(A;;GA;;;SY)(A;;GA;;;BA)(A;;CCLCRP;;;'+$HostSID+')'
    & ($env:windir+'\System32\sc.exe') sdset $name $sddl|Out-Null
    if($LASTEXITCODE -ne 0){throw 'The manager service permission could not be protected.'}
    & ($env:windir+'\System32\sc.exe') failure $name reset= 86400 actions= restart/5000/restart/15000/restart/60000|Out-Null
    if($LASTEXITCODE -ne 0){throw 'The manager recovery policy could not be configured.'}
    Start-Service -Name $name;(Get-Service -Name $name).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
    $cleanupRollback=$true
}catch{
    if($replaced){
        Stop-FixedManager $name $binary $exe
        Replace-StoppedManager $name $binary $exe $rollback ([NullString]::Value)
        Protect-ManagerPath $exe
        if($wasRunning){Resume-PreviousManager $name $binary $exe $originalHash}
        $cleanupRollback=$true
    }elseif($stopped -and $wasRunning){
        Resume-PreviousManager $name $binary $exe $originalHash
    }
    throw
}finally{if($rollback -and $cleanupRollback -and (Test-Path -LiteralPath $rollback)){Remove-Item -LiteralPath $rollback}}
[pscustomobject]@{Installed=$true;VMId=$VMId.ToString('D');HostSID=$HostSID;LocalPipeOnly=$true;VMDataPreserved=$true;HostGroupsUnchanged=$true;ServiceRunning=$true}
}finally{
    try{if(Test-Path -LiteralPath $prepare){Remove-Item -LiteralPath $prepare}}
    finally{$maintenance.Dispose()}
}
