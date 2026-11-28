//! Installed native runtime bootstrap: no Node, Electron, Python or PowerShell.
use crate::{config::Config,model,storage::{self,Store}};
use std::{path::PathBuf,io,fs};
pub fn launch(live:bool,launch_dota:bool)->Result<(),Box<dyn std::error::Error>>{
    let exe=std::env::current_exe()?;
    let root=exe.parent().ok_or("Missing application directory")?;
    let dir=storage::native_directory()?;
    let store=Store::open(&dir)?;
    if let Some(appdata)=std::env::var_os("APPDATA"){
        store.migrate(&PathBuf::from(appdata).join("VoiceInvoker/config.json"))?;
    }
    let config=match store.load()?{Some(c)=>c,None=>{let c=Config::default();store.save(&c)?;c}};
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
                    Ok(_)=>{let _=std::process::Command::new(steam.join("steam.exe")).args(["-applaunch","570","-gamestateintegration","-windowed","-noborder"]).spawn();},
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
    result
}
fn rotate_logs(dir:&std::path::Path)->io::Result<()>{
    let log=dir.join("log.txt");
    if log.metadata().is_ok_and(|m|m.len()>2*1024*1024){
        let previous=dir.join("log.previous.txt");if previous.exists(){fs::remove_file(&previous)?;}fs::rename(log,previous)?;
    }
    Ok(())
}
