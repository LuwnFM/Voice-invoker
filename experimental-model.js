// Never modify the verified base model. The opt-in variant lives only in a temporary directory.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');
function experimentalModel(base) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'voice-invoker-experimental-'));
  const tar=path.join(process.env.SystemRoot||'C:\\Windows','System32','tar.exe');
  const run=args=>execFileSync(tar,args,{cwd:dir,windowsHide:true,timeout:120000});
  try {
    run(['-xzf',base]);
    const dirs=fs.readdirSync(dir,{withFileTypes:true}).filter(x=>x.isDirectory());
    if(dirs.length!==1)throw Error('Unexpected model layout');
    const folder=dirs[0].name, conf=path.join(dir,folder,'conf','model.conf');
    const contents=fs.readFileSync(conf,'utf8').replace(/^\s*--frames-per-chunk(?:=|\s+).*$/gm,'').trimEnd();
    fs.writeFileSync(conf,contents+'\n--frames-per-chunk=3\n');
    const file=path.join(dir,'experimental.tar.gz');
    run(['-czf',file,folder]);
    fs.rmSync(path.join(dir,folder),{recursive:true,force:true});
    return {file,cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};
  } catch(e) {fs.rmSync(dir,{recursive:true,force:true});throw e;}
}
module.exports={experimentalModel};
