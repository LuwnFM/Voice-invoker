// The installed GUI launcher uses Electron's embedded Node, never npm or a BAT.
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {initializeUserData}=require('../user-data');
const {verifyPackaged}=require('./check-packaged-runtime');
const {launchBackground}=require('./launch');
const root=path.resolve(__dirname,'..');
function main(){
  initializeUserData(root);
  verifyPackaged();
  const args=['-NoProfile','-NonInteractive','-File',path.join(root,'setup-dota.ps1'),'-NoPrompt'];
  if(!process.argv.includes('--no-dota'))args.push('-Launch');
  const setup=spawnSync('powershell.exe',args,{cwd:root,windowsHide:true,stdio:'inherit',timeout:30000});
  if(setup.error||setup.status!==0){
    console.error('Dota/GSI setup failed:',setup.error?.message||setup.status);
    process.env.VI_SETUP_FAILED='1';
    process.env.VI_REOPEN_SETTINGS='1';
  }
  launchBackground(root);
}
if(require.main===module)try{main();}catch(e){console.error('Installed launcher failed:',e.message);process.exitCode=1;}
