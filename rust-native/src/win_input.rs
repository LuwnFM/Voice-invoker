//! Windows adapter: dedicated OS message thread for low-level keyboard/mouse hooks.
//! The public smoke test observes only. Live blocking is explicitly armed by the session.
use crate::{config::Config,input::{Event,InputState}};
use std::{cell::RefCell,io,ptr::{null,null_mut},sync::{Arc,atomic::{AtomicBool,AtomicU32,Ordering},mpsc::{sync_channel,Receiver,SyncSender}},collections::BTreeSet,thread::{self,JoinHandle},time::Duration};
use windows_sys::Win32::{
    Foundation::{LPARAM,LRESULT,WPARAM},
    System::{LibraryLoader::GetModuleHandleW,Threading::GetCurrentThreadId},
    UI::WindowsAndMessaging::{
        CallNextHookEx,GetForegroundWindow,GetMessageW,GetWindowTextW,PeekMessageW,PostThreadMessageW,
        SetWindowsHookExW,UnhookWindowsHookEx,HHOOK,KBDLLHOOKSTRUCT,MSLLHOOKSTRUCT,MSG,
        LLKHF_INJECTED,LLMHF_INJECTED,PM_NOREMOVE,WH_KEYBOARD_LL,WH_MOUSE_LL,
        WM_KEYDOWN,WM_KEYUP,WM_SYSKEYDOWN,WM_SYSKEYUP,WM_MBUTTONDOWN,WM_MBUTTONUP,WM_XBUTTONDOWN,WM_XBUTTONUP,WM_QUIT,WM_APP,
    },
};
pub(crate) const OWN_TAG:usize=0x564f4943;
const UPDATE:u32=WM_APP+44;
type BindingRequest=(Config,SyncSender<()>);
struct Context {state:InputState,config:Config,events:SyncSender<Event>,overflow:Arc<AtomicBool>,snapshot:Arc<AtomicU32>,arm:Arc<AtomicBool>,live:bool,suppressed:BTreeSet<u16>}
impl Context{fn publish(&self){self.snapshot.store(u32::from(self.state.enabled)|u32::from(self.state.listening)<<1|u32::from(self.state.chat)<<2,Ordering::Release);}}
thread_local!{static CONTEXT:RefCell<Option<Context>>=const{RefCell::new(None)};}
pub fn focused(title:&str)->bool{
    if title.is_empty(){return false;} // fail closed: do not observe arbitrary windows
    let mut buffer=[0u16;256];
    // SAFETY: valid buffer and OS-owned foreground window handle.
    unsafe{
        let hwnd=GetForegroundWindow();
        if hwnd.is_null(){return false;}
        let n=GetWindowTextW(hwnd,buffer.as_mut_ptr(),buffer.len() as i32);
        n>0&&String::from_utf16_lossy(&buffer[..n as usize])==title
    }
}
fn handle(vk:u16,down:bool,injected:bool,own:bool)->bool{
    if own{return false;}
    CONTEXT.with(|c|{
        let Ok(mut c)=c.try_borrow_mut()else{return false;};
        let Some(ctx)=c.as_mut()else{return false;};
        if injected&&!ctx.config.accept_injected{return false;}
        let (swallow,event)=ctx.state.handle(vk,down,focused(&ctx.config.window_title));
        ctx.publish();
        if let Some(event)=event{if ctx.events.try_send(event).is_err(){ctx.overflow.store(true,Ordering::Release);ctx.arm.store(false,Ordering::Release);}}
        if !down{return ctx.suppressed.remove(&vk);}
        if ctx.suppressed.contains(&vk){return true;}
        let hotkey=matches!(event,Some(Event::Toggle|Event::Quit|Event::Settings|Event::Profile(_)));
        if ctx.live&&swallow&&(hotkey||ctx.arm.load(Ordering::Acquire)&&matches!(event,Some(Event::Blocked))){
            ctx.suppressed.insert(vk);return true;
        }
        false
    })
}
unsafe extern "system" fn keyboard(code:i32,w:WPARAM,l:LPARAM)->LRESULT{
    // A panic must never unwind across the Windows callback boundary.
    let blocked=std::panic::catch_unwind(||{
        if code>=0&&l!=0{
            // SAFETY: Windows provides a KBDLLHOOKSTRUCT for valid low-level hook events.
            let k=unsafe{&*(l as *const KBDLLHOOKSTRUCT)};
            let down=matches!(w as u32,WM_KEYDOWN|WM_SYSKEYDOWN);
            if down||matches!(w as u32,WM_KEYUP|WM_SYSKEYUP){return handle(k.vkCode as u16,down,k.flags&LLKHF_INJECTED!=0,k.dwExtraInfo==OWN_TAG);}
        }
        false
    }).unwrap_or(false);
    if blocked{return 1;}
    unsafe{CallNextHookEx(null_mut(),code,w,l)}
}
unsafe extern "system" fn mouse(code:i32,w:WPARAM,l:LPARAM)->LRESULT{
    let blocked=std::panic::catch_unwind(||{
        if code>=0&&l!=0{
            let m=unsafe{&*(l as *const MSLLHOOKSTRUCT)};
            let button=match w as u32{
                WM_MBUTTONDOWN|WM_MBUTTONUP=>Some(4),
                WM_XBUTTONDOWN|WM_XBUTTONUP=>match m.mouseData>>16{1=>Some(5),2=>Some(6),_=>None},
                _=>None,
            };
            if let Some(vk)=button{return handle(vk,matches!(w as u32,WM_MBUTTONDOWN|WM_XBUTTONDOWN),m.flags&LLMHF_INJECTED!=0,m.dwExtraInfo==OWN_TAG);}
        }
        false
    }).unwrap_or(false);
    if blocked{return 1;}
    unsafe{CallNextHookEx(null_mut(),code,w,l)}
}
struct HookHandle(HHOOK);
impl Drop for HookHandle{fn drop(&mut self){unsafe{UnhookWindowsHookEx(self.0);}}}
pub struct Hook {
    tid:u32,thread:Option<JoinHandle<io::Result<()>>>,pub events:Receiver<Event>,pub overflow:Arc<AtomicBool>,snapshot:Arc<AtomicU32>,updates:SyncSender<BindingRequest>,
}
impl Hook {
    pub fn start(config:Config)->io::Result<Self>{Self::start_session(config,false,Arc::new(AtomicBool::new(false)))}
    pub fn start_session(config:Config,live:bool,arm:Arc<AtomicBool>)->io::Result<Self>{
        let (ready_tx,ready_rx)=sync_channel::<io::Result<u32>>(1);
        let (events_tx,events)=sync_channel(64);
        let overflow=Arc::new(AtomicBool::new(false));let flag=overflow.clone();
        let snapshot=Arc::new(AtomicU32::new(0));let shared=snapshot.clone();
        let (updates,requests)=sync_channel::<BindingRequest>(1);
        let thread=thread::spawn(move||{
            CONTEXT.with(|c|{let ctx=Context{state:InputState::new(&config),config,events:events_tx,overflow:flag,snapshot:shared,arm,live,suppressed:BTreeSet::new()};ctx.publish();*c.borrow_mut()=Some(ctx);});
            // SAFETY: this dedicated thread owns the Windows message queue and both hooks.
            unsafe{
                let mut msg:MSG=std::mem::zeroed();
                PeekMessageW(&mut msg,null_mut(),0,0,PM_NOREMOVE);
                let module=GetModuleHandleW(null());
                let keyboard_hook=SetWindowsHookExW(WH_KEYBOARD_LL,Some(keyboard),module,0);
                if keyboard_hook.is_null(){let e=io::Error::last_os_error();let _=ready_tx.send(Err(e));return Err(io::Error::last_os_error());}
                let _keyboard=HookHandle(keyboard_hook);
                let mouse_hook=SetWindowsHookExW(WH_MOUSE_LL,Some(mouse),module,0);
                if mouse_hook.is_null(){let e=io::Error::last_os_error();let _=ready_tx.send(Err(e));return Err(io::Error::last_os_error());}
                let _mouse=HookHandle(mouse_hook);
                if ready_tx.send(Ok(GetCurrentThreadId())).is_err(){return Ok(());}
                loop{
                    let n=GetMessageW(&mut msg,null_mut(),0,0);
                    if n==0{break;}
                    if n<0{return Err(io::Error::last_os_error());}
                    if msg.message==UPDATE{if let Ok((config,ack))=requests.try_recv(){CONTEXT.with(|c|{if let Some(ctx)=c.borrow_mut().as_mut(){ctx.state.update_bindings(&config);ctx.config=config;ctx.publish();}});let _=ack.send(());}}
                }
            }
            CONTEXT.with(|c|*c.borrow_mut()=None);
            Ok(())
        });
        let tid=ready_rx.recv_timeout(Duration::from_secs(5)).map_err(|e|io::Error::other(e.to_string()))??;
        Ok(Self{tid,thread:Some(thread),events,overflow,snapshot,updates})
    }
    fn finish(&mut self)->io::Result<()>{
        if let Some(thread)=self.thread.take(){
            if !thread.is_finished()&&unsafe{PostThreadMessageW(self.tid,WM_QUIT,0,0)}==0{return Err(io::Error::last_os_error());}
            return thread.join().map_err(|_|io::Error::other("Hook thread panicked"))?;
        }
        Ok(())
    }
    pub fn snapshot(&self)->(bool,bool,bool){let n=self.snapshot.load(Ordering::Acquire);(n&1!=0,n&2!=0,n&4!=0)}
    pub fn update(&self,config:Config)->io::Result<()>{
        let (ack,rx)=sync_channel(1);self.updates.try_send((config,ack)).map_err(|e|io::Error::other(e.to_string()))?;
        if unsafe{PostThreadMessageW(self.tid,UPDATE,0,0)}==0{return Err(io::Error::last_os_error());}
        rx.recv_timeout(Duration::from_secs(2)).map_err(|e|io::Error::other(e.to_string()))
    }
    pub fn running(&self)->bool{self.thread.as_ref().is_some_and(|t|!t.is_finished())}
    pub fn stop(mut self)->io::Result<()>{self.finish()}
}
impl Drop for Hook{fn drop(&mut self){let _=self.finish();}}
pub fn smoke()->io::Result<()>{
    for _ in 0..3{let hook=Hook::start(Config::default())?;let mut next=Config::default();next.keys.insert("invoke".into(),"B".into());hook.update(next)?;thread::sleep(Duration::from_millis(50));hook.stop()?;}
    println!("PASS: native Windows keyboard and mouse hook start/stop x3 (observe only)");
    Ok(())
}
