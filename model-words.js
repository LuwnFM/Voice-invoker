// Read the word symbol table embedded in the actual selected Vosk graph.
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const MAGIC=Buffer.from([0x74,0xfb,0xb2,0x7e]);
function wordsFromGraph(graph){
 const start=graph.indexOf(MAGIC);if(start<0||start+8>graph.length)throw Error('Missing FST word symbols');
 let p=start+4;const length=graph.readInt32LE(p);p+=4;
 if(length<1||length>4096||p+length+16>graph.length)throw Error('Invalid symbol header');
 const name=graph.toString('utf8',p,p+length);p+=length;
 if(!name.endsWith('words.txt'))throw Error('Unexpected symbol table '+name);
 p+=8;const count=Number(graph.readBigInt64LE(p));p+=8;
 if(!Number.isSafeInteger(count)||count<1||count>1000000)throw Error('Invalid symbol count');
 const words=new Set();
 for(let i=0;i<count;i++){
   if(p+4>graph.length)throw Error('Truncated symbols');
   const n=graph.readInt32LE(p);p+=4;
   if(n<1||n>4096||p+n+8>graph.length)throw Error('Invalid word symbol');
   const word=graph.toString('utf8',p,p+n);p+=n+8;
   if(/^[а-яёa-z0-9-]+$/iu.test(word))words.add(word.toLowerCase());
 }
 return words;
}
function readModelWords(archive){
 const tar=path.join(process.env.SystemRoot||'C:\\Windows','System32','tar.exe');
 const graph=execFileSync(tar,['-xOf',archive,'vosk-model-small-ru-0.22/graph/Gr.fst'],{windowsHide:true,maxBuffer:64*1024*1024,timeout:60000});
 return wordsFromGraph(graph);
}
module.exports={wordsFromGraph,readModelWords};
