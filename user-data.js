// Shared user preferences and logs, independent of the installed binaries.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
function dataDirectory(env=process.env){
 return path.resolve(env.VI_DATA_DIR||path.join(env.APPDATA||path.join(os.homedir(),'AppData','Roaming'),'VoiceInvoker'));
}
function initializeUserData(root,env=process.env){
 const dir=dataDirectory(env);
 fs.mkdirSync(dir,{recursive:true});
 const source=path.join(root,'config.json'),target=path.join(dir,'config.json');
 // Copy only once. Never replace existing AppData preferences, including a
 // damaged file: the application's diagnostics must report it for recovery.
 if(!fs.existsSync(target)&&path.resolve(source)!==path.resolve(target)&&fs.existsSync(source)){
   try{fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);}
   catch(e){if(e.code!=='EEXIST')throw e;}
 }
 return dir;
}
module.exports={dataDirectory,initializeUserData};
