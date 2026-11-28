use crate::config::{Config,Phrases};
use serde::Deserialize;
use std::collections::{BTreeMap,BTreeSet};

pub const ITEM_KEYS:[&str;8]=["item1","item2","item3","item4","item5","item6","neutral","teleport"];
#[derive(Debug,Clone,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Spell {
    pub id:String,pub name:String,pub combo:String,pub target:bool,
    pub base:Option<String>,pub self_cast:bool,pub needs_scepter:bool,
    pub phrases:Vec<String>,pub v2_only:Vec<String>,
}
pub fn spells()->Vec<Spell>{serde_json::from_str(include_str!("../data/spells.json")).expect("checked spell catalog")}
pub fn normalize(p:&str)->String{p.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")}
#[derive(Debug,Clone,PartialEq,Eq)]
pub enum Target {Spell(String),Item(usize)}
#[derive(Debug)]
pub struct Catalog {
    pub active:BTreeMap<String,Target>,
    pub errors:Vec<String>,
}
fn denied(disabled:&Phrases,id:&str,p:&str)->bool{
    disabled.get(id).is_some_and(|list|list.iter().any(|s|normalize(s)==p))
}
fn valid(p:&str,words:Option<&BTreeSet<String>>)->bool{
    !p.is_empty()&&p.encode_utf16().count()<=120&&p.split_whitespace().count()<=12&&p.split_whitespace().all(|w|!crate::recognition::is_cue(w)&&words.is_some_and(|dict|dict.contains(w)))
}
pub fn resolve(cfg:&Config,words:Option<&BTreeSet<String>>)->Catalog{
    let mut active=BTreeMap::new();
    let mut reserved=BTreeSet::new();
    let mut errors=Vec::new();
    let spells=spells();
    // Reserve all enabled built-ins including V2-only, exactly as 1.1.1.
    for s in &spells {
        for p in &s.phrases {
            if denied(&cfg.disabled_phrases,&s.id,p){continue;}
            if !reserved.insert(p.clone()){errors.push(format!("Duplicate builtin: {p}"));continue;}
            if cfg.expanded_vocabulary||!s.v2_only.contains(p){active.insert(p.clone(),Target::Spell(s.id.clone()));}
        }
    }
    for s in &spells {
        let mut seen=BTreeSet::new();
        // Historical custom aliases are also additive. Validate both sources against the actual dictionary.
        let legacy=cfg.phrases.get(&s.id).into_iter().flatten();
        let custom=cfg.custom_spell_phrases.get(&s.id).into_iter().flatten();
        if legacy.clone().count()+custom.clone().count()>100{errors.push(format!("Too many aliases: {}",s.id));continue;}
        for raw in legacy.chain(custom) {
            let p=normalize(raw);
            if p.is_empty()||!seen.insert(p.clone()){continue;}
            if s.phrases.contains(&p){continue;}
            let excluded=denied(&cfg.disabled_phrases,&s.id,&p);
            if !valid(&p,words)||(!excluded&&reserved.contains(&p)){errors.push(format!("Invalid or conflicting alias: {p}"));continue;}
            if !excluded{reserved.insert(p.clone());active.insert(p,Target::Spell(s.id.clone()));}
        }
    }
    for (i,key) in ITEM_KEYS.iter().enumerate(){
        let id=format!("item_slot_{key}");
        if let Some(list)=cfg.item_phrases.get(&id){
            if list.len()>100{errors.push(format!("Too many aliases: {id}"));continue;}
            let mut seen=BTreeSet::new();
            for raw in list {
                let p=normalize(raw);
                if p.is_empty()||!seen.insert(p.clone()){continue;}
                if !valid(&p,words)||!reserved.insert(p.clone()){errors.push(format!("Invalid or conflicting item alias: {p}"));continue;}
                active.insert(p,Target::Item(i));
            }
        }
    }
    Catalog{active,errors}
}
