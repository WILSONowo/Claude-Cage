#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Target, [Parameter(Mandatory)][string]$Backend, [switch]$StopEnvironment)
$ErrorActionPreference = 'Stop'
# No output from controllers or configuration records (they can contain private information).
trap { [Console]::Error.WriteLine("Could not safely close this installation (" + $_.Exception.GetType().Name + ")."); exit 110 }

function Assert-PlainPath([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    while ($null -ne $item) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked installation path.' }
        $item = if ($item -is [IO.FileInfo]) { $item.Directory } else { $item.Parent }
    }
}

$Target = [IO.Path]::GetFullPath($Target)
Assert-PlainPath $Target
$client = Join-Path $Target 'Cage.exe'
$oldBackend = Join-Path $Target 'resources/cage.exe'
Add-Type -Path (Join-Path $PSScriptRoot 'installer-process.cs')
$clients = [CageInstallProcess]::AtPath($client)
$backends = [CageInstallProcess]::AtPath($oldBackend)
try {
    $clientOnly = Test-Path -LiteralPath (Join-Path $Target 'resources/client-only') -PathType Leaf
    $profile = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.claude-cage'
    if ($clientOnly) { $profile = Join-Path $profile 'client' }
    $config = if ($env:CLAUDE_CAGE_CONFIG) { [IO.Path]::GetFullPath($env:CLAUDE_CAGE_CONFIG) } else { Join-Path $profile 'config.json' }
    $profile = Split-Path -Parent $config
    if ($clients.Count) { Assert-PlainPath $client }
    if ($backends.Count) {
        Assert-PlainPath $oldBackend
        Assert-PlainPath $Backend
        $profiles = @($profile)
        $newClientOnly = Test-Path -LiteralPath (Join-Path (Split-Path -Parent $Backend) 'client-only') -PathType Leaf
        if (!$clientOnly -or !$newClientOnly) { $profiles += (Join-Path $profile 'desktop-entry') }
        $matched = $false
        foreach ($directory in $profiles) {
            $record = Join-Path $directory 'control.json'
            if (!(Test-Path -LiteralPath $record -PathType Leaf)) { continue }
            Assert-PlainPath $record
            $control = Get-Content -LiteralPath $record -Raw -Encoding UTF8 | ConvertFrom-Json
            if (!($backends | Where-Object { $_.Id -eq $control.pid -and !$_.HasExited })) {
                # Never ask the new helper to stop a controller belonging to another installation.
                if (Get-Process -Id ([int]$control.pid) -ErrorAction SilentlyContinue) { exit 111 }
                continue
            }
            $matched = $true
        }
        if ($matched) {
            $env:CLAUDE_CAGE_CONFIG = $config
            $arguments = @('prepare-update', '--json')
            if ($StopEnvironment) { $arguments += '--stop' }
            # Use the freshly unpacked binary to release the authenticated controller.
            $reply = & $Backend @arguments 2>$null
            if ($LASTEXITCODE -ne 0) { exit 110 }
            $result = $reply | ConvertFrom-Json
            if ($result.status -eq 'stop_required') { exit 109 }
            if ($result.status -ne 'prepared') { exit 110 }
        } else {
            # An unregistered backend may be a retiring log relay or a different profile.
            # Only wait for it; never send it a shutdown request.
            foreach ($process in $backends) {
                if (!$process.WaitForExit(5000)) { exit 111 }
            }
        }
    }
    [CageInstallProcess]::CloseWindows($clients, $client)
    # Closing the frontend also releases its helper pipes. Recheck the old image
    # after that close, rather than requiring all helpers to exit before their parent.
    $proxyPath = Join-Path $Target 'resources/mihomo.exe'
    $proxies = [CageInstallProcess]::AtPath($proxyPath)
    try {
        if ($proxies.Count) {
            Assert-PlainPath $proxyPath
            Assert-PlainPath $Backend
            $guests = [CageInstallProcess]::AtPath((Join-Path $Target 'resources/runtime/qemu/qemu-system-x86_64.exe'))
            try {
                if ($guests.Count) { exit 112 }
            } finally { foreach ($guest in $guests) { $guest.Dispose() } }
            $env:CLAUDE_CAGE_CONFIG = $config
            $reply = & $Backend prepare-update --json --release-orphan-proxy $Target 2>$null
            if ($LASTEXITCODE -ne 0 -or ($reply | ConvertFrom-Json).status -ne 'prepared') {
                if ($proxies | Where-Object { !$_.HasExited }) { exit 113 }
            }
        }
    } finally { foreach ($process in $proxies) { $process.Dispose() } }

} finally {
    foreach ($process in @($clients) + @($backends)) { $process.Dispose() }
}
