//! Native input adapter with focus checks, acknowledgement and release on cancellation.
use crate::{engine::Dispatch,input::Step,win_input::{focused,OWN_TAG}};
use std::{collections::BTreeSet,io,mem::size_of};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{SendInput,INPUT,INPUT_0,INPUT_KEYBOARD,INPUT_MOUSE,KEYBDINPUT,MOUSEINPUT,KEYEVENTF_KEYUP,KEYEVENTF_EXTENDEDKEY,MOUSEEVENTF_LEFTDOWN,MOUSEEVENTF_LEFTUP,MOUSEEVENTF_MIDDLEDOWN,MOUSEEVENTF_MIDDLEUP,MOUSEEVENTF_XDOWN,MOUSEEVENTF_XUP};

fn event(vk:u16,down:bool)->INPUT{
    let mouse=match vk{
        1=>Some((if down{MOUSEEVENTF_LEFTDOWN}else{MOUSEEVENTF_LEFTUP},0)),
        4=>Some((if down{MOUSEEVENTF_MIDDLEDOWN}else{MOUSEEVENTF_MIDDLEUP},0)),
        5|6=>Some((if down{MOUSEEVENTF_XDOWN}else{MOUSEEVENTF_XUP},u32::from(vk-4))),
        _=>None,
    };
    if let Some((flags,data))=mouse{
        INPUT{r#type:INPUT_MOUSE,Anonymous:INPUT_0{mi:MOUSEINPUT{dx:0,dy:0,mouseData:data,dwFlags:flags,time:0,dwExtraInfo:OWN_TAG}}}
    }else{
        let extended=matches!(vk,0x21..=0x28|0x2d|0x2e|0x6f|0xa3|0xa5);
        let flags=if down{0}else{KEYEVENTF_KEYUP}|if extended{KEYEVENTF_EXTENDEDKEY}else{0};
        INPUT{r#type:INPUT_KEYBOARD,Anonymous:INPUT_0{ki:KEYBDINPUT{wVk:vk,wScan:0,dwFlags:flags,time:0,dwExtraInfo:OWN_TAG}}}
    }
}
fn send(vk:u16,down:bool)->io::Result<()>{
    let input=event(vk,down);
    // SAFETY: one fully initialized INPUT, correct ABI size, no borrowed pointers.
    if unsafe{SendInput(1,&input,size_of::<INPUT>() as i32)}==1{Ok(())}else{Err(io::Error::last_os_error())}
}
pub struct Execution {
    dispatch:Dispatch,
    index:usize,
    deadline:u64,
    held:BTreeSet<u16>,
    live:bool,
}
fn wait(s:Step)->u64{match s{Step::Key(_,d)|Step::Down(_,d)|Step::Up(_,d)|Step::Click(d)=>d}}
impl Execution{
    pub fn new(dispatch:Dispatch,now:u64,live:bool)->Self{
        let deadline=now.saturating_add(dispatch.steps.first().copied().map(wait).unwrap_or(0));
        Self{dispatch,index:0,deadline,held:BTreeSet::new(),live}
    }
    pub fn id(&self)->u64{self.dispatch.id}
    fn set(&mut self,vk:u16,down:bool)->io::Result<()>{
        if self.live{send(vk,down)?;}
        if down{self.held.insert(vk);}else{self.held.remove(&vk);}
        Ok(())
    }
    pub fn tick(&mut self,now:u64,title:&str,allowed:bool)->Option<bool>{
        if !allowed||(self.live&&!focused(title)){return Some(false);}
        if now<self.deadline{return None;}
        while let Some(step)=self.dispatch.steps.get(self.index).copied(){
            let result=match step{
                Step::Key(vk,_)=>self.set(vk,true).and_then(|_|self.set(vk,false)),
                Step::Click(_)=>self.set(1,true).and_then(|_|self.set(1,false)),
                Step::Down(vk,_)=>self.set(vk,true),
                Step::Up(vk,_)=>self.set(vk,false),
            };
            if result.is_err(){return Some(false);}
            self.index+=1;
            if let Some(next)=self.dispatch.steps.get(self.index).copied(){
                let delay=wait(next);self.deadline=now.saturating_add(delay);
                if delay>0{return None;}
                if self.live&&!focused(title){return Some(false);}
            }
        }
        Some(self.held.is_empty())
    }
}
impl Drop for Execution{
    fn drop(&mut self){if self.live{for vk in &self.held{let _=send(*vk,false);}}}
}
#[cfg(test)]
mod tests{
    use super::*;
    use crate::{catalog,config::{Config,Profile},engine::Engine,recognition::Parser};
    #[test]
    fn dry_execution_obeys_waits_and_cancels(){
        let c=Config::default();let p=Parser::new(&catalog::resolve(&c,None));let mut e=Engine::new(c);e.set_ready(true);
        e.profile=Profile::Normal;e.enqueue(1,p.parse("торнадо").remove(0));let d=e.poll(1).unwrap();
        let mut x=Execution::new(d,1,false);assert_eq!(x.tick(1,"",true),None);assert_eq!(x.tick(2,"",false),Some(false));
    }
}
