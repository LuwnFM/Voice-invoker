//! WebView2 settings only; runs in a separate short-lived child process.
//! The game loop, overlay, audio and input never depend on WebView2.
use std::{io,process::{Child,Command},os::windows::process::CommandExt};
use tao::{dpi::LogicalSize,event::{Event,WindowEvent},event_loop::{ControlFlow,EventLoop},window::WindowBuilder};
use wry::{WebViewBuilder,NewWindowResponse};

pub fn run(port:u16)->Result<(),Box<dyn std::error::Error>>{
    if port==0{return Err("Invalid settings port".into());}
    let url=format!("http://127.0.0.1:{port}/settings");
    if wry::webview_version().is_err(){
        // Older Windows installations may lack WebView2; keep a functional fallback.
        Command::new("explorer.exe").arg(&url).spawn()?;
        return Ok(());
    }
    let event_loop=EventLoop::new();
    let window=WindowBuilder::new().with_title("Voice Invoker — настройки")
        .with_inner_size(LogicalSize::new(720.0,880.0))
        .with_min_inner_size(LogicalSize::new(520.0,480.0))
        .build(&event_loop)?;
    let allowed=url.clone();
    let view=WebViewBuilder::new().with_url(&url).with_incognito(true)
        .with_devtools(false).with_navigation_handler(move |u|u==allowed)
        .with_new_window_req_handler(|_,_|NewWindowResponse::Deny)
        .with_download_started_handler(|_,_|false).build(&window);
    let view=match view{Ok(v)=>v,Err(e)=>{eprintln!("WebView2 unavailable: {e}");Command::new("explorer.exe").arg(url).spawn()?;return Ok(());}};
    event_loop.run(move|event,_,control|{
        let _keep_alive=(&window,&view);
        *control=ControlFlow::Wait;
        if matches!(event,Event::WindowEvent{event:WindowEvent::CloseRequested,..}){*control=ControlFlow::Exit;}
    });
}
#[derive(Default)]
pub struct SettingsChild{child:Option<Child>}
impl SettingsChild{
    pub fn open(&mut self,port:u16)->io::Result<()>{
        if let Some(child)=self.child.as_mut(){if child.try_wait()?.is_none(){return Ok(());}}
        self.child=Some(Command::new(std::env::current_exe()?).args(["settings-window",&port.to_string()]).creation_flags(0x08000000).spawn()?);
        Ok(())
    }
}
impl Drop for SettingsChild{
    fn drop(&mut self){if let Some(mut child)=self.child.take(){if child.try_wait().ok().flatten().is_none(){let _=child.kill();let _=child.wait();}}}
}
