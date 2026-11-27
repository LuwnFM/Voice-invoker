param([Parameter(Mandatory=$true)][string]$Installer)
$ErrorActionPreference='Stop'
$root=Join-Path ([IO.Path]::GetTempPath()) ('vi-install-'+[Guid]::NewGuid().ToString('N'))
$dest=Join-Path $root 'Install with spaces'
$app=Join-Path $dest 'resources\app'
$oldDataDir=$env:VI_DATA_DIR
$env:VI_DATA_DIR=Join-Path $root 'User Data'
$dota=Join-Path $root 'Fake Dota'
$cfg=Join-Path $dota 'game\dota\cfg\gamestate_integration\gamestate_integration_voice_invoke.cfg'
function Run-Checked([string]$Exe,[string[]]$Arguments){
  $p=Start-Process -FilePath $Exe -ArgumentList $Arguments -Wait -PassThru
  if($p.ExitCode -ne 0){throw "$Exe returned $($p.ExitCode)"}
}
try {
  New-Item -ItemType Directory -Path $root | Out-Null
  $installerPath=(Resolve-Path -LiteralPath $Installer).Path
  Run-Checked $installerPath @('/S',"/D=$dest")
  if(-not (Test-Path -LiteralPath (Join-Path $dest 'VoiceInvoker.exe'))){throw 'EXE missing'}
  $model=Join-Path $app 'model\vosk-model-small-ru-invoker.tar.gz'
  $manifest=Get-Content -LiteralPath (Join-Path $app 'model-manifest.json') -Raw | ConvertFrom-Json
  if((Get-FileHash -LiteralPath $model).Hash -ne $manifest.sha256){throw 'Model hash invalid'}
  $shortcut=Join-Path ([Environment]::GetFolderPath('Programs')) 'Voice Invoker\Voice Invoker.lnk'
  if(-not (Test-Path -LiteralPath $shortcut)){throw 'Launch shortcut missing'}
  $link=(New-Object -ComObject WScript.Shell).CreateShortcut($shortcut)
  if($link.TargetPath -ne (Join-Path $dest 'Start Voice Invoker.bat')){throw 'Wrong launch shortcut target'}
  $pkgPath=Join-Path $app 'package.json'
  $originalPkg=[IO.File]::ReadAllText($pkgPath)
  try {
    $pkg=$originalPkg | ConvertFrom-Json
    $pkg.main='scripts/lifecycle-entry.js'
    [IO.File]::WriteAllText($pkgPath,($pkg | ConvertTo-Json -Depth 20))
    $env:VI_PACKAGED='1'
    $env:VI_TEST_START_BAT='1'
    & node (Join-Path $app 'scripts\lifecycle-check.js')
    if($LASTEXITCODE -ne 0){throw 'Installed launcher lifecycle test failed'}
  } finally {
    [IO.File]::WriteAllText($pkgPath,$originalPkg)
    Remove-Item Env:VI_PACKAGED,Env:VI_TEST_START_BAT -ErrorAction SilentlyContinue
  }
  $config=Join-Path $app 'config.json'
  $prefs='{"voiceChatKey":"MOUSE4","customSpellPhrases":{"invoker_tornado":["\u0443\u0440\u0430\u0433\u0430\u043d"]},"itemPhrases":{"item_slot_item1":["\u0449\u0438\u0442"]},"testOnly":true}'
  [IO.File]::WriteAllText($config,$prefs)
  & node -e "require(process.argv[1]).initializeUserData(process.argv[2])" (Join-Path $app 'user-data.js') $app
  if($LASTEXITCODE -ne 0){throw 'Preference migration failed'}
  $migrated=Join-Path $env:VI_DATA_DIR 'config.json'
  if([IO.File]::ReadAllText($migrated) -ne $prefs){throw 'Legacy preferences not migrated'}
  $newPrefs=$prefs.Replace('MOUSE4','MOUSE5')
  [IO.File]::WriteAllText($migrated,$newPrefs)
  New-Item -ItemType Directory -Path (Join-Path $dota 'game\bin\win64'),(Split-Path -Parent $cfg) -Force | Out-Null
  New-Item -ItemType File -Path (Join-Path $dota 'game\bin\win64\dota2.exe') | Out-Null
  [IO.File]::WriteAllText($cfg,'original GSI fixture')
  $before=(Get-FileHash -LiteralPath $cfg).Hash
  $setup=Join-Path $app 'setup-dota.ps1'
  Run-Checked 'powershell.exe' @('-NoProfile','-NonInteractive','-File',('"' + $setup + '"'),'-NoPrompt','-DotaPath',('"' + $dota + '"'))
  $state=Join-Path $app '.dota-install.json'
  if(-not (Test-Path -LiteralPath $state)){throw 'Backup missing'}
  $backup=[IO.File]::ReadAllText($state)
  [IO.File]::WriteAllText($model,'damaged V2 fixture')
  Run-Checked $installerPath @('/S',"/D=$dest")
  if([IO.File]::ReadAllText($config) -ne $prefs){throw 'Upgrade lost legacy preferences'}
  if([IO.File]::ReadAllText($migrated) -ne $newPrefs){throw 'Upgrade lost AppData preferences'}
  if([IO.File]::ReadAllText($state) -ne $backup){throw 'Upgrade lost GSI backup'}
  if((Get-FileHash -LiteralPath $model).Hash -ne $manifest.sha256){throw 'Upgrade changed model'}
  Run-Checked (Join-Path $dest 'Uninstall.exe') @('/S',"_?=$dest")
  if(Test-Path -LiteralPath (Join-Path $dest 'VoiceInvoker.exe')){throw 'Uninstall left executable'}
  if((Get-FileHash -LiteralPath $cfg).Hash -ne $before){throw 'GSI original not restored'}
  if([IO.File]::ReadAllText($config) -ne $prefs){throw 'Uninstall lost legacy preferences'}
  if([IO.File]::ReadAllText($migrated) -ne $newPrefs){throw 'Uninstall lost AppData preferences'}
  if((Get-FileHash -LiteralPath $model).Hash -ne $manifest.sha256){throw 'Uninstall lost model'}
  Write-Host 'PASS: actual installer, installed launcher, upgrade, retained preferences, V2 repair, GSI restore and uninstall'
} finally {
  $env:VI_DATA_DIR=$oldDataDir
  if(Test-Path -LiteralPath $root){Remove-Item -LiteralPath $root -Recurse -Force}
}
