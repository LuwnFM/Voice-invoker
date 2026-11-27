// Exercise actual WinAPI hook registration and cooperative shutdown in Electron's Node runtime.
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const koffi = require('koffi');
const { WM_APP_QUIT, WM_APP_BINDINGS } = require('../messages');
const { NORMAL } = require('../timing-profiles');
const post = koffi.load('user32.dll').func('bool __stdcall PostThreadMessageW(uint32 idThread, uint32 Msg, uintptr_t wParam, intptr_t lParam)');
const {BUFFER_SIZE,writeBindingUpdate}=require('../binding-sync');
async function cycle() {
  const bindingBuffer=new SharedArrayBuffer(BUFFER_SIZE);
  writeBindingUpdate(bindingBuffer,{keys:{quas:'A',wex:'W',exort:'E',invoke:'R',slot1:'D',slot2:'F'},voiceChatKey:'T',slotCastModes:{slot1:'quickcast'}});
  let threadId=0;
  const worker = new Worker(path.join(__dirname,'..','hook-worker.js'), {workerData:{bindingBuffer,config:{...NORMAL,keys:{quas:'Q',wex:'W',exort:'E',invoke:'R',slot1:'D',slot2:'F'},voiceChatKey:'G',listen:'hold',castMode:'click',blockKeys:[],windowTitle:'Voice Invoker test only'}}});
  await new Promise((resolve,reject)=>{
    let stopped=false;
    const timeout=setTimeout(()=>{console.error('Native hook shutdown timed out');process.exit(1)},15000);
    worker.on('message',m=>{
      if(m.type==='ready'){threadId=m.threadId;if(!post(threadId,WM_APP_BINDINGS,1,0))reject(Error('Binding message failed'));}
      if(m.type==='bindings-applied'){if(!m.ok||m.id!==1)reject(Error('Binding update failed'));else if(!post(threadId,WM_APP_QUIT,0,0))reject(Error('Quit message failed'));}
      if(m.type==='stopped') stopped=m.clean;
    });
    worker.on('error',reject);
    worker.on('exit',code=>{clearTimeout(timeout);if(code===0&&stopped)resolve();else reject(new Error('Unclean worker exit '+code));});
  });
}
(async()=>{for(let i=0;i<3;i++)await cycle();console.log('Native hook start/stop x3 OK');})().catch(e=>{console.error(e);process.exit(1)});
