use crate::{catalog::{Spell,ITEM_KEYS},config::{Config,Mode},input::{Action,vk_of}};
use serde::Deserialize;
use std::collections::BTreeMap;
#[derive(Debug,Default,Deserialize)]
#[serde(default)]
pub struct Ability {pub name:String,pub cooldown:Option<f64>,pub can_cast:Option<bool>,pub passive:bool}
#[derive(Debug,Default,Deserialize)]
#[serde(default)]
pub struct Hero{pub name:String,pub alive:bool,pub aghanims_scepter:Option<bool>}
#[derive(Debug,Default,Deserialize)]
#[serde(default)]
pub struct Packet {pub auth:Auth,pub hero:Hero,pub abilities:BTreeMap<String,Ability>,pub items:BTreeMap<String,Ability>}
#[derive(Debug,Default,Deserialize)]
#[serde(default)]
pub struct Auth{pub token:String}
#[derive(Debug,PartialEq,Eq)]
pub enum Plan{Cast(Action),Prepared,Wait,Refuse(&'static str)}
impl Packet{
    pub fn authenticated(&self,c:&Config)->bool{self.auth.token==c.auth_token&&!c.auth_token.is_empty()}
    pub fn ability(&self,id:&str)->Option<&Ability>{self.abilities.values().find(|a|a.name==id)}
    pub fn slots(&self)->Vec<&str>{
        let mut entries:Vec<_>=self.abilities.iter().collect();
        entries.sort_by_key(|(k,_)|k.strip_prefix("ability").and_then(|v|v.parse::<usize>().ok()).unwrap_or(usize::MAX));
        let spell_ids=crate::catalog::spells();
        entries.into_iter().map(|(_,a)|a.name.as_str()).filter(|name|name.starts_with("invoker_empty")||spell_ids.iter().any(|s|s.id==*name)).take(2).collect()
    }
    pub fn plan(&self,s:&Spell,prepare:bool,fresh:bool)->Plan{
        if !fresh||self.hero.name.is_empty(){return Plan::Cast(if prepare{Action::Prepare}else{Action::Invoke});}
        if self.hero.name!="npc_dota_hero_invoker"||!self.hero.alive{return Plan::Refuse("Hero unavailable");}
        if !prepare&&s.needs_scepter&&self.hero.aghanims_scepter==Some(false){return Plan::Refuse("Scepter required");}
        let id=s.base.as_deref().unwrap_or(&s.id);
        if let Some(i)=self.slots().iter().position(|v|*v==id){
            if prepare{return Plan::Prepared;}
            if self.ability(id).is_some_and(|a|a.cooldown.is_some_and(|v|v>0.0)||a.can_cast==Some(false)){return Plan::Refuse("Ability unavailable");}
            return Plan::Cast(if i==1{Action::Slot2}else{Action::Slot1});
        }
        if self.ability("invoker_invoke").is_some_and(|a|a.cooldown.is_some_and(|v|v>0.0)||a.can_cast==Some(false)){return Plan::Refuse("Invoke unavailable");}
        Plan::Cast(Action::Prepare)
    }
    pub fn item_mode(&self,slot:usize,c:&Config,fresh:bool,prepare:bool)->Result<Mode,&'static str>{
        if prepare||!fresh||self.hero.name!="npc_dota_hero_invoker"||!self.hero.alive{return Err("Item requires fresh live Invoker state");}
        let key=ITEM_KEYS.get(slot).ok_or("Invalid slot")?;
        if c.keys.get(*key).and_then(|v|vk_of(v)).is_none(){return Err("Unassigned item key");}
        let gsi_key=if slot<6{format!("slot{slot}")}else if slot==6{"neutral0".into()}else{"teleport0".into()};
        let item=self.items.get(&gsi_key).ok_or("Empty slot")?;
        if item.name.is_empty()||item.name=="empty"||item.name=="item_empty"||item.passive||item.can_cast!=Some(true)||!item.cooldown.is_some_and(|v|v.is_finite()&&v<=0.0){return Err("Item unavailable");}
        Ok(c.item_cast_modes.get(&item.name).or_else(||c.slot_cast_modes.get(*key)).copied().unwrap_or(Mode::Quickcast))
    }
}
