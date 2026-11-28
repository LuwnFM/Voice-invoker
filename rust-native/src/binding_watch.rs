//! Event-driven watcher for the parent directory (Steam may replace the file).
use crate::{bindings,config::Config};
use notify::{Event,RecommendedWatcher,RecursiveMode,Watcher};
use std::{path::{Path,PathBuf},sync::mpsc::{self,Receiver},time::{Duration,Instant}};
pub struct BindingWatch{
    _watcher:RecommendedWatcher,events:Receiver<notify::Result<Event>>,file:PathBuf,
}
impl BindingWatch{
    pub fn new(file:&Path)->Result<Self,Box<dyn std::error::Error>>{
        let file=std::path::absolute(file)?;
        let parent=file.parent().ok_or("Binding path has no parent")?;
        let (tx,events)=mpsc::channel();
        let mut watcher=notify::recommended_watcher(move|event|{let _=tx.send(event);})?;
        watcher.watch(parent,RecursiveMode::NonRecursive)?;
        Ok(Self{_watcher:watcher,events,file})
    }
    pub fn read(&self,config:&Config)->Result<Config,Box<dyn std::error::Error>>{
        let text=std::fs::read_to_string(&self.file)?;
        let b=bindings::read(&text)?;
        Ok(bindings::apply(config,&b)?)
    }
    /// Block only for the supplied interval. Coalesce bursts for at most 350 ms.
    pub fn changed(&self,timeout:Duration)->Result<bool,Box<dyn std::error::Error>>{
        let deadline=Instant::now()+timeout;
        loop{
            let remaining=deadline.saturating_duration_since(Instant::now());
            match self.events.recv_timeout(remaining){
                Ok(event)=>{
                    let event=event?;
                    if !event.kind.is_access()&&event.paths.iter().any(|p|same_file(p,&self.file)){
                        let until=Instant::now()+Duration::from_millis(350);
                        while Instant::now()<until{
                            match self.events.recv_timeout(until.saturating_duration_since(Instant::now())){
                                Ok(Ok(_))=>{},
                                Ok(Err(e))=>return Err(e.into()),
                                Err(_)=>break,
                            }
                        }
                        return Ok(true);
                    }
                },
                Err(mpsc::RecvTimeoutError::Timeout)=>return Ok(false),
                Err(e)=>return Err(e.into()),
            }
        }
    }
}
fn same_file(a:&Path,b:&Path)->bool{
    if cfg!(windows){a.file_name().zip(b.file_name()).is_some_and(|(x,y)|x.to_string_lossy().eq_ignore_ascii_case(&y.to_string_lossy()))}
    else{a.file_name()==b.file_name()}
}
pub fn monitor(file:&Path,seconds:u64)->Result<(),Box<dyn std::error::Error>>{
    if !(1..=300).contains(&seconds){return Err("Seconds must be 1..300".into());}
    let watcher=BindingWatch::new(file)?;let mut cfg=Config::default();
    let deadline=Instant::now()+Duration::from_secs(seconds);
    let mut refresh=true;
    while Instant::now()<deadline{
        if refresh{
            match watcher.read(&cfg){Ok(next)=>{println!("Validated bindings: {:?}, modes: {:?}",next.keys,next.slot_cast_modes);cfg=next;},Err(e)=>eprintln!("Bindings unchanged: {e}")}
        }
        refresh=watcher.changed(deadline.saturating_duration_since(Instant::now()))?;
    }
    Ok(())
}
