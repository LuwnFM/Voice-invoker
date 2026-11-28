use serde::Deserialize;
use sha2::{Digest,Sha256};
use std::{collections::BTreeSet,fs::File,io::{Read,BufReader},path::{Path,PathBuf}};
use flate2::read::GzDecoder;
#[derive(Debug,Deserialize)]
pub struct Manifest{pub filename:String,pub size:u64,pub sha256:String}
pub fn manifest()->Manifest{serde_json::from_str(include_str!("../../model-manifest.json")).expect("checked manifest")}
pub fn verify(path:&Path)->Result<(),Box<dyn std::error::Error>>{
    let expected=manifest();let file=File::open(path)?;
    if file.metadata()?.len()!=expected.size{return Err("V2 size mismatch".into());}
    let mut reader=BufReader::new(file);let mut hasher=Sha256::new();let mut buf=[0u8;65536];
    loop{let n=reader.read(&mut buf)?;if n==0{break;}hasher.update(&buf[..n]);}
    if format!("{:x}",hasher.finalize())!=expected.sha256{return Err("V2 SHA-256 mismatch".into());}
    Ok(())
}
pub fn extract_verified(archive:&Path,destination:&Path)->Result<PathBuf,Box<dyn std::error::Error>>{
    extract_with_options(archive,destination,false)
}
pub fn extract_with_options(archive:&Path,destination:&Path,experimental_frames:bool)->Result<PathBuf,Box<dyn std::error::Error>>{
    verify(archive)?;
    if destination.exists(){return Err("Extraction destination must not exist".into());}
    std::fs::create_dir(destination)?;
    let result=(||->Result<PathBuf,Box<dyn std::error::Error>>{
        let mut tar=tar::Archive::new(GzDecoder::new(File::open(archive)?));
        for entry in tar.entries()?{
            let mut entry=entry?;let kind=entry.header().entry_type();
            if !kind.is_file()&&!kind.is_dir(){return Err("Unexpected archive entry".into());}
            if !entry.unpack_in(destination)?{return Err("Unsafe archive path".into());}
        }
        let root=destination.join("vosk-model-small-ru-0.22");
        if !root.join("graph/Gr.fst").is_file()||!root.join("am/final.mdl").is_file(){return Err("Incomplete V2 model".into());}
        if experimental_frames{
            let conf=root.join("conf/model.conf");
            let original=std::fs::read_to_string(&conf)?;
            std::fs::write(&conf,frames_three(&original))?;
        }
        Ok(root)
    })();
    if result.is_err(){let _=std::fs::remove_dir_all(destination);}
    result
}
pub fn words_from_graph(graph:&[u8])->Result<BTreeSet<String>,String>{
    let start=graph.windows(4).position(|w|w==[0x74,0xfb,0xb2,0x7e]).ok_or("Missing FST word symbols")?;
    let mut pos=start+4;
    fn take<'a>(g:&'a[u8],p:&mut usize,n:usize)->Result<&'a[u8],String>{let end=p.checked_add(n).ok_or("Overflow")?;let b=g.get(*p..end).ok_or("Truncated symbol table")?;*p=end;Ok(b)}
    fn i32le(g:&[u8],p:&mut usize)->Result<i32,String>{Ok(i32::from_le_bytes(take(g,p,4)?.try_into().unwrap()))}
    let n=i32le(graph,&mut pos)?;
    if !(1..=4096).contains(&n){return Err("Invalid symbol header".into());}
    let name=std::str::from_utf8(take(graph,&mut pos,n as usize)?).map_err(|e|e.to_string())?;
    if !name.ends_with("words.txt"){return Err("Unexpected symbol table".into());}
    take(graph,&mut pos,8)?;
    let count=i64::from_le_bytes(take(graph,&mut pos,8)?.try_into().unwrap());
    if !(1..=1_000_000).contains(&count){return Err("Invalid symbol count".into());}
    let mut words=BTreeSet::new();
    for _ in 0..count{
        let n=i32le(graph,&mut pos)?;if !(1..=4096).contains(&n){return Err("Invalid word length".into());}
        let word=std::str::from_utf8(take(graph,&mut pos,n as usize)?).map_err(|e|e.to_string())?.to_lowercase();
        take(graph,&mut pos,8)?;
        if word.chars().all(|c|c.is_ascii_alphanumeric()||c=='-'||c=='ё'||('а'..='я').contains(&c)){words.insert(word);}
    }
    Ok(words)
}
pub fn read_words(model:&Path)->Result<BTreeSet<String>,Box<dyn std::error::Error>>{Ok(words_from_graph(&std::fs::read(model.join("graph/Gr.fst"))?)?)}

/// Only called on a freshly extracted, disposable copy of verified V2.
pub fn frames_three(text:&str)->String{
    let mut result=text.lines().filter(|line|{
        let trimmed=line.trim_start();
        !(trimmed.starts_with("--frames-per-chunk=")||trimmed.strip_prefix("--frames-per-chunk").is_some_and(|s|s.starts_with(char::is_whitespace)))
    }).collect::<Vec<_>>().join("\n");
    result.push_str("\n--frames-per-chunk=3\n");result
}
#[cfg(test)]
mod tests{
    #[test]
    fn experimental_frames_only_changes_the_copy_setting(){
        let text="--beam=10\n --frames-per-chunk=20\n--max-active=5000\n";
        let result=super::frames_three(text);
        assert_eq!(result,"--beam=10\n--max-active=5000\n--frames-per-chunk=3\n");
        assert!(text.contains("20"));
    }
}
