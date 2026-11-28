//! Experimental unified Windows session. Dry run by default; live mode explicit.
use crate::{catalog,config::Config,capture::Capture,gsi_server::Server,recognition::Parser,model,vosk::Vosk,runtime::Runtime,win_input::{Hook,focused},win_execute::Execution,input::Event};
use std::{path::Path,sync::{Arc,atomic::{AtomicBool,Ordering}},time::{Duration,Instant}};
pub fn run(dll:&Path,model_path:&Path,mut config:Config,live:bool,seconds:u64)->Result<(),Box<dyn std::error::Error>>{
    if !(1..=86400).contains(&seconds){return Err("Session seconds must be 1..86400".into());}
    let live=live&&!config.test_only;
    let words=model::read_words(model_path)?;
    let cat=catalog::resolve(&config,Some(&words));
    if !cat.errors.is_empty(){return Err(cat.errors.join("; ").into());}
    let parser=Parser::new(&cat);
    let requested=config.other.get("audioRate").and_then(|v|v.as_u64()).and_then(|v|u32::try_from(v).ok()).filter(|v|matches!(v,16000|48000));
    let block=config.other.get("audioBlock").and_then(|v|v.as_u64()).and_then(|v|usize::try_from(v).ok()).unwrap_or(512);
    let capture=Capture::open(Some(&config.microphone),requested,block)?;
    let mut vosk=Vosk::new(dll,model_path,capture.rate,&parser.grammar())?;
    let server=Server::start(&config)?;
    let arm=Arc::new(AtomicBool::new(false));
    let hook=Hook::start_session(config.clone(),live,arm.clone())?;
    let always=config.listen=="always"||config.voice_chat_key.is_empty()||config.test_only;
    let mut runtime=Runtime::new(config.clone(),parser,capture.rate);
    let mut active:Option<Execution>=None;let mut last_packet=None;
    let watcher=crate::steam::automatic_steam().and_then(|(path,id)|crate::steam::inspect(&path,id).binding_file).and_then(|path|crate::binding_watch::BindingWatch::new(&path).ok());
    let mut refresh_at=watcher.as_ref().map(|_|0u64);let mut pending=None;
    let mut require_release=false;
    let mut allowed_before=false;let start=Instant::now();
    println!("Native session: {} Hz; GSI {}; input {}",capture.rate,server.address,if live{"LIVE"}else{"DRY RUN"});
    capture.start()?;
    while start.elapsed()<Duration::from_secs(seconds){
        let now=start.elapsed().as_millis() as u64;
        if capture.failure.load(Ordering::Acquire)||hook.overflow.load(Ordering::Acquire)||!hook.running()||!server.running(){
            arm.store(false,Ordering::Release);runtime.ready(false,now);return Err("Capture, hook or GSI worker failed".into());
        }
        let mut quit=false;
        while let Ok(event)=hook.events.try_recv(){match event{
            Event::Quit=>quit=true,
            Event::Toggle=>{require_release=true;},
            Event::Profile(profile)=>{runtime.profile(profile);},
            Event::Listen(_)=>{},
            Event::Settings=>println!("Settings hotkey: native settings window not yet connected"),
            Event::Blocked=>{},
        }}
        if quit{break;}
        if let Some((at,p))=server.state.snapshot(){
            if last_packet!=Some(at){last_packet=Some(at);let received=now.saturating_sub(at.elapsed().as_millis() as u64);runtime.gsi(received,p);}
        }
        if let Some(w)=&watcher{
            if w.poll_event()?{refresh_at=Some(now.saturating_add(350));pending=None;runtime.discard_waiting();}
            if refresh_at.is_some_and(|at|now>=at){
                refresh_at=None;
                match w.read(&config){
                    Ok(next) if config.auto_sync_bindings&&(next.keys!=config.keys||next.voice_chat_key!=config.voice_chat_key||next.slot_cast_modes!=config.slot_cast_modes)=>{pending=Some(next);runtime.discard_waiting();},
                    Ok(_)=>{},Err(e)=>eprintln!("Bindings unchanged: {e}"),
                }
            }
        }
        if active.is_none()&&runtime.idle(){if let Some(next)=pending.take(){
            arm.store(false,Ordering::Release);hook.update(next.clone())?;runtime.replace_bindings(&next,now);vosk.reset();require_release=true;config=next;
            // During migration only the isolated native store is eligible for automatic writes.
            if let Ok(dir)=crate::storage::native_directory(){if let Ok(store)=crate::storage::Store::open(&dir){if store.path().is_file(){if let Err(e)=store.save(&config){eprintln!("Bindings active but not saved: {e}");}}}}
            println!("Bindings updated without restart");
        }}
        let (enabled,ptt,chat)=hook.snapshot();runtime.enabled(enabled,now);
        let game=focused(&config.window_title);
        let allowed=enabled&&!chat&&(game||(!live&&always));
        arm.store(live&&allowed&&pending.is_none()&&refresh_at.is_none(),Ordering::Release);
        if !ptt{require_release=false;}
        if !allowed{
            if allowed_before{runtime.ready(false,now);vosk.reset();require_release=true;}
            if let Some(x)=active.take(){runtime.ack(x.id(),false,now);}
        }else if !allowed_before{runtime.ready(true,now);}
        allowed_before=allowed;
        let want=allowed&&pending.is_none()&&refresh_at.is_none()&&(always||(ptt&&!require_release));
        if want&&!runtime.listening(){
            vosk.reset();let pre=runtime.begin(now);
            if !pre.is_empty(){let (finalized,text)=vosk.feed(&pre)?;runtime.observe(now,&text,finalized);}
        }else if !want&&runtime.listening(){
            if pending.is_some()||refresh_at.is_some(){runtime.ready(false,now);runtime.ready(allowed,now);vosk.reset();}else{let text=vosk.finish()?;runtime.observe(now,&text,true);runtime.end(now);vosk.reset();}
        }
        // Drain a small bounded batch so input scheduling cannot starve.
        for _ in 0..4{
            let Ok(pcm)=capture.blocks.try_recv()else{break;};
            if runtime.listening(){let (finalized,text)=vosk.feed(&pcm)?;runtime.observe(now,&text,finalized);}
            else if allowed{runtime.idle_audio(&pcm);}
        }
        if let Some(x)=active.as_mut(){
            if let Some(ok)=x.tick(now,&config.window_title,allowed){
                let id=x.id();active=None;runtime.ack(id,ok,now);
            }
        }
        if active.is_none()&&allowed{
            if let Some(d)=runtime.poll(now){
                println!("{}: {:?} {:?}",if live{"cast"}else{"plan"},d.command,d.steps);
                active=Some(Execution::new(d,now,live));
            }
        }
        for notice in runtime.notices(){println!("{notice:?}");}
        std::thread::sleep(Duration::from_millis(2));
    }
    arm.store(false,Ordering::Release);drop(active);runtime.ready(false,start.elapsed().as_millis() as u64);hook.stop()?;Ok(())
}
