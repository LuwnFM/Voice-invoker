//! Win32 notification-area icon and click-through overlay. No browser process.
use crate::ui::Ui;
use std::{cell::RefCell,io,mem::size_of,ptr::{null,null_mut},sync::mpsc::{sync_channel,Receiver,SyncSender},thread::{self,JoinHandle},time::Duration};
use windows_sys::Win32::{
    Foundation::{HWND,LPARAM,LRESULT,WPARAM,POINT,RECT},
    Graphics::Gdi::{BeginPaint,EndPaint,PAINTSTRUCT,CreateSolidBrush,DeleteObject,FillRect,SetBkMode,SetTextColor,DrawTextW,SelectObject,GetStockObject,DEFAULT_GUI_FONT,TRANSPARENT,DT_SINGLELINE,DT_END_ELLIPSIS,DT_VCENTER,DT_LEFT,InvalidateRect},
    System::{LibraryLoader::GetModuleHandleW,Threading::GetCurrentThreadId},
    UI::{Shell::{Shell_NotifyIconW,NOTIFYICONDATAW,NIF_MESSAGE,NIF_ICON,NIF_TIP,NIM_ADD,NIM_DELETE},
        WindowsAndMessaging::*},
};
const TRAY:u32=WM_APP+51;
const WIDTH:i32=380;const HEIGHT:i32=86;
#[derive(Debug,Clone,Copy)]
pub enum ShellEvent{Settings,Toggle,Restart,Quit}
struct Context{
    ui:Ui,events:SyncSender<ShellEvent>,overlay:HWND,title:String,show_overlay:bool,taskbar:u32,
    icon:NOTIFYICONDATAW,owned_icon:bool,
}
thread_local!{static CTX:RefCell<Option<Context>>=const{RefCell::new(None)};}
fn wide(s:&str)->Vec<u16>{s.encode_utf16().chain(std::iter::once(0)).collect()}
fn send(event:ShellEvent){CTX.with(|c|{if let Ok(c)=c.try_borrow(){if let Some(ctx)=c.as_ref(){let _=ctx.events.try_send(event);}}});}
unsafe fn tray_menu(hwnd:HWND){
    let menu=unsafe{CreatePopupMenu()};if menu.is_null(){return;}
    let labels=[(1,"Настройки"),(2,"Включить / выключить"),(3,"Перезапустить"),(4,"Выход")];
    for (id,label) in labels{unsafe{AppendMenuW(menu,MF_STRING,id,wide(label).as_ptr());}}
    let mut pt=POINT{x:0,y:0};unsafe{GetCursorPos(&mut pt);SetForegroundWindow(hwnd);}
    let command=unsafe{TrackPopupMenu(menu,TPM_RETURNCMD|TPM_RIGHTBUTTON,pt.x,pt.y,0,hwnd,null())};
    unsafe{DestroyMenu(menu);PostMessageW(hwnd,WM_NULL,0,0);}
    match command{1=>send(ShellEvent::Settings),2=>send(ShellEvent::Toggle),3=>send(ShellEvent::Restart),4=>send(ShellEvent::Quit),_=>{}}
}
fn color(r:u32,g:u32,b:u32)->u32{r|(g<<8)|(b<<16)}
unsafe fn paint(hwnd:HWND){
    let mut ps:PAINTSTRUCT=unsafe{std::mem::zeroed()};
    let dc=unsafe{BeginPaint(hwnd,&mut ps)};
    if dc.is_null(){return;}
    let mut rect=RECT{left:0,top:0,right:WIDTH,bottom:HEIGHT};
    let bg=unsafe{CreateSolidBrush(color(14,17,20))};
    unsafe{FillRect(dc,&rect,bg);DeleteObject(bg);}
    let (enabled,listening,transcript,level,notice)=CTX.with(|c|c.borrow().as_ref().map(|ctx|ctx.ui.overlay())).unwrap_or((false,false,String::new(),0.0,None));
    let label=if let Some(notice)=notice{notice}else if listening{if transcript.is_empty(){"Назови способность…".into()}else{transcript}}else if enabled{"Voice Invoker".into()}else{"Каст выключен".into()};
    unsafe{SetBkMode(dc,TRANSPARENT as i32);SetTextColor(dc,color(230,235,240));SelectObject(dc,GetStockObject(DEFAULT_GUI_FONT));}
    rect.left=18;rect.right-=12;rect.top=10;rect.bottom=59;
    let mut text=wide(&label);unsafe{DrawTextW(dc,text.as_mut_ptr(),-1,&mut rect,DT_LEFT|DT_VCENTER|DT_SINGLELINE|DT_END_ELLIPSIS);}
    let edge=unsafe{CreateSolidBrush(color(227,136,54))};
    let bar=RECT{left:0,top:0,right:4,bottom:HEIGHT};unsafe{FillRect(dc,&bar,edge);}
    if listening{let meter=RECT{left:18,top:64,right:18+((WIDTH-36) as f64*level.clamp(0.0,100.0)/100.0) as i32,bottom:69};unsafe{FillRect(dc,&meter,edge);}}
    unsafe{DeleteObject(edge);EndPaint(hwnd,&ps);}
}
fn refresh(){
    CTX.with(|c|{
        let Ok(c)=c.try_borrow()else{return;};let Some(ctx)=c.as_ref()else{return;};
        let (enabled,listening,_,_,notice)=ctx.ui.overlay();
        let show=ctx.show_overlay&&crate::win_input::focused(&ctx.title)&&((enabled&&listening)||notice.is_some());
        unsafe{
            if show{
                let mut pt=POINT{x:0,y:0};GetCursorPos(&mut pt);
                let sw=GetSystemMetrics(SM_CXSCREEN).max(WIDTH);let sh=GetSystemMetrics(SM_CYSCREEN).max(HEIGHT);
                let x=if notice.is_some(){(pt.x-WIDTH/2).clamp(0,sw-WIDTH)}else{(sw-WIDTH)/2};
                let y=if notice.is_some(){(pt.y-HEIGHT-24).clamp(0,sh-HEIGHT)}else{32};
                SetWindowPos(ctx.overlay,HWND_TOPMOST,x,y,WIDTH,HEIGHT,SWP_NOACTIVATE|SWP_SHOWWINDOW);
                InvalidateRect(ctx.overlay,null(),0);
            }else{ShowWindow(ctx.overlay,SW_HIDE);}
        }
    });
}
unsafe extern "system" fn wndproc(hwnd:HWND,msg:u32,w:WPARAM,l:LPARAM)->LRESULT{
    let handled=std::panic::catch_unwind(||{
        if msg==TRAY{match l as u32{WM_LBUTTONDBLCLK=>send(ShellEvent::Settings),WM_RBUTTONUP=>unsafe{tray_menu(hwnd)},_=>{}}return true;}
        if msg==WM_TIMER{refresh();return true;}
        if msg==WM_PAINT{
            let overlay=CTX.with(|c|c.try_borrow().ok().and_then(|c|c.as_ref().map(|x|x.overlay)));
            if overlay==Some(hwnd){unsafe{paint(hwnd);}return true;}
        }
        let recover=CTX.with(|c|c.try_borrow().ok().and_then(|c|c.as_ref().map(|x|x.taskbar))).is_some_and(|id|id!=0&&id==msg);
        if recover{CTX.with(|c|{if let Some(ctx)=c.borrow().as_ref(){unsafe{Shell_NotifyIconW(NIM_ADD,&ctx.icon);}}});return true;}
        false
    }).unwrap_or(false);
    if handled{0}else{unsafe{DefWindowProcW(hwnd,msg,w,l)}}
}
pub struct Shell{tid:u32,thread:Option<JoinHandle<io::Result<()>>>,pub events:Receiver<ShellEvent>}
impl Shell{
    pub fn start(ui:Ui,title:String,show_overlay:bool,with_tray:bool)->io::Result<Self>{
        let (ready_tx,ready_rx)=sync_channel(1);let (events_tx,events)=sync_channel(16);
        let thread=thread::spawn(move||{
            // SAFETY: all HWND/HICON resources belong to this message-loop thread.
            unsafe{
                let instance=GetModuleHandleW(null());let name=wide("VoiceInvokerNativeShell");
                let wc=WNDCLASSW{lpfnWndProc:Some(wndproc),hInstance:instance,lpszClassName:name.as_ptr(),..std::mem::zeroed()};
                if RegisterClassW(&wc)==0{return Err(io::Error::last_os_error());}
                let hwnd=CreateWindowExW(WS_EX_TOOLWINDOW,name.as_ptr(),wide("Voice Invoker tray").as_ptr(),WS_POPUP,0,0,0,0,null_mut(),null_mut(),instance,null());
                if hwnd.is_null(){UnregisterClassW(name.as_ptr(),instance);return Err(io::Error::last_os_error());}
                let overlay=CreateWindowExW(WS_EX_TOPMOST|WS_EX_LAYERED|WS_EX_TRANSPARENT|WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE,name.as_ptr(),wide("Voice Invoker overlay").as_ptr(),WS_POPUP,0,0,WIDTH,HEIGHT,null_mut(),null_mut(),instance,null());
                if overlay.is_null(){DestroyWindow(hwnd);UnregisterClassW(name.as_ptr(),instance);return Err(io::Error::last_os_error());}
                SetLayeredWindowAttributes(overlay,0,238,LWA_ALPHA);
                let png=include_bytes!("../../icon.png");
                let custom=CreateIconFromResourceEx(png.as_ptr() as *mut u8,png.len() as u32,1,0x00030000,32,32,LR_DEFAULTCOLOR);
                let owned_icon=!custom.is_null();let hicon=if owned_icon{custom}else{LoadIconW(null_mut(),IDI_APPLICATION)};
                let mut icon:NOTIFYICONDATAW=std::mem::zeroed();
                icon.cbSize=size_of::<NOTIFYICONDATAW>() as u32;icon.hWnd=hwnd;icon.uID=1;icon.uFlags=NIF_MESSAGE|NIF_ICON|NIF_TIP;icon.uCallbackMessage=TRAY;icon.hIcon=hicon;
                for (to,from) in icon.szTip.iter_mut().zip(wide("Voice Invoker Native")){*to=from;}
                let taskbar=RegisterWindowMessageW(wide("TaskbarCreated").as_ptr());
                CTX.with(|c|*c.borrow_mut()=Some(Context{ui,events:events_tx,overlay,title,show_overlay,taskbar,icon,owned_icon}));
                if with_tray{CTX.with(|c|{if let Some(ctx)=c.borrow().as_ref(){Shell_NotifyIconW(NIM_ADD,&ctx.icon);}});}
                let timer=SetTimer(hwnd,1,60,None);
                let mut msg:MSG=std::mem::zeroed();let tid=GetCurrentThreadId();
                let _=ready_tx.send(tid);
                loop{let n=GetMessageW(&mut msg,null_mut(),0,0);if n<=0{break;}TranslateMessage(&msg);DispatchMessageW(&msg);}
                if timer!=0{KillTimer(hwnd,timer);}
                CTX.with(|c|{if let Some(ctx)=c.borrow_mut().take(){if with_tray{Shell_NotifyIconW(NIM_DELETE,&ctx.icon);}if ctx.owned_icon{DestroyIcon(ctx.icon.hIcon);}}});
                DestroyWindow(overlay);DestroyWindow(hwnd);UnregisterClassW(name.as_ptr(),instance);
                Ok(())
            }
        });
        let tid=ready_rx.recv_timeout(Duration::from_secs(5)).map_err(|e|io::Error::other(e.to_string()))?;
        Ok(Self{tid,thread:Some(thread),events})
    }
    fn finish(&mut self)->io::Result<()>{
        if let Some(thread)=self.thread.take(){if !thread.is_finished(){unsafe{PostThreadMessageW(self.tid,WM_QUIT,0,0);}}return thread.join().map_err(|_|io::Error::other("Shell thread panicked"))?;}Ok(())
    }
    pub fn stop(mut self)->io::Result<()>{self.finish()}
}
impl Drop for Shell{fn drop(&mut self){let _=self.finish();}}
pub fn smoke()->io::Result<()>{
    let c=crate::config::Config::default();let gsi=crate::gsi_server::GsiState::new(&c);
    let ui=Ui::new(&c,None,Default::default(),Vec::new(),true,gsi);
    let shell=Shell::start(ui,c.window_title,false,false)?;shell.stop()?;
    println!("PASS: native hidden tray host and transparent overlay window lifecycle (no visible overlay)");Ok(())
}
