//! Shared runtime orchestration. The dry-run and native adapters share this state.
use crate::{config::Config,engine::{Engine,Dispatch,Notice},gsi::Packet,recognition::Parser,speech::SpeechSession};
use std::collections::VecDeque;
pub struct Runtime {
    engine: Engine,
    parser: Parser,
    speech: SpeechSession,
    preroll: VecDeque<i16>,
    preroll_limit: usize,
    listening: bool,
}
impl Runtime {
    pub fn new(config:Config,parser:Parser,rate:u32)->Self{
        Self{engine:Engine::new(config),parser,speech:SpeechSession::default(),preroll:VecDeque::new(),preroll_limit:(rate as usize)/4,listening:false}
    }
    pub fn ready(&mut self,ready:bool,now:u64){
        self.engine.set_ready(ready);
        if !ready{self.listening=false;self.preroll.clear();self.speech.reset(now);}
    }
    pub fn enabled(&mut self,enabled:bool,now:u64){
        self.engine.set_enabled(enabled);
        if !enabled{self.listening=false;self.preroll.clear();self.speech.reset(now);}
    }
    pub fn profile(&mut self,profile:crate::config::Profile){self.engine.profile=profile;}
    pub fn gsi(&mut self,now:u64,p:Packet)->bool{self.engine.accept_gsi(now,p)}
    pub fn idle_audio(&mut self,pcm:&[i16]){
        for &sample in pcm {
            self.preroll.push_back(sample);
            if self.preroll.len()>self.preroll_limit{self.preroll.pop_front();}
        }
    }
    pub fn begin(&mut self,now:u64)->Vec<i16>{
        self.speech.reset(now);self.listening=true;self.preroll.drain(..).collect()
    }
    pub fn observe(&mut self,now:u64,text:&str,finalized:bool){
        if !self.listening{return;}
        for command in self.speech.observe(&self.parser,now,text,finalized){self.engine.enqueue(now,command);}
    }
    pub fn end(&mut self,now:u64){
        if self.listening{for command in self.speech.end(&self.parser,now){self.engine.enqueue(now,command);}}
        self.listening=false;
    }
    pub fn listening(&self)->bool{self.listening}
    pub fn poll(&mut self,now:u64)->Option<Dispatch>{self.engine.poll(now)}
    pub fn ack(&mut self,id:u64,ok:bool,now:u64)->bool{self.engine.acknowledge(id,ok,now)}
    pub fn notices(&mut self)->Vec<Notice>{self.engine.notices()}
}
#[cfg(test)]
mod tests{
    use super::*;
    use crate::{catalog,recognition::Parser};
    #[test]
    fn pre_roll_and_cancelled_hypothesis(){
        let c=Config::default();let p=Parser::new(&catalog::resolve(&c,None));let mut r=Runtime::new(c,p,16000);
        r.ready(true,0);r.idle_audio(&vec![1;4500]);assert_eq!(r.begin(1).len(),4000);
        r.observe(2,"готовь торнадо",false);r.ready(false,3);r.end(4);assert!(r.poll(5).is_none());
        r.ready(true,6);assert!(r.begin(7).is_empty());r.observe(8,"торнадо",true);assert!(r.poll(8).is_some());
    }
    #[test]
    fn release_finalization_is_not_a_second_cast(){
        let c=Config::default();let p=Parser::new(&catalog::resolve(&c,None));let mut r=Runtime::new(c,p,16000);
        r.ready(true,0);r.begin(0);r.observe(1,"торнадо",false);r.observe(2,"торнадо",true);r.end(3);
        let d=r.poll(4).unwrap();assert!(r.ack(d.id,true,5));assert!(r.poll(100).is_none());
    }
}
