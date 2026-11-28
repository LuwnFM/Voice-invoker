//! Experimental unified Windows session. Dry run by default; live mode explicit.
use crate::{catalog,config::Config,capture::Capture,gsi_server::Server,recognition::Parser,model,vosk::Vosk,runtime::Runtime,win_input::{Hook,focused},win_execute::Execution,input::Event};
use std::{path::Path,sync::{Arc,atomic::{AtomicBool,Ordering}},time::{Duration,Instant}};
pub fn run(dll:&Path,model_path:&Path,mut config:Config,config_path:&Path,live:bool,seconds:u64,verified:bool)->Result<bool,Box<dyn std::error::Error>>{
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
    let mut ui_state=None;
    let native_store=crate::storage::native_directory().ok().and_then(|dir|crate::storage::Store::open(&dir).ok()).filter(|store|store.path().canonicalize().ok().zip(config_path.canonicalize().ok()).is_some_and(|(a,b)|a==b));
    let server=Server::start_with_ui(&config,|gsi|{let ui=crate::ui::Ui::new(&config,native_store.clone(),words,crate::capture::devices(),verified,gsi);ui_state=Some(ui.clone());crate::ui::router(ui)})?;
    let ui=ui_state.ok_or("UI startup failed")?;
    let shell=crate::shell::Shell::start(ui.clone(),config.window_title.clone(),true,true)?;
    let arm=Arc::new(AtomicBool::new(false));
    let hook=Hook::start_session(config.clone(),live,arm.clone())?;
    let mut always=config.listen=="always"||config.voice_chat_key.is_empty()||config.test_only;

    let mut runtime=Runtime::new(config.clone(),parser,capture.rate);
    let mut active:Option<Execution>=None;let mut last_packet=None;
    let watcher=crate::steam::automatic_steam().and_then(|(path,id)|crate::steam::inspect(&path,id).binding_file).and_then(|path|crate::binding_watch::BindingWatch::new(&path).ok());
    ui.set_discovery(crate::steam::diagnostic(&config));
    let mut refresh_at=watcher.as_ref().map(|_|0u64);let mut pending=None;
    let mut require_release=false;
    let mut allowed_before=false;let start=Instant::now();let mut last_meter=0u64;let mut profile=config.timing_profile;let mut restart=false;
    println!("Native session: {} Hz; GSI {}; input {}",capture.rate,server.address,if live{"LIVE"}else{"DRY RUN"});
    capture.start()?;
    while start.elapsed()<Duration::from_secs(seconds){
        let now=start.elapsed().as_millis() as u64;
        if capture.failure.load(Ordering::Acquire)||hook.overflow.load(Ordering::Acquire)||!hook.running()||!server.running(){
            arm.store(false,Ordering::Release);runtime.ready(false,now);return Err("Capture, hook or GSI worker failed".into());
        }
        let mut quit=false;let mut shell_restart=false;
        while let Ok(event)=shell.events.try_recv(){match event{
            crate::shell::ShellEvent::Quit=>quit=true,
            crate::shell::ShellEvent::Restart=>shell_restart=true,
            crate::shell::ShellEvent::Toggle=>hook.toggle()?,
            crate::shell::ShellEvent::Settings=>{ui.set_discovery(crate::steam::diagnostic(&config));let _=std::process::Command::new("explorer.exe").arg(format!("http://127.0.0.1:{}/settings",server.address.port())).spawn();},
        }}
        while let Ok(event)=hook.events.try_recv(){match event{
            Event::Quit=>quit=true,
            Event::Toggle=>{require_release=true;},
            Event::Profile(next)=>{profile=next;runtime.profile(next);},
            Event::Listen(_)=>{},
            Event::Settings=>{ui.set_discovery(crate::steam::diagnostic(&config));let _=std::process::Command::new("explorer.exe").arg(format!("http://127.0.0.1:{}/settings",server.address.port())).spawn();},
            Event::Blocked=>{ui.notice("blocked",None,None);},
        }}
        if quit||shell_restart||ui.restart_requested(){restart=!quit;break;}
        if let Some((at,p))=server.state.snapshot(){
            if last_packet!=Some(at){last_packet=Some(at);let received=now.saturating_sub(at.elapsed().as_millis() as u64);runtime.gsi(received,p);}
        }
        if let Some(w)=&watcher{
            if w.poll_event()?{refresh_at=Some(now.saturating_add(350));pending=None;runtime.discard_waiting();}
            if refresh_at.is_some_and(|at|now>=at){
                refresh_at=None;
                match w.read(&config){
                    Ok(next) if config.auto_sync_bindings&&ui.can_sync()&&(next.keys!=config.keys||next.voice_chat_key!=config.voice_chat_key||next.slot_cast_modes!=config.slot_cast_modes)=>{pending=Some(next);runtime.discard_waiting();},
                    Ok(_)=>{},Err(e)=>eprintln!("Bindings unchanged: {e}"),
                }
            }
        }
        ui.binding_status(pending.is_some()||refresh_at.is_some(),watcher.is_some());
        if active.is_none()&&runtime.idle(){if let Some(next)=pending.take().filter(|_|ui.can_sync()){
            arm.store(false,Ordering::Release);hook.update(next.clone())?;runtime.replace_bindings(&next,now);vosk.reset();require_release=true;config=next;
            // During migration only the isolated native store is eligible for automatic writes.
            always=config.listen=="always"||config.voice_chat_key.is_empty()||config.test_only;
            if let Err(e)=ui.bindings(&config){eprintln!("Bindings active but not saved: {e}");}
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
            if !pre.is_empty(){let (finalized,text)=vosk.feed(&pre)?;let commands=runtime.observe(now,&text,finalized);ui.speech(&text,&commands,finalized);}
        }else if !want&&runtime.listening(){
            if pending.is_some()||refresh_at.is_some(){runtime.abort_speech(now);vosk.reset();}else{let text=vosk.finish()?;let commands=runtime.observe(now,&text,true);ui.speech(&text,&commands,true);runtime.end(now);vosk.reset();}
        }
        // Drain a small bounded batch so input scheduling cannot starve.
        for _ in 0..4{
            let Ok(pcm)=capture.blocks.try_recv()else{break;};
            if now.saturating_sub(last_meter)>=60{last_meter=now;let sum=pcm.iter().map(|&s|(f64::from(s)/32768.0).powi(2)).sum::<f64>();ui.meter((sum/pcm.len().max(1) as f64).sqrt()*400.0);}
            if runtime.listening(){let (finalized,text)=vosk.feed(&pcm)?;let commands=runtime.observe(now,&text,finalized);ui.speech(&text,&commands,finalized);}
            else if allowed&&pending.is_none()&&refresh_at.is_none(){runtime.idle_audio(&pcm);}
        }
        if let Some(x)=active.as_mut(){
            if let Some(ok)=x.tick(now,&config.window_title,allowed){
                let id=x.id();active=None;runtime.ack(id,ok,now);
            }
        }
        if active.is_none()&&allowed{
            if let Some(d)=runtime.poll(now){
                println!("{}: {:?} {:?}",if live{"cast"}else{"plan"},d.command,d.steps);
                if let crate::catalog::Target::Spell(id)=&d.command.target{if let Some(s)=catalog::spells().into_iter().find(|s|&s.id==id){ui.notice(if d.command.prepare_only{"prepared"}else{"cast"},Some(serde_json::json!({"id":s.id,"name":s.name,"base":s.base})),None);}}
                active=Some(Execution::new(d,now,live));
            }
        }
        ui.update(true,enabled,runtime.listening(),profile);
        for notice in runtime.notices(){if let crate::engine::Notice::Refused(reason)=&notice{ui.notice("refuse",None,Some(reason));}println!("{notice:?}");}
        std::thread::sleep(Duration::from_millis(2));
    }
    arm.store(false,Ordering::Release);drop(active);runtime.ready(false,start.elapsed().as_millis() as u64);hook.stop()?;shell.stop()?;drop(server);drop(capture);
    Ok(restart)
}
