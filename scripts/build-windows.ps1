param([switch]$Installer,[switch]$SkipInstallerSmoke)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$out = Join-Path $root 'build-output'
$stage = Join-Path $out 'VoiceInvoker'
$app = Join-Path $stage 'resources\app'
$package = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$version = if ($package.releaseVersion) { $package.releaseVersion } else { $package.version }
$model = Join-Path $root 'model\vosk-model-small-ru-invoker.tar.gz'
$manifest = Get-Content (Join-Path $root 'model-manifest.json') -Raw | ConvertFrom-Json
if ((Get-FileHash -LiteralPath $model -Algorithm SHA256).Hash -ne $manifest.sha256) { throw 'Invalid V2 archive' }
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage,$app | Out-Null
Copy-Item -Path (Join-Path $root 'node_modules\electron\dist\*') -Destination $stage -Recurse -Force
Rename-Item -LiteralPath (Join-Path $stage 'electron.exe') -NewName 'VoiceInvoker.exe'
$iconFile=Join-Path $out 'VoiceInvoker.ico'
& (Join-Path $PSScriptRoot 'brand-windows.ps1') -Exe (Join-Path $stage 'VoiceInvoker.exe') -Png (Join-Path $root 'icon.png') -Ico $iconFile
Get-ChildItem -LiteralPath $root -File | Where-Object { $_.Extension -in @('.js','.html','.json','.cfg','.wav','.bat','.ps1','.md','.png') -and $_.Name -notlike '.*' } | Copy-Item -Destination $app
foreach ($dir in @('scripts','docs')) { Copy-Item -LiteralPath (Join-Path $root $dir) -Destination $app -Recurse }
New-Item -ItemType Directory -Path (Join-Path $app 'node_modules'),(Join-Path $app 'model') | Out-Null
Get-ChildItem -LiteralPath (Join-Path $root 'node_modules') -Force | Where-Object { $_.Name -notin @('electron','.bin','.package-lock.json') } | Copy-Item -Destination (Join-Path $app 'node_modules') -Recurse -Force
Copy-Item -LiteralPath $model -Destination (Join-Path $app 'model')
$csc=Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if(-not (Test-Path -LiteralPath $csc)){throw 'Windows .NET Framework C# compiler missing'}
$launcher=Join-Path $stage 'VoiceInvoker-Launcher.exe'
& $csc /nologo /target:winexe /platform:x64 /optimize+ /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll "/win32icon:$iconFile" "/out:$launcher" (Join-Path $PSScriptRoot 'windows-launcher.cs')
if($LASTEXITCODE -ne 0){throw 'GUI launcher compilation failed'}
if (-not $Installer) {
$pkgPath = Join-Path $app 'package.json'
$original = [IO.File]::ReadAllText($pkgPath)
try {
    $pkg = $original | ConvertFrom-Json
    $pkg.main = 'scripts/lifecycle-entry.js'
    [IO.File]::WriteAllText($pkgPath, ($pkg | ConvertTo-Json -Depth 20))
    $env:VI_PACKAGED = '1'
    & node (Join-Path $app 'scripts\lifecycle-check.js')
    if ($LASTEXITCODE -ne 0) { throw 'Packaged lifecycle test failed' }
} finally {
    [IO.File]::WriteAllText($pkgPath,$original)
    Remove-Item Env:VI_PACKAGED -ErrorAction SilentlyContinue
}
foreach ($log in @('log.txt','log.previous.txt','launcher.log')) { Remove-Item -LiteralPath (Join-Path $app $log) -Force -ErrorAction SilentlyContinue }
$zip = Join-Path $out "VoiceInvoker-Portable-$version.zip"
& tar.exe -a -cf $zip -C $stage .
if ($LASTEXITCODE -ne 0) { throw 'Portable archive failed' }
}
if ($Installer) {
    $makensis = Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'NSIS\makensis.exe'
    if (-not (Test-Path -LiteralPath $makensis)) { throw 'NSIS required' }
    $remove = Join-Path $out 'uninstall-files.nsh'
    $lines = @()
    foreach ($f in (Get-ChildItem -LiteralPath $stage -Recurse -File -Force)) {
        $rel = $f.FullName.Substring($stage.Length+1)
        if ($rel -eq 'resources\app\config.json' -or $rel.StartsWith('resources\app\model\')) { continue }
        $lines += ('Delete "$INSTDIR\' + $rel.Replace('$','$$') + '"')
    }
    foreach ($d in (Get-ChildItem -LiteralPath $stage -Recurse -Directory -Force | Sort-Object {$_.FullName.Length} -Descending)) {
        $rel = $d.FullName.Substring($stage.Length+1)
        $lines += ('RMDir "$INSTDIR\' + $rel.Replace('$','$$') + '"')
    }
    [IO.File]::WriteAllLines($remove,[string[]]$lines,[Text.UTF8Encoding]::new($false))
    # Generate a manifest and a conditional extraction instruction for each package file.
    $packageFiles=@(Get-ChildItem -LiteralPath $stage -Recurse -File -Force | Where-Object { $_.FullName.Substring($stage.Length+1) -ne 'resources\app\config.json' } | Sort-Object FullName)
    $entries=@()
    $copy=@()
    $lastDir=''
    foreach($f in $packageFiles){
        $rel=$f.FullName.Substring($stage.Length+1)
        $entries+=@{path=$rel;sha256=(Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
        $parent=Split-Path -Parent $rel
        if($parent -ne $lastDir -or $copy.Count -eq 0){
            $outPath=if($parent){'$INSTDIR\'+$parent.Replace('
    Write-Host ('['+(Get-Date -Format o)+'] NSIS compression started')
    & $makensis "/DVERSION=$version" "/DSTAGE=$stage" "/DOUTFILE=$exe" "/DREMOVEFILES=$remove" "/DICONFILE=$iconFile" "/DPACKAGEMANIFEST=$manifestPath" "/DCOPYFILES=$copyPath" (Join-Path $root 'installer.nsi')
    if ($LASTEXITCODE -ne 0) { throw 'NSIS build failed' }
    Write-Host ('['+(Get-Date -Format o)+'] NSIS compression completed')
    if(-not $SkipInstallerSmoke){& (Join-Path $PSScriptRoot 'installer-smoke.ps1') -Installer $exe}
}
$packages=if($Installer){@($exe)}else{@($zip)}
$checksums=@(foreach($package in $packages){(Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant()+'  '+[IO.Path]::GetFileName($package)})
[IO.File]::WriteAllLines((Join-Path $out 'SHA256SUMS.txt'),[string[]]$checksums,[Text.UTF8Encoding]::new($false))
Write-Host "Windows packages: $out"
,'$')}else{'$INSTDIR'}
            $copy+=('SetOutPath "'+$outPath+'"')
            $lastDir=$parent
        }
        $escaped=$rel.Replace('
    Write-Host ('['+(Get-Date -Format o)+'] NSIS compression started')
    & $makensis "/DVERSION=$version" "/DSTAGE=$stage" "/DOUTFILE=$exe" "/DREMOVEFILES=$remove" "/DICONFILE=$iconFile" (Join-Path $root 'installer.nsi')
    if ($LASTEXITCODE -ne 0) { throw 'NSIS build failed' }
    Write-Host ('['+(Get-Date -Format o)+'] NSIS compression completed')
    if(-not $SkipInstallerSmoke){& (Join-Path $PSScriptRoot 'installer-smoke.ps1') -Installer $exe}
}
$packages=if($Installer){@($exe)}else{@($zip)}
$checksums=@(foreach($package in $packages){(Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant()+'  '+[IO.Path]::GetFileName($package)})
[IO.File]::WriteAllLines((Join-Path $out 'SHA256SUMS.txt'),[string[]]$checksums,[Text.UTF8Encoding]::new($false))
Write-Host "Windows packages: $out"
,'$')
        $copy+=('IfFileExists "$PLUGINSDIR\keep\'+$escaped+'" +2 0')
        $copy+=('File "'+$f.FullName.Replace('
    Write-Host ('['+(Get-Date -Format o)+'] NSIS compression started')
    & $makensis "/DVERSION=$version" "/DSTAGE=$stage" "/DOUTFILE=$exe" "/DREMOVEFILES=$remove" "/DICONFILE=$iconFile" (Join-Path $root 'installer.nsi')
    if ($LASTEXITCODE -ne 0) { throw 'NSIS build failed' }
    Write-Host ('['+(Get-Date -Format o)+'] NSIS compression completed')
    if(-not $SkipInstallerSmoke){& (Join-Path $PSScriptRoot 'installer-smoke.ps1') -Installer $exe}
}
$packages=if($Installer){@($exe)}else{@($zip)}
$checksums=@(foreach($package in $packages){(Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant()+'  '+[IO.Path]::GetFileName($package)})
[IO.File]::WriteAllLines((Join-Path $out 'SHA256SUMS.txt'),[string[]]$checksums,[Text.UTF8Encoding]::new($false))
Write-Host "Windows packages: $out"
,'$')+'"')
    }
    $manifestPath=Join-Path $out 'package-manifest.json'
    [IO.File]::WriteAllText($manifestPath,(ConvertTo-Json -InputObject $entries -Depth 3 -Compress),[Text.UTF8Encoding]::new($false))
    $copyPath=Join-Path $out 'install-changed.nsh'
    [IO.File]::WriteAllLines($copyPath,[string[]]$copy,[Text.UTF8Encoding]::new($false))
    $exe = Join-Path $out "VoiceInvoker-Installer-$version.exe"
    Write-Host ('['+(Get-Date -Format o)+'] NSIS compression started')
    & $makensis "/DVERSION=$version" "/DSTAGE=$stage" "/DOUTFILE=$exe" "/DREMOVEFILES=$remove" "/DICONFILE=$iconFile" (Join-Path $root 'installer.nsi')
    if ($LASTEXITCODE -ne 0) { throw 'NSIS build failed' }
    Write-Host ('['+(Get-Date -Format o)+'] NSIS compression completed')
    if(-not $SkipInstallerSmoke){& (Join-Path $PSScriptRoot 'installer-smoke.ps1') -Installer $exe}
}
$packages=if($Installer){@($exe)}else{@($zip)}
$checksums=@(foreach($package in $packages){(Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant()+'  '+[IO.Path]::GetFileName($package)})
[IO.File]::WriteAllLines((Join-Path $out 'SHA256SUMS.txt'),[string[]]$checksums,[Text.UTF8Encoding]::new($false))
Write-Host "Windows packages: $out"
