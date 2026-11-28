//! Installed native runtime bootstrap: no Node, Electron, Python or PowerShell.
use crate::{config::Config,model,storage::{self,Store}};
use std::{path::{Path,PathBuf},io,fs};
use windows_sys::Win32::{Foundation::{CloseHandle,GetLastError,ERROR_ALREADY_EXISTS,HANDLE},System::Threading::CreateMutexW};
struct Instance(HANDLE);
impl Instance{fn acquire()->io::Result<Option<Self>>{let name:Vec<u16>="Local\\VoiceInvokerNativeSession".encode_utf16().chain(std::iter::once(0)).collect();unsafe{let h=CreateMutexW(std::ptr::null(),0,name.as_ptr());if h.is_null(){return Err(io::Error::last_os_error());}if GetLastError()==ERROR_ALREADY_EXISTS{CloseHandle(h);Ok(None)}else{Ok(Some(Self(h)))}}}}
impl Drop for Instance{fn drop(&mut self){unsafe{CloseHandle(self.0);}}}
pub fn launch(live:bool,launch_dota:bool)->Result<(),Box<dyn std::error::Error>>{
    let exe=std::env::current_exe()?;
    let root=exe.parent().ok_or("Missing application directory")?;
    let dir=storage::native_directory()?;
    let store=Store::open(&dir)?;
    if let Some(appdata)=std::env::var_os("APPDATA"){
        store.migrate(&PathBuf::from(appdata).join("VoiceInvoker/config.json"))?;
    }
    let config=match store.load()?{Some(c)=>c,None=>{let c=Config::default();store.save(&c)?;c}};
    let Some(instance)=Instance::acquire()?else{let _=std::process::Command::new(&exe).args(["settings-window",&config.port.to_string()]).spawn();return Ok(());};
    let dll=root.join("runtime/libvosk.dll");
    let archive=root.join("model").join(model::manifest().filename);
    if !dll.is_file(){return Err("Bundled Vosk runtime missing; reinstall the application".into());}
    // Fresh extraction from verified bytes; no model-cache tampering or modification of archive.
    let workspace=tempfile::Builder::new().prefix("vi-model-").tempdir_in(&dir)?;
    let extracted=model::extract_with_options(&archive,&workspace.path().join("unpacked"),config.experimental_frames)?;
    if launch_dota{
        if let Some((steam,_))=crate::steam::automatic_steam(){
            if let Some(dota)=crate::steam::discover_dota(&steam,None){
                match crate::integration::install(&dota,&dir,&config){
                    Ok(_) if !crate::steam::process_running("dota2.exe")=>{let _=std::process::Command::new(steam.join("steam.exe")).args(["-applaunch","570","-gamestateintegration","-windowed","-noborder"]).spawn();},
                    Ok(_)=>{},
                    Err(e)=>eprintln!("GSI setup: {e}"),
                }
            }else{eprintln!("Dota not found; open diagnostics");}
        }else{eprintln!("Steam not found; open diagnostics");}
    }
    rotate_logs(&dir)?;
    let result=crate::desktop::run(&dll,&extracted,config,&store.path(),live,86400,true);
    if let Err(e)=&result{
        use std::io::Write;
        if let Ok(mut log)=fs::OpenOptions::new().create(true).append(true).open(dir.join("log.txt")){let _=writeln!(log,"Fatal: {e}");}
    }
    let restart=result?;drop(workspace);drop(instance);
    if restart{let mut command=std::process::Command::new(exe);command.arg("launch");if live{command.arg("--live");}command.spawn()?;}
    Ok(())
}
fn rotate_logs(dir:&std::path::Path)->io::Result<()>{
    let log=dir.join("log.txt");
    if log.metadata().is_ok_and(|m|m.len()>2*1024*1024){
        let previous=dir.join("log.previous.txt");if previous.exists(){fs::remove_file(&previous)?;}fs::rename(log,previous)?;
    }
    Ok(())
}

pub fn verify_install(root:&Path)->Result<(),Box<dyn std::error::Error>>{
    let archive=root.join("model").join(model::manifest().filename);
    let dll=root.join("runtime/libvosk.dll");
    let workspace=tempfile::tempdir()?;
    let extracted=model::extract_verified(&archive,&workspace.path().join("model"))?;
    let words=model::read_words(&extracted)?;
    let c=Config::default();let cat=crate::catalog::resolve(&c,Some(&words));
    if cat.active.len()!=143||!cat.errors.is_empty(){return Err("Catalog failed".into());}
    let parser=crate::recognition::Parser::new(&cat);
    let mut vosk=crate::vosk::Vosk::new(&dll,&extracted,16000,&parser.grammar())?;
    let (_,text)=vosk.feed(&[0;512])?;if !parser.parse(&text).is_empty(){return Err("Silence produced a command".into());}
    vosk.reset();let text=vosk.finish()?;if !parser.parse(&text).is_empty(){return Err("Silence produced a command".into());}
    println!("PASS: installed native DLL, verified V2 and recognition without external runtime");
    Ok(())
}
pub fn fatal(message:&str){
    let title:Vec<u16>="Voice Invoker — критическая ошибка".encode_utf16().chain(std::iter::once(0)).collect();
    let message:Vec<u16>=message.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe{windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW(std::ptr::null_mut(),message.as_ptr(),title.as_ptr(),windows_sys::Win32::UI::WindowsAndMessaging::MB_ICONERROR);}
}
