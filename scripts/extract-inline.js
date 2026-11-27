const fs=require('node:fs');const path=require('node:path');
const dir=path.join(__dirname,'..','.quality-html');fs.mkdirSync(dir,{recursive:true});
for(const f of ['settings.html','overlay.html']){
 const content=fs.readFileSync(path.join(__dirname,'..',f),'utf8');
 const scripts=[...content.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).filter(x=>x.trim());
 fs.writeFileSync(path.join(dir,f+'.js'),scripts.join('\n'));
}
