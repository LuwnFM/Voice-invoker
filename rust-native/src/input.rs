use crate::{catalog::{Spell,ITEM_KEYS},config::{Config,Mode,Profile}};
use std::collections::{BTreeMap,BTreeSet};
pub fn vk_of(key:&str)->Option<u16>{
    let k=key.trim().to_ascii_uppercase();let b=k.as_bytes();
    if b.len()==1&&b[0].is_ascii_alphanumeric(){return Some(u16::from(b[0]));}
    if let Some(f)=k.strip_prefix('F').and_then(|n|n.parse::<u16>().ok()).filter(|n|(1..=24).contains(n)){return Some(0x70+f-1);}
    if let Some(n)=k.strip_prefix("NUM").filter(|s|s.len()==1).and_then(|s|s.parse::<u16>().ok()){return Some(0x60+n);}
    Some(match k.as_str(){
        "TAB"=>9,"SPACE"=>32,"CAPSLOCK"=>20,"BACKSPACE"=>8,"INSERT"=>45,"DELETE"=>46,"HOME"=>36,"END"=>35,"PAGEUP"=>33,"PAGEDOWN"=>34,
        "UP"=>38,"DOWN"=>40,"LEFT"=>37,"RIGHT"=>39,"`"=>0xc0,"-"=>0xbd,"="=>0xbb,"["=>0xdb,"]"=>0xdd,"\\"=>0xdc,
        ";"=>0xba,"'"=>0xde,","=>0xbc,"."=>0xbe,"/"=>0xbf,"MOUSE3"=>4,"MOUSE4"=>5,"MOUSE5"=>6,
        "NUM*"=>0x6a,"NUM+"=>0x6b,"NUM-"=>0x6d,"NUM."=>0x6e,"NUM/"=>0x6f,_=>return None,
    })
}
pub fn validate_keys(c:&Config)->Result<(),String>{
    let mut seen=BTreeMap::new();
    for (name,key) in c.keys.iter().map(|(n,k)|(n.as_str(),k.as_str())).chain(std::iter::once(("voiceChatKey",c.voice_chat_key.as_str()))){
        if key.is_empty(){continue;}
        let vk=vk_of(key).ok_or_else(||format!("Invalid key: {name}"))?;
        if let Some(previous)=seen.insert(vk,name){return Err(format!("Conflicting keys: {previous} / {name}"));}
    }
    Ok(())
}
#[derive(Debug,Clone,Copy,PartialEq,Eq)]
pub enum Action{Slot1,Slot2,Invoke,Prepare}
#[derive(Debug,Clone,Copy,PartialEq,Eq)]
pub enum Step{Key(u16,u64),Down(u16,u64),Up(u16,u64),Click(u64)}
fn key(c:&Config,name:&str,wait:u64)->Result<Step,String>{Ok(Step::Key(c.keys.get(name).and_then(|s|vk_of(s)).ok_or_else(||format!("Unassigned: {name}"))?,wait))}
pub fn sequence(c:&Config,s:&Spell,a:Action,p:Profile)->Result<Vec<Step>,String>{
    let t=c.timing(p);let mut steps=Vec::new();let mut wait=0;
    let slot=if a==Action::Slot2{"slot2"}else{"slot1"};
    if matches!(a,Action::Invoke|Action::Prepare){
        for (i,orb) in s.combo.chars().enumerate(){
            let name=match orb{'Q'=>"quas",'W'=>"wex",'E'=>"exort",_=>return Err("Invalid orb".into())};
            steps.push(key(c,name,if i==0{0}else{t.key})?);
        }
        steps.push(key(c,"invoke",t.key)?);
        if a==Action::Prepare{return Ok(steps);}
        wait=t.cast;
    }
    if s.self_cast{steps.push(Step::Down(0xa4,wait));steps.push(key(c,slot,t.alt)?);steps.push(Step::Up(0xa4,t.alt));}
    else{steps.push(key(c,slot,wait)?);}
    if s.target&&c.slot_cast_modes.get(slot).copied().unwrap_or(c.cast_mode)==Mode::Click{steps.push(Step::Click(t.click));}
    Ok(steps)
}
pub fn item_sequence(c:&Config,slot:usize,mode:Mode,p:Profile)->Result<Vec<Step>,String>{
    let name=ITEM_KEYS.get(slot).ok_or("Invalid item slot")?;
    let mut steps=vec![key(c,name,0)?];
    if mode==Mode::Click{steps.push(Step::Click(c.timing(p).click));}
    Ok(steps)
}
#[derive(Debug,Clone,Copy,PartialEq,Eq)]
pub enum Event{Toggle,Quit,Settings,Profile(Profile),Listen(bool),Blocked}
#[derive(Debug)]
pub struct InputState{
    pub enabled:bool,pub listening:bool,pub chat:bool,pub profile:Profile,
    down:BTreeSet<u16>,swallowed:BTreeSet<u16>,talk:Option<u16>,always:bool,blocked:BTreeSet<u16>,
}
impl InputState{
    pub fn new(c:&Config)->Self{
        let talk=vk_of(&c.voice_chat_key);let always=c.listen=="always"||talk.is_none();
        Self{enabled:true,listening:always,chat:false,profile:c.timing_profile,down:BTreeSet::new(),swallowed:BTreeSet::new(),talk,always,blocked:c.block_keys.iter().filter_map(|k|c.keys.get(k).and_then(|v|vk_of(v))).collect()}
    }
    pub fn update_bindings(&mut self,c:&Config){
        let replacement=Self::new(c);self.talk=replacement.talk;self.always=replacement.always;self.blocked=replacement.blocked;self.listening=self.always;
    }
    pub fn handle(&mut self,vk:u16,down:bool,game:bool)->(bool,Option<Event>){
        if !down{
            self.down.remove(&vk);
            let event=if !self.always&&self.talk==Some(vk)&&self.listening{self.listening=false;Some(Event::Listen(false))}else{None};
            return (self.swallowed.remove(&vk),event);
        }
        let repeat=!self.down.insert(vk);
        let ctrl=[0x11,0xa2,0xa3].iter().any(|k|self.down.contains(k));
        let shift=[0x10,0xa0,0xa1].iter().any(|k|self.down.contains(k));
        let alt=[0x12,0xa4,0xa5].iter().any(|k|self.down.contains(k));
        if ctrl&&shift&&(0x76..=0x7b).contains(&vk){
            self.swallowed.insert(vk);
            if repeat{return(true,None);}
            let ev=match vk{0x76=>{self.enabled=!self.enabled;self.chat=false;if !self.always{self.listening=false;}Event::Toggle},0x77=>Event::Quit,0x78=>Event::Settings,_=>{self.profile=match vk{0x79=>Profile::Normal,0x7a=>Profile::Fast,_=>Profile::Turbo};self.enabled=true;Event::Profile(self.profile)}};
            return (true,Some(ev));
        }
        if repeat&&self.swallowed.contains(&vk){return(true,None);}
        if !self.enabled||repeat||!game{return(false,None);}
        if vk==13{self.chat=!self.chat;}else if vk==27{self.chat=false;}
        if self.chat||ctrl||alt{return(false,None);}
        let mut event=None;
        if !self.always&&self.talk==Some(vk)&&!self.listening{self.listening=true;event=Some(Event::Listen(true));}
        if self.blocked.contains(&vk){self.swallowed.insert(vk);return(true,Some(Event::Blocked));}
        (false,event)
    }
}
