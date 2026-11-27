// The installed application uses Electron's embedded Node, never system npm.
const fs=require('node:fs'),path=require('node:path');
const {selectExpandedModel}=require('../model-selection');
const lock=require('../package-lock.json');
function verifyPackaged(strictModel=false){
 if(process.platform!=='win32'||process.arch!=='x64')throw Error('Windows x64 is required');
 if(process.versions.electron!==lock.packages['node_modules/electron'].version||!process.versions.node)throw Error('Bundled Electron/Node runtime mismatch');
 const root=path.resolve(__dirname,'..');
 for(const name of ['koffi','vosk-browser','uuid']){
  const installed=JSON.parse(fs.readFileSync(path.join(root,'node_modules',name,'package.json'),'utf8')).version;
  if(installed!==lock.packages['node_modules/'+name].version)throw Error('Incorrect bundled dependency: '+name);
 }
 require('koffi').load('user32.dll');
 require.resolve('vosk-browser/dist/vosk.js');
 const model=selectExpandedModel(path.join(root,'model'),true);
 if(!model.active){
  if(strictModel)throw Error('V2: '+model.reason);
  console.warn('V2: '+model.reason+'; application will attempt verified recovery');
 }
 console.log('Bundled Electron '+process.versions.electron+', Node '+process.versions.node+', Koffi/Vosk/UUID OK; V2: '+model.reason);
}
if(require.main===module)try{verifyPackaged(process.argv.includes('--strict-model'));}catch(e){console.error('Installed runtime check failed: '+e.message);process.exitCode=1;}
module.exports={verifyPackaged};
