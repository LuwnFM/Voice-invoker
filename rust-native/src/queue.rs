// Deterministic acknowledgement gate. No OS input is sent by this module.
use crate::{config::Profile,recognition::Command};
use std::collections::VecDeque;
#[derive(Debug,Clone)]
pub struct Request {pub id:u64,pub command:Command,pub profile:Profile}
#[derive(Debug,Default)]
pub struct Queue{
    waiting:VecDeque<(u64,Command)>,active:Option<Request>,next_id:u64,busy_until:u64,
}
impl Queue {
    pub fn push(&mut self,now:u64,c:Command)->bool{
        if self.waiting.len()>=64{return false;}
        self.waiting.push_back((now,c));true
    }
    pub fn next(&mut self,now:u64,profile:Profile)->Option<Request>{
        if self.active.is_some()||now<self.busy_until{return None;}
        while let Some((at,command))=self.waiting.pop_front(){
            if now.saturating_sub(at)>3000{continue;}
            self.next_id=self.next_id.wrapping_add(1).max(1);
            let req=Request{id:self.next_id,command,profile};self.active=Some(req.clone());return Some(req);
        }
        None
    }
    pub fn ack(&mut self,id:u64,ok:bool,now:u64,chain_gap:u64)->bool{
        if self.active.as_ref().map(|r|r.id)!=Some(id){return false;}
        self.active=None;self.busy_until=now.saturating_add(chain_gap);
        if !ok{self.waiting.clear();}
        true
    }
    pub fn discard_waiting(&mut self){self.waiting.clear();}
}
