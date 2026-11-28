use crate::catalog::{Catalog,Target};
use std::collections::BTreeSet;
pub const PREFIXES:[&str;6]=["запиши в фолиант","записать в фолиант","подготовить","подготовь","готовь","готовить"];
pub fn is_cue(word:&str)->bool{word=="фолиант"||PREFIXES.iter().any(|p|p.split_whitespace().next()==Some(word))}
#[derive(Debug,Clone,PartialEq,Eq)]
pub struct Command {pub phrase:String,pub target:Target,pub prepare_only:bool}
pub struct Parser {
    entries:Vec<(String,Vec<String>,Target)>,
}
impl Parser {
    pub fn new(catalog:&Catalog)->Self{
        let mut entries:Vec<_>=catalog.active.iter().map(|(p,t)|(p.clone(),p.split_whitespace().map(str::to_owned).collect::<Vec<_>>(),t.clone())).collect();
        entries.sort_by_key(|a|std::cmp::Reverse(a.1.len()));
        Self{entries}
    }
    pub fn parse(&self,text:&str)->Vec<Command>{
        let lower=text.to_lowercase();
        let words:Vec<_>=lower.split_whitespace().filter(|w|*w!="[unk]").collect();
        let mut result=Vec::new();let(mut i,mut preparing,mut blocked)=(0,false,false);
        while i<words.len(){
            let prefix=PREFIXES.iter().map(|p|p.split_whitespace().collect::<Vec<_>>()).find(|p|words[i..].starts_with(p));
            if let Some(p)=prefix{preparing=true;blocked=false;i+=p.len();continue;}
            if is_cue(words[i]){blocked=true;i+=1;continue;}
            let hit=self.entries.iter().find(|(_,tokens,_)|tokens.iter().enumerate().all(|(j,w)|words.get(i+j).is_some_and(|x|*x==w.as_str())));
            if let Some((phrase,tokens,target))=hit {
                if !blocked{result.push(Command{phrase:phrase.clone(),target:target.clone(),prepare_only:preparing});}
                i+=tokens.len();
            }else{i+=1;}
        }
        result
    }
    pub fn grammar(&self)->Vec<String>{
        let mut all=BTreeSet::new();
        for p in PREFIXES{all.insert(p.to_owned());}
        for (phrase,_,_) in &self.entries{
            all.insert(phrase.clone());
            for p in PREFIXES{all.insert(format!("{p} {phrase}"));}
        }
        all.insert("[unk]".into());all.into_iter().collect()
    }
}
#[derive(Default)]
pub struct Gate{cue_seen:bool}
impl Gate {
    pub fn read(&mut self,parser:&Parser,text:&str,finalized:bool)->Vec<Command>{
        self.cue_seen|=text.to_lowercase().split_whitespace().any(is_cue);
        if self.cue_seen&&!finalized{return Vec::new();}
        let mut result=parser.parse(text);
        if self.cue_seen{result.retain(|c|c.prepare_only);}
        result
    }
    pub fn reset(&mut self){self.cue_seen=false;}
}
