//! Windows adapter: dedicated OS message thread for low-level keyboard/mouse hooks.
//! The public prototype smoke test observes only. No global blocking or injection.
use crate::{config::Config,input::{Event,InputState}};
use std::{cell::RefCell,io,ptr::{null,null_mut},sync::mpsc::{sync_channel,Receiver,SyncSender},thread::{self,JoinHandle},time::Duration};
use windows_sys::Win32::{
    Foundation::{LPARAM,LRESULT,WPARAM},
    System::{LibraryLoader::GetModuleHandleW,Threading::GetCurrentThreadId},
    UI::WindowsAndMessaging::{
        CallNextHookEx,GetForegroundWindow,GetMessageW,GetWindowTextW,PeekMessageW,PostThreadMessageW,
        SetWindowsHookExW,UnhookWindowsHookEx,HHOOK,KBDLLHOOKSTRUCT,MSLLHOOKSTRUCT,MSG,
        LLKHF_INJECTED,LLMHF_INJECTED,PM_NOREMOVE,WH_KEYBOARD_LL,WH_MOUSE_LL,
        WM_KEYDOWN,WM_KEYUP,WM_SYSKEYDOWN,WM_SYSKEYUP,WM_MBUTTONDOWN,WM_MBUTTONUP,WM_XBUTTONDOWN,WM_XBUTTONUP,WM_QUIT,
    },
};
pub(crate) const OWN_TAG:usize=0x564f4943;
struct Context {state:InputState,config:Config,events:SyncSender<Event>,overflow:std::sync::Arc<std::sync::atomic::AtomicBool>}
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
fn handle(vk:u16,down:bool,injected:bool,own:bool){
    if own{return;}
    CONTEXT.with(|c|{
        if let Ok(mut c)=c.try_borrow_mut(){
            if let Some(ctx)=c.as_mut(){
                if injected&&!ctx.config.accept_injected{return;}
                let (_,event)=ctx.state.handle(vk,down,focused(&ctx.config.window_title));
                if let Some(event)=event{if ctx.events.try_send(event).is_err(){ctx.overflow.store(true,std::sync::atomic::Ordering::Release);}}
            }
        }
    });
}
unsafe extern "system" fn keyboard(code:i32,w:WPARAM,l:LPARAM)->LRESULT{
    // A panic must never unwind across the Windows callback boundary.
    let _=std::panic::catch_unwind(||{
        if code>=0&&l!=0{
            // SAFETY: Windows provides a KBDLLHOOKSTRUCT for valid low-level hook events.
            let k=unsafe{&*(l as *const KBDLLHOOKSTRUCT)};
            let down=matches!(w as u32,WM_KEYDOWN|WM_SYSKEYDOWN);
            if down||matches!(w as u32,WM_KEYUP|WM_SYSKEYUP){handle(k.vkCode as u16,down,k.flags&LLKHF_INJECTED!=0,k.dwExtraInfo==OWN_TAG);}
        }
    });
    // Observe only. All events are passed through, including application hotkeys.
    unsafe{CallNextHookEx(null_mut(),code,w,l)}
}
unsafe extern "system" fn mouse(code:i32,w:WPARAM,l:LPARAM)->LRESULT{
    let _=std::panic::catch_unwind(||{
        if code>=0&&l!=0{
            let m=unsafe{&*(l as *const MSLLHOOKSTRUCT)};
            let button=match w as u32{
                WM_MBUTTONDOWN|WM_MBUTTONUP=>Some(4),
                WM_XBUTTONDOWN|WM_XBUTTONUP=>match m.mouseData>>16{1=>Some(5),2=>Some(6),_=>None},
                _=>None,
            };
            if let Some(vk)=button{handle(vk,matches!(w as u32,WM_MBUTTONDOWN|WM_XBUTTONDOWN),m.flags&LLMHF_INJECTED!=0,m.dwExtraInfo==OWN_TAG);}
        }
    });
    unsafe{CallNextHookEx(null_mut(),code,w,l)}
}
struct HookHandle(HHOOK);
impl Drop for HookHandle{fn drop(&mut self){unsafe{UnhookWindowsHookEx(self.0);}}}
pub struct Hook {
    tid:u32,thread:Option<JoinHandle<io::Result<()>>>,pub events:Receiver<Event>,pub overflow:std::sync::Arc<std::sync::atomic::AtomicBool>,
}
impl Hook {
    pub fn start(config:Config)->io::Result<Self>{
        let (ready_tx,ready_rx)=sync_channel::<io::Result<u32>>(1);
        let (events_tx,events)=sync_channel(64);
        let overflow=std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));let flag=overflow.clone();
        let thread=thread::spawn(move||{
            CONTEXT.with(|c|*c.borrow_mut()=Some(Context{state:InputState::new(&config),config,events:events_tx,overflow:flag}));
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
                }
            }
            CONTEXT.with(|c|*c.borrow_mut()=None);
            Ok(())
        });
        let tid=ready_rx.recv_timeout(Duration::from_secs(5)).map_err(|e|io::Error::other(e.to_string()))??;
        Ok(Self{tid,thread:Some(thread),events,overflow})
    }
    fn finish(&mut self)->io::Result<()>{
        if let Some(thread)=self.thread.take(){
            if !thread.is_finished()&&unsafe{PostThreadMessageW(self.tid,WM_QUIT,0,0)}==0{return Err(io::Error::last_os_error());}
            return thread.join().map_err(|_|io::Error::other("Hook thread panicked"))?;
        }
        Ok(())
    }
    pub fn running(&self)->bool{self.thread.as_ref().is_some_and(|t|!t.is_finished())}
    pub fn stop(mut self)->io::Result<()>{self.finish()}
}
impl Drop for Hook{fn drop(&mut self){let _=self.finish();}}
pub fn smoke()->io::Result<()>{
    for _ in 0..3{let hook=Hook::start(Config::default())?;thread::sleep(Duration::from_millis(50));hook.stop()?;}
    println!("PASS: native Windows keyboard and mouse hook start/stop x3 (observe only)");
    Ok(())
}
