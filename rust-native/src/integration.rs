//! Explicit GSI install/restore with an isolated recovery record.
//! Steam launch options and other integration files are never modified.
use crate::config::Config;
use serde::{Deserialize,Serialize};
use sha2::{Digest,Sha256};
use std::{fs,io::{self,Write},path::{Path,PathBuf}};
use tempfile::NamedTempFile;
const NAME:&str="gamestate_integration_voice_invoke.cfg";
const RECORD:&str="gsi-install.json";
#[derive(Debug,PartialEq,Eq)]
pub enum Outcome{Installed,Unchanged,Restored,NotTracked}
#[derive(Serialize,Deserialize)]
struct Record{target:PathBuf,original:Option<Vec<u8>>,installed_hash:String,pending_hash:Option<String>}
fn hash(bytes:&[u8])->String{format!("{:x}",Sha256::digest(bytes))}
fn atomic(path:&Path,bytes:&[u8])->io::Result<()>{
    let mut tmp=NamedTempFile::new_in(path.parent().ok_or_else(||io::Error::other("Missing parent"))?)?;
    tmp.write_all(bytes)?;tmp.as_file().sync_all()?;tmp.persist(path).map_err(|e|e.error)?;Ok(())
}
fn read_optional(path:&Path)->io::Result<Option<Vec<u8>>>{
    match fs::read(path){Ok(bytes)=>Ok(Some(bytes)),Err(e) if e.kind()==io::ErrorKind::NotFound=>Ok(None),Err(e)=>Err(e)}
}
fn record(dir:&Path)->Result<Option<Record>,Box<dyn std::error::Error>>{
    read_optional(&dir.join(RECORD))?.map(|b|serde_json::from_slice(&b).map_err(Into::into)).transpose()
}
fn target(dota:&Path)->Result<PathBuf,Box<dyn std::error::Error>>{
    let dota=dota.canonicalize()?;
    if !dota.join("game/bin/win64/dota2.exe").is_file(){return Err("Invalid Dota folder".into());}
    Ok(dota.join("game/dota/cfg/gamestate_integration").join(NAME))
}
fn valid_target(p:&Path)->bool{
    p.file_name().is_some_and(|n|n==NAME)&&p.ancestors().nth(4).is_some_and(|d|d.join("bin/win64/dota2.exe").is_file())
}
pub fn bytes(c:&Config)->Result<Vec<u8>,String>{
    if c.port==0||c.auth_token.is_empty()||!c.auth_token.bytes().all(|b|b.is_ascii_alphanumeric()||matches!(b,b'_'|b'-')){return Err("Invalid GSI port or token".into());}
    Ok(include_str!("../../gamestate_integration_voice_invoke.cfg").replace("127.0.0.1:3055/gsi",&format!("127.0.0.1:{}/gsi",c.port)).replace("\"voice_invoke\"",&format!("\"{}\"",c.auth_token)).into_bytes())
}
fn allowed_current(r:&Record,current:Option<&[u8]>)->bool{
    match current{
        None=>r.original.is_none(),
        Some(b)=>{let h=hash(b);h==r.installed_hash||r.pending_hash.as_ref()==Some(&h)||r.original.as_deref()==Some(b)}
    }
}
pub fn install(dota:&Path,dir:&Path,c:&Config)->Result<Outcome,Box<dyn std::error::Error>>{
    fs::create_dir_all(dir)?;
    let path=target(dota)?;
    let desired=bytes(c)?;
    let current=read_optional(&path)?;
    let existing=record(dir)?;
    if let Some(r)=&existing{
        if r.target!=path{return Err("Dota moved; restore the previous GSI first".into());}
        if !allowed_current(r,current.as_deref()){return Err("GSI changed externally; backup kept".into());}
    }else if current.as_deref()==Some(&desired){return Ok(Outcome::Unchanged);}
    let mut rec=existing.unwrap_or_else(||Record{target:path.clone(),original:current,installed_hash:hash(&desired),pending_hash:None});
    rec.pending_hash=Some(hash(&desired));
    atomic(&dir.join(RECORD),&serde_json::to_vec_pretty(&rec)?)?;
    fs::create_dir_all(path.parent().ok_or("Missing GSI folder")?)?;
    atomic(&path,&desired)?;
    rec.installed_hash=hash(&desired);rec.pending_hash=None;
    atomic(&dir.join(RECORD),&serde_json::to_vec_pretty(&rec)?)?;
    Ok(Outcome::Installed)
}
pub fn remove(dir:&Path)->Result<Outcome,Box<dyn std::error::Error>>{
    let Some(r)=record(dir)?else{return Ok(Outcome::NotTracked);};
    if !valid_target(&r.target){return Err("Invalid or missing tracked Dota installation; backup kept".into());}
    let current=read_optional(&r.target)?;
    if !allowed_current(&r,current.as_deref()){return Err("GSI changed externally; backup kept".into());}
    if let Some(original)=r.original{atomic(&r.target,&original)?;}else if r.target.exists(){fs::remove_file(&r.target)?;}
    fs::remove_file(dir.join(RECORD))?;
    Ok(Outcome::Restored)
}
#[cfg(test)]
mod tests{
    use super::*;
    fn fixture()->(tempfile::TempDir,PathBuf,PathBuf){
        let dir=tempfile::tempdir().unwrap();
        let dota=dir.path().join("Dota");let exe=dota.join("game/bin/win64/dota2.exe");
        fs::create_dir_all(exe.parent().unwrap()).unwrap();fs::write(exe,b"").unwrap();
        let store=dir.path().join("native");
        (dir,dota,store)
    }
    #[test]
    fn install_restore_preserves_original_and_external_changes(){
        let (_root,dota,store)=fixture();let p=target(&dota).unwrap();
        fs::create_dir_all(p.parent().unwrap()).unwrap();fs::write(&p,b"old").unwrap();
        let c=Config::default();assert_eq!(install(&dota,&store,&c).unwrap(),Outcome::Installed);
        assert_eq!(fs::read(&p).unwrap(),bytes(&c).unwrap());
        fs::write(&p,b"external").unwrap();assert!(remove(&store).is_err());assert!(install(&dota,&store,&c).is_err());assert_eq!(fs::read(&p).unwrap(),b"external");
        fs::write(&p,bytes(&c).unwrap()).unwrap();assert_eq!(remove(&store).unwrap(),Outcome::Restored);assert_eq!(fs::read(&p).unwrap(),b"old");
    }
    #[test]
    fn identical_legacy_gsi_is_not_owned_or_removed(){
        let (_root,dota,store)=fixture();let p=target(&dota).unwrap();
        fs::create_dir_all(p.parent().unwrap()).unwrap();let c=Config::default();fs::write(&p,bytes(&c).unwrap()).unwrap();
        assert_eq!(install(&dota,&store,&c).unwrap(),Outcome::Unchanged);
        assert_eq!(remove(&store).unwrap(),Outcome::NotTracked);assert!(p.is_file());
    }
    #[test]
    fn new_gsi_removal_and_config_validation(){
        let (_root,dota,store)=fixture();let p=target(&dota).unwrap();
        assert_eq!(install(&dota,&store,&Config::default()).unwrap(),Outcome::Installed);
        assert_eq!(remove(&store).unwrap(),Outcome::Restored);assert!(!p.exists());
        let c=Config{auth_token:"bad\"token".into(),..Config::default()};assert!(install(&dota,&store,&c).is_err());
    }
}
