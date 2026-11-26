// Exercise actual WinAPI hook registration and cooperative shutdown in Electron's Node runtime.
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const koffi = require('koffi');
const { WM_APP_QUIT } = require('../messages');
const { NORMAL } = require('../timing-profiles');
const post = koffi.load('user32.dll').func('bool __stdcall PostThreadMessageW(uint32 idThread, uint32 Msg, uintptr_t wParam, intptr_t lParam)');
async function cycle() {
  const worker = new Worker(path.join(__dirname,'..','hook-worker.js'), {workerData:{config:{...NORMAL,keys:{quas:'Q',wex:'W',exort:'E',invoke:'R',slot1:'D',slot2:'F'},voiceChatKey:'G',listen:'hold',castMode:'click',blockKeys:[],windowTitle:'Voice Invoker test only'}}});
  await new Promise((resolve,reject)=>{
    let stopped=false;
    const timeout=setTimeout(()=>{console.error('Native hook shutdown timed out');process.exit(1)},15000);
    worker.on('message',m=>{
      if(m.type==='ready' && !post(m.threadId,WM_APP_QUIT,0,0)) reject(new Error('PostThreadMessage failed'));
      if(m.type==='stopped') stopped=m.clean;
    });
    worker.on('error',reject);
    worker.on('exit',code=>{clearTimeout(timeout);if(code===0&&stopped)resolve();else reject(new Error('Unclean worker exit '+code));});
  });
}
(async()=>{for(let i=0;i<3;i++)await cycle();console.log('Native hook start/stop x3 OK');})().catch(e=>{console.error(e);process.exit(1)});
