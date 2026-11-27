// The UI and GSI are local-only. Reject browser cross-origin writes and DNS rebinding.
const MAX_BODY_BYTES=256*1024;
function allowedHost(host,port){return ['localhost:'+port,'127.0.0.1:'+port].includes(String(host||'').toLowerCase());}
function allowedOrigin(origin,port){return origin===undefined||['http://localhost:'+port,'http://127.0.0.1:'+port].includes(origin);}
function jsonContentType(value){return /^application\/json(?:\s*;|$)/i.test(String(value||''));}
function readJson(req){
 return new Promise((resolve,reject)=>{
  const chunks=[];let size=0,tooLarge=false;
  req.on('data',chunk=>{
    size+=chunk.length;
    if(size>MAX_BODY_BYTES){tooLarge=true;chunks.length=0;return;}
    if(!tooLarge)chunks.push(chunk);
  });
  req.on('aborted',()=>reject(Object.assign(Error('Request aborted'),{statusCode:400})));
  req.on('error',reject);
  req.on('end',()=>{
    if(tooLarge)return reject(Object.assign(Error('Request too large'),{statusCode:413}));
    try{
      const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!data||typeof data!=='object'||Array.isArray(data))throw Error('Expected object');
      resolve(data);
    }catch{reject(Object.assign(Error('Invalid JSON object'),{statusCode:400}));}
  });
 });
}
module.exports={allowedHost,allowedOrigin,jsonContentType,readJson,MAX_BODY_BYTES};
