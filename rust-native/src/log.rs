//! Bounded local diagnostic log. No raw microphone or authentication tokens.
use std::{fs,io::{self,Write},path::{Path,PathBuf},time::{SystemTime,UNIX_EPOCH}};
const MAX:u64=2*1024*1024;
#[derive(Clone,Default)]
pub struct SessionLog{directory:Option<PathBuf>}
impl SessionLog{
    pub fn new(directory:Option<&Path>)->Self{Self{directory:directory.map(Path::to_owned)}}
    pub fn write(&self,message:&str){
        if let Some(dir)=&self.directory{if let Err(e)=append(dir,message){eprintln!("Log: {e}");}}
    }
}
fn append(dir:&Path,message:&str)->io::Result<()>{
    let file=dir.join("log.txt");
    if file.metadata().is_ok_and(|m|m.len()>=MAX){
        let previous=dir.join("log.previous.txt");
        if previous.exists(){fs::remove_file(&previous)?;}
        fs::rename(&file,previous)?;
    }
    let mut out=fs::OpenOptions::new().create(true).append(true).open(file)?;
    let timestamp=SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let line:String=message.chars().take(1000).map(|c|if c.is_control(){' '}else{c}).collect();
    writeln!(out,"{timestamp} {line}")
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn bounded_rotating_log(){
        let dir=tempfile::tempdir().unwrap();
        fs::write(dir.path().join("log.txt"),vec![b'x';MAX as usize]).unwrap();
        let log=SessionLog::new(Some(dir.path()));
        log.write("native\nready");
        assert_eq!(fs::metadata(dir.path().join("log.previous.txt")).unwrap().len(),MAX);
        assert!(fs::read_to_string(dir.path().join("log.txt")).unwrap().contains("native ready"));
    }
}
