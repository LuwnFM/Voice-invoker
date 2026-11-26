param([Parameter(Mandatory=$true)][string]$Installer)
$ErrorActionPreference='Stop'
$root=Join-Path ([IO.Path]::GetTempPath()) ('vi-install-'+[Guid]::NewGuid().ToString('N'))
$dest=Join-Path $root 'Install with spaces'
$app=Join-Path $dest 'resources\app'
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
  $config=Join-Path $app 'config.json'
  $prefs='{"voiceChatKey":"MOUSE4","customSpellPhrases":{"invoker_tornado":["\u0443\u0440\u0430\u0433\u0430\u043d"]},"itemPhrases":{"item_slot_item1":["\u0449\u0438\u0442"]},"testOnly":true}'
  [IO.File]::WriteAllText($config,$prefs)
  New-Item -ItemType Directory -Path (Join-Path $dota 'game\bin\win64'),(Split-Path -Parent $cfg) -Force | Out-Null
  New-Item -ItemType File -Path (Join-Path $dota 'game\bin\win64\dota2.exe') | Out-Null
  [IO.File]::WriteAllText($cfg,'original GSI fixture')
  $before=(Get-FileHash -LiteralPath $cfg).Hash
  $setup=Join-Path $app 'setup-dota.ps1'
  Run-Checked 'powershell.exe' @('-NoProfile','-NonInteractive','-File',('"' + $setup + '"'),'-NoPrompt','-DotaPath',('"' + $dota + '"'))
  $state=Join-Path $app '.dota-install.json'
  if(-not (Test-Path -LiteralPath $state)){throw 'Backup missing'}
  $backup=[IO.File]::ReadAllText($state)
  Run-Checked $installerPath @('/S',"/D=$dest")
  if([IO.File]::ReadAllText($config) -ne $prefs){throw 'Upgrade lost preferences'}
  if([IO.File]::ReadAllText($state) -ne $backup){throw 'Upgrade lost GSI backup'}
  if((Get-FileHash -LiteralPath $model).Hash -ne $manifest.sha256){throw 'Upgrade changed model'}
  Run-Checked (Join-Path $dest 'Uninstall.exe') @('/S',"_?=$dest")
  if(Test-Path -LiteralPath (Join-Path $dest 'VoiceInvoker.exe')){throw 'Uninstall left executable'}
  if((Get-FileHash -LiteralPath $cfg).Hash -ne $before){throw 'GSI original not restored'}
  if([IO.File]::ReadAllText($config) -ne $prefs){throw 'Uninstall lost preferences'}
  if((Get-FileHash -LiteralPath $model).Hash -ne $manifest.sha256){throw 'Uninstall lost model'}
  Write-Host 'PASS: actual installer, upgrade, retained preferences/model, GSI restore and uninstall'
} finally {
  if(Test-Path -LiteralPath $root){Remove-Item -LiteralPath $root -Recurse -Force}
}
