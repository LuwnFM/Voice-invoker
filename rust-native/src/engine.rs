//! Pure deterministic cast controller. Only the OS adapter may execute requests.
//! Times are monotonic milliseconds supplied by the caller.
use crate::{
    catalog::{spells,Spell,Target},
    config::{Config,Profile},
    gsi::{Packet,Plan},
    input::{Action,Step,sequence,item_sequence},
    recognition::Command,
};
use std::collections::{VecDeque,BTreeSet};

#[derive(Debug,Clone)]
pub struct Dispatch {
    pub id:u64,pub command:Command,pub profile:Profile,pub steps:Vec<Step>,
}
#[derive(Debug,Clone,PartialEq,Eq)]
pub enum Notice {Prepared{confirmed:bool},Refused(String),Completed,InputFailed,Watchdog}
#[derive(Debug)]
struct WaitingSlot {command:Command,profile:Profile,from:u64,deadline:Option<u64>,unconfirmed:bool}
#[derive(Debug)]
struct Active {id:u64,command:Command,profile:Profile,action:Option<Action>,deadline:u64,timed_out:bool}
#[derive(Debug,Default)]
struct Prediction {used:BTreeSet<String>,after:Option<u64>}
pub struct Engine {
    config:Config,spells:Vec<Spell>,waiting:VecDeque<(u64,Command)>,last_queued:Option<(u64,Target,bool)>,
    active:Option<Active>,awaiting:Option<WaitingSlot>,busy_until:u64,next_id:u64,
    gsi:Option<(u64,Packet)>,predicted:Prediction,pub enabled:bool,pub voice_ready:bool,pub profile:Profile,
    notices:Vec<Notice>,
}
impl Engine {
    pub fn new(config:Config)->Self {
        let profile=config.timing_profile;
        Self{config,spells:spells(),waiting:VecDeque::new(),last_queued:None,active:None,awaiting:None,busy_until:0,next_id:0,gsi:None,predicted:Prediction::default(),enabled:true,voice_ready:false,profile,notices:Vec::new()}
    }
    pub fn set_ready(&mut self,ready:bool){self.voice_ready=ready;if !ready{self.discard();}}
    pub fn set_enabled(&mut self,enabled:bool){self.enabled=enabled;if !enabled{self.discard();}}
    fn discard(&mut self){self.waiting.clear();self.awaiting=None;}
    pub fn idle(&self)->bool{self.active.is_none()&&self.awaiting.is_none()&&self.waiting.is_empty()}
    pub fn discard_waiting(&mut self){self.waiting.clear();}
    pub fn replace_bindings(&mut self,config:&Config)->bool{
        if !self.idle(){return false;}
        self.config.keys=config.keys.clone();self.config.voice_chat_key=config.voice_chat_key.clone();self.config.slot_cast_modes=config.slot_cast_modes.clone();self.config.item_cast_modes=config.item_cast_modes.clone();true
    }
    pub fn notices(&mut self)->Vec<Notice>{std::mem::take(&mut self.notices)}
    pub fn accept_gsi(&mut self,now:u64,packet:Packet)->bool{
        if !packet.authenticated(&self.config){return false;}
        if self.predicted.after.is_some_and(|at|now>at){self.predicted=Prediction::default();}
        self.gsi=Some((now,packet));true
    }
    fn fresh_gsi(&self,now:u64)->Option<(u64,&Packet)>{
        self.gsi.as_ref().filter(|(at,p)|now.saturating_sub(*at)<5000&&!p.hero.name.is_empty()).map(|(at,p)|(*at,p))
    }
    pub fn enqueue(&mut self,now:u64,c:Command)->bool {
        if !self.enabled||!self.voice_ready||self.waiting.len()>=32||self.active.as_ref().is_some_and(|a|a.timed_out){return false;}
        if self.last_queued.as_ref().is_some_and(|(at,t,p)|*t==c.target&&*p==c.prepare_only&&now.saturating_sub(*at)<2500){return false;}
        self.last_queued=Some((now,c.target.clone(),c.prepare_only));self.waiting.push_back((now,c));true
    }
    fn find(&self,target:&Target)->Option<&Spell>{if let Target::Spell(id)=target{self.spells.iter().find(|s|&s.id==id)}else{None}}
    fn refuse(&mut self,reason:impl Into<String>){self.notices.push(Notice::Refused(reason.into()));}
    fn dispatch(&mut self,now:u64,command:Command,profile:Profile,action:Option<Action>,steps:Result<Vec<Step>,String>)->Option<Dispatch>{
        let steps=match steps{Ok(s)=>s,Err(e)=>{self.awaiting=None;self.refuse(e);return None;}};
        self.next_id=self.next_id.wrapping_add(1).max(1);
        let duration=steps.iter().map(|s|match *s{Step::Key(_,d)|Step::Down(_,d)|Step::Up(_,d)|Step::Click(d)=>d}).sum::<u64>();
        self.active=Some(Active{id:self.next_id,command:command.clone(),profile,action,deadline:now.saturating_add(5000).saturating_add(duration),timed_out:false});
        Some(Dispatch{id:self.next_id,command,profile,steps})
    }
    pub fn poll(&mut self,now:u64)->Option<Dispatch>{
        if self.active.as_ref().is_some_and(|a|now>=a.deadline&&!a.timed_out){
            if let Some(a)=self.active.as_mut(){a.timed_out=true;}
            self.discard();self.notices.push(Notice::Watchdog);
        }
        if !self.enabled||!self.voice_ready{self.discard();return None;}
        if self.active.is_some(){return None;}
        if let Some(wait)=self.awaiting.take(){
            let Some(spell)=self.find(&wait.command.target).cloned()else{self.refuse("Unknown spell");return None;};
            if wait.deadline.is_some_and(|d|now>=d){self.refuse("Ability did not appear in slot");}
            else if let Some((at,p))=self.fresh_gsi(now).filter(|(at,_)|*at>=wait.from){
                let _=at;
                if p.hero.name!="npc_dota_hero_invoker"||!p.hero.alive||(!wait.command.prepare_only&&spell.needs_scepter&&p.hero.aghanims_scepter==Some(false)){
                    self.refuse("Hero state changed after Invoke");
                }else if let Some(slot)=p.slots().iter().position(|v|*v==spell.base.as_deref().unwrap_or(&spell.id)){
                    if wait.command.prepare_only{
                        self.predicted=Prediction::default();self.busy_until=now.saturating_add(self.config.timing(wait.profile).chain);self.notices.push(Notice::Prepared{confirmed:true});
                    }else if p.ability(spell.base.as_deref().unwrap_or(&spell.id)).is_some_and(|a|a.cooldown.is_some_and(|v|v>0.0)||a.can_cast==Some(false)){
                        self.refuse("Ability unavailable after Invoke");
                    }else{
                        let action=if slot==0{Action::Slot1}else{Action::Slot2};let steps=sequence(&self.config,&spell,action,wait.profile);
                        return self.dispatch(now,wait.command,wait.profile,Some(action),steps);
                    }
                }else{self.awaiting=Some(wait);return None;}
            }else{self.awaiting=Some(wait);return None;}
        }
        if now<self.busy_until{return None;}
        while let Some((queued_at,command))=self.waiting.pop_front(){
            if now.saturating_sub(queued_at)>3000{self.refuse("Queue TTL expired");continue;}
            let profile=self.profile;
            match &command.target{
                Target::Item(slot)=>{
                    let result=self.fresh_gsi(now).ok_or("Item requires fresh GSI").and_then(|(_,p)|p.item_mode(*slot,&self.config,true,command.prepare_only));
                    match result{
                        Ok(mode)=>{let steps=item_sequence(&self.config,*slot,mode,profile);return self.dispatch(now,command,profile,None,steps);},
                        Err(e)=>self.refuse(e),
                    }
                },
                Target::Spell(_)=>{
                    let Some(spell)=self.find(&command.target).cloned()else{self.refuse("Unknown spell");continue;};
                    let base=spell.base.as_deref().unwrap_or(&spell.id);
                    if !command.prepare_only&&self.predicted.used.contains(base){self.refuse("Ability awaiting next GSI update");continue;}
                    let fresh=self.fresh_gsi(now);
                    let plan=if let Some((_,packet))=fresh{packet.plan(&spell,command.prepare_only,true)}else{Plan::Cast(if command.prepare_only{Action::Prepare}else{Action::Invoke})};
                    match plan {
                        Plan::Refuse(e)=>self.refuse(e),
                        Plan::Prepared=>self.notices.push(Notice::Prepared{confirmed:true}),
                        Plan::Wait=>{self.waiting.push_front((queued_at,command));return None;},
                        Plan::Cast(action)=>{
                            if action==Action::Prepare{
                                self.awaiting=Some(WaitingSlot{command:command.clone(),profile,from:now,deadline:None,unconfirmed:fresh.is_none()});
                            }
                            let steps=sequence(&self.config,&spell,action,profile);
                            return self.dispatch(now,command,profile,Some(action),steps);
                        }
                    }
                }
            }
        }
        None
    }
    pub fn acknowledge(&mut self,id:u64,ok:bool,now:u64)->bool{
        if self.active.as_ref().map(|a|a.id)!=Some(id){return false;}
        let active=self.active.take().expect("checked active");
        if !ok||active.timed_out{
            self.discard();self.predicted=Prediction::default();self.busy_until=0;self.notices.push(Notice::InputFailed);return true;
        }
        if !self.enabled||!self.voice_ready{self.discard();return true;}
        if active.action==Some(Action::Prepare){
            if let Some(wait)=self.awaiting.as_mut(){
                if wait.unconfirmed{
                    self.awaiting=None;self.busy_until=now.saturating_add(self.config.timing(active.profile).chain);self.notices.push(Notice::Prepared{confirmed:false});
                }else{wait.deadline=Some(now.saturating_add(self.config.slot_wait_ms.min(10000)));}
            }
        }else{
            self.busy_until=now.saturating_add(self.config.timing(active.profile).chain);
            if let Some(spell)=self.find(&active.command.target){
                let id=spell.base.as_deref().unwrap_or(&spell.id).to_owned();
                if self.gsi.is_some(){self.predicted.used.insert(id);self.predicted.after=Some(self.busy_until);}
            }
            self.notices.push(Notice::Completed);
        }
        true
    }
}
