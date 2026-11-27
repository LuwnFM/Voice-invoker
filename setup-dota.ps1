param([switch]$Uninstall, [switch]$Launch, [switch]$NoPrompt, [string]$DotaPath)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$statePath = Join-Path $root '.dota-install.json'
$cfgName = 'gamestate_integration_voice_invoke.cfg'
function Hash-Bytes([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace('-', '') } finally { $sha.Dispose() }
}
function Write-State($Value) {
    $tmp = "$statePath.tmp"
    $Value | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $tmp -Encoding UTF8
    Move-Item -LiteralPath $tmp -Destination $statePath -Force
}
function Find-Steam {
    $candidates = @()
    foreach ($key in @('HKCU:\Software\Valve\Steam', 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam', 'HKLM:\SOFTWARE\Valve\Steam')) {
        $entry = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
        if ($entry) { $candidates += @($entry.SteamPath, $entry.InstallPath) }
    }
    $pf = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    if ($pf) { $candidates += (Join-Path $pf 'Steam') }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath (Join-Path $candidate 'steam.exe') -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    throw 'Steam not found.'
}
function Find-Dota([string]$Steam) {
    $libraries = @($Steam)
    $vdf = Join-Path $Steam 'steamapps\libraryfolders.vdf'
    if (Test-Path -LiteralPath $vdf) {
        $raw = Get-Content -LiteralPath $vdf -Raw
        foreach ($m in [regex]::Matches($raw, '(?im)^\s*"path"\s*"([^"]+)"')) {
            $libraries += $m.Groups[1].Value.Replace('\\', '\')
        }
    }
    foreach ($library in ($libraries | Select-Object -Unique)) {
        $apps = Join-Path $library 'steamapps'
        $manifest = Join-Path $apps 'appmanifest_570.acf'
        if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { continue }
        $m = [regex]::Match((Get-Content -LiteralPath $manifest -Raw), '(?im)^\s*"installdir"\s*"([^"]+)"')
        if (-not $m.Success) { continue }
        $dir = Join-Path (Join-Path $apps 'common') $m.Groups[1].Value
        if (Test-Path -LiteralPath (Join-Path $dir 'game\bin\win64\dota2.exe') -PathType Leaf) { return $dir }
    }
    throw 'Dota 2 installation not found in Steam libraries.'
}
if ($Uninstall) {
    if (-not (Test-Path -LiteralPath $statePath)) { Write-Host 'No tracked installation; nothing removed.'; exit 0 }
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $target = [string]$state.target
    if ([IO.Path]::GetFileName($target) -ne $cfgName) { throw 'Invalid installation record.' }
    if (Test-Path -LiteralPath $target) {
        if ((Hash-Bytes ([IO.File]::ReadAllBytes($target))) -ne $state.installedHash) { throw 'GSI file was changed externally. Keeping it and the backup.' }
    }
    if ($state.hadOriginal) {
        if (-not (Test-Path -LiteralPath (Split-Path -Parent $target))) { throw 'Original folder is missing; keeping backup.' }
        [IO.File]::WriteAllBytes($target, [Convert]::FromBase64String($state.original))
    } elseif (Test-Path -LiteralPath $target) {
        Remove-Item -LiteralPath $target
    }
    Remove-Item -LiteralPath $statePath
    Write-Host 'GSI installation removed. Restart Dota if it is running.'
    exit 0
}
$steam = $null
try { $steam = Find-Steam } catch { if ($Launch) { throw } }
if ($DotaPath) {
    $manual = $DotaPath.Trim('"')
    if (-not (Test-Path -LiteralPath (Join-Path $manual 'game\bin\win64\dota2.exe') -PathType Leaf)) { throw 'Invalid Dota 2 folder.' }
    $dota = (Resolve-Path -LiteralPath $manual).Path
} else { try { if (-not $steam) { throw 'Steam not found.' }; $dota = Find-Dota $steam } catch {
    $manual = $null
    if (Test-Path -LiteralPath $statePath) {
        try {
            $saved = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
            $candidate = [string]$saved.target -replace '[\\/]game[\\/]dota[\\/]cfg[\\/]gamestate_integration[\\/].+$',''
            if (Test-Path -LiteralPath (Join-Path $candidate 'game\bin\win64\dota2.exe') -PathType Leaf) { $manual = $candidate }
        } catch {}
    }
    if (-not $manual -and $NoPrompt) { throw 'DOTA_NOT_FOUND' }
    if (-not $manual) { $manual = Read-Host 'Dota 2 not detected. Enter installation folder (contains game) or leave empty to cancel' }
    if (-not $manual) { throw 'Dota 2 installation not found.' }
    $manual = $manual.Trim('"')
    if (-not (Test-Path -LiteralPath (Join-Path $manual 'game\bin\win64\dota2.exe') -PathType Leaf)) { throw 'Invalid Dota 2 folder.' }
    $dota = (Resolve-Path -LiteralPath $manual).Path
} }
$folder = Join-Path $dota 'game\dota\cfg\gamestate_integration'
$target = Join-Path $folder $cfgName
$source = Get-Content -LiteralPath (Join-Path $root $cfgName) -Raw
$port = 3055
$token = 'voice_invoke'
$configPath = Join-Path $root 'config.json'
if (Test-Path -LiteralPath $configPath) {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($null -ne $config.port) { $port = [int]$config.port }
    if ($null -ne $config.authToken) { $token = [string]$config.authToken }
}
if ($port -lt 1 -or $port -gt 65535 -or $token -notmatch '^[A-Za-z0-9_-]+$') { throw 'Invalid GSI port or token.' }
$source = $source.Replace('127.0.0.1:3055/gsi', "127.0.0.1:$port/gsi").Replace('"voice_invoke"', ('"' + $token + '"'))
$bytes = [Text.UTF8Encoding]::new($false).GetBytes($source)
$newHash = Hash-Bytes $bytes
if (Test-Path -LiteralPath $statePath) {
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ($state.target -ne $target) { throw 'Dota moved. Uninstall previous integration first.' }
    if ((Test-Path -LiteralPath $target) -and (Hash-Bytes ([IO.File]::ReadAllBytes($target))) -ne $state.installedHash) { throw 'GSI file changed externally; not overwriting it.' }
} else {
    $hadOriginal = Test-Path -LiteralPath $target
    $original = if ($hadOriginal) { [Convert]::ToBase64String([IO.File]::ReadAllBytes($target)) } else { '' }
    $state = [pscustomobject]@{target=$target; hadOriginal=$hadOriginal; original=$original; installedHash=$newHash}
    Write-State $state
}
New-Item -ItemType Directory -Path $folder -Force | Out-Null
[IO.File]::WriteAllBytes($target, $bytes)
$state.installedHash = $newHash
Write-State $state
Write-Host "GSI installed: $target"
if ($Launch) {
    if (Get-Process -Name dota2 -ErrorAction SilentlyContinue) {
        Write-Warning 'Dota is already running. Restart it with this launcher for GSI and borderless settings to apply.'
    } else {
        Start-Process -FilePath (Join-Path $steam 'steam.exe') -ArgumentList @('-applaunch','570','-gamestateintegration','-windowed','-noborder')
    }
}
