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
    let noise=config.other.get("noiseSuppression").and_then(|v|v.as_bool()).unwrap_or(false);
    let mut ui_state=None;
    let native_store=crate::storage::native_directory().ok().and_then(|dir|crate::storage::Store::open(&dir).ok()).filter(|store|store.path().canonicalize().ok().zip(config_path.canonicalize().ok()).is_some_and(|(a,b)|a==b));
    let log=crate::log::SessionLog::new(native_store.as_ref().map(|s|s.directory()));
    log.write("Starting native session");
    let server=Server::start_with_ui(&config,|gsi|{let ui=crate::ui::Ui::new(&config,native_store.clone(),words,crate::capture::devices(),verified,gsi);ui_state=Some(ui.clone());crate::ui::router(ui)})?;
    let ui=ui_state.ok_or("UI startup failed")?;ui.set_dry_run(!live);
    let shell=crate::shell::Shell::start(ui.clone(),config.window_title.clone(),true,true)?;
    let mut settings_child=crate::settings_window::SettingsChild::default();
    let capture=match Capture::open(Some(&config.microphone),requested,block,noise){Ok(c)=>c,Err(e)=>{log.write(&format!("Audio startup: {e}"));return recovery(&config,&ui,&shell,&mut settings_child,server.address.port(),seconds,&e.to_string());}};
    let mut vosk=match Vosk::new(dll,model_path,capture.rate,&parser.grammar()){Ok(v)=>v,Err(e)=>{log.write(&format!("Vosk startup: {e}"));return recovery(&config,&ui,&shell,&mut settings_child,server.address.port(),seconds,&e.to_string());}};
    let arm=Arc::new(AtomicBool::new(false));
    let hook=Hook::start_session(config.clone(),live,arm.clone())?;
    let mut always=!live||config.listen=="always"||config.voice_chat_key.is_empty()||config.test_only;

    let mut runtime=Runtime::new(config.clone(),parser,capture.rate);
    let mut active:Option<Execution>=None;let mut last_packet=None;
    let watcher=crate::steam::automatic_steam().and_then(|(path,id)|crate::steam::inspect(&path,id).binding_file).and_then(|path|crate::binding_watch::BindingWatch::new(&path).ok());
    let discovery=crate::steam::diagnostic(&config);
    let startup_issue=live&&verified&&["dotaFound","gsiInstalled","gsiConfigMatches"].iter().any(|key|discovery.get(*key).and_then(|v|v.as_bool())!=Some(true));
    ui.set_discovery(discovery);ui.set_audio(capture.device_rate,capture.rate);
    if startup_issue{log.write("Startup: Dota or GSI setup needs attention");let _=settings_child.open(server.address.port());}
    let mut refresh_at=watcher.as_ref().map(|_|0u64);let mut pending=None;
    let mut require_release=false;
    let mut allowed_before=false;let start=Instant::now();let mut last_meter=0u64;let mut profile=config.timing_profile;let mut restart=false;
    println!("Native session: device {} Hz, recognizer {} Hz; GSI {}; input {}",capture.device_rate,capture.rate,server.address,if live{"LIVE"}else{"DRY RUN"});
    if let Err(e)=capture.start(){log.write(&format!("Capture start: {e}"));arm.store(false,Ordering::Release);hook.stop()?;drop(capture);return recovery(&config,&ui,&shell,&mut settings_child,server.address.port(),seconds,&e.to_string());}
    ui.set_hook_ready(true);
    log.write(&format!("Ready: device {} Hz, Vosk {} Hz, RNNoise {}, live {}",capture.device_rate,capture.rate,noise,live));
    while start.elapsed()<Duration::from_secs(seconds){
        let now=start.elapsed().as_millis() as u64;
        if !server.running(){log.write("GSI server failed");arm.store(false,Ordering::Release);runtime.ready(false,now);return Err("GSI worker failed".into());}
        if capture.failure.load(Ordering::Acquire)||hook.overflow.load(Ordering::Acquire)||!hook.running(){
            log.write("Audio/hook worker disconnected; input stopped");arm.store(false,Ordering::Release);drop(active.take());runtime.ready(false,now);let _=hook.stop();drop(capture);return recovery(&config,&ui,&shell,&mut settings_child,server.address.port(),seconds,"Микрофон или хук отключён. Проверь устройство и перезапусти приложение.");
        }
        let mut quit=false;let mut shell_restart=false;
        while let Ok(event)=shell.events.try_recv(){match event{
            crate::shell::ShellEvent::Quit=>quit=true,
            crate::shell::ShellEvent::Restart=>shell_restart=true,
            crate::shell::ShellEvent::Toggle=>hook.toggle()?,
            crate::shell::ShellEvent::Settings=>{ui.set_discovery(crate::steam::diagnostic(&config));if let Err(e)=settings_child.open(server.address.port()){eprintln!("Settings: {e}");}},
        }}
        while let Ok(event)=hook.events.try_recv(){match event{
            Event::Quit=>quit=true,
            Event::Toggle=>{require_release=true;},
            Event::Profile(next)=>{profile=next;runtime.profile(next);},
            Event::Listen(_)=>{},
            Event::Settings=>{ui.set_discovery(crate::steam::diagnostic(&config));if let Err(e)=settings_child.open(server.address.port()){eprintln!("Settings: {e}");}},
            Event::Blocked=>{ui.notice("blocked",None,None);},
        }}
        if quit||shell_restart||ui.restart_requested(){restart=!quit;break;}
        if let Some((at,p))=server.state.snapshot_if_new(last_packet){last_packet=Some(at);let received=now.saturating_sub(at.elapsed().as_millis() as u64);runtime.gsi(received,p);}
        if let Some(w)=&watcher{
            if w.poll_event()?{refresh_at=Some(now.saturating_add(350));pending=None;runtime.discard_waiting();}
            if refresh_at.is_some_and(|at|now>=at){
                refresh_at=None;
                match w.read(&config){
                    Ok(next) if config.auto_sync_bindings&&ui.can_sync()&&(next.keys!=config.keys||next.voice_chat_key!=config.voice_chat_key||next.slot_cast_modes!=config.slot_cast_modes)=>{pending=Some(next);runtime.discard_waiting();},
                    Ok(_)=>{},Err(e)=>{log.write(&format!("Bindings unchanged: {e}"));eprintln!("Bindings unchanged: {e}");},
                }
            }
        }
        ui.binding_status(pending.is_some()||refresh_at.is_some(),watcher.is_some());
        if active.is_none()&&runtime.idle(){if let Some(next)=pending.take().filter(|_|ui.can_sync()){
            arm.store(false,Ordering::Release);hook.update(next.clone())?;runtime.replace_bindings(&next,now);vosk.reset();require_release=true;config=next;
            // During migration only the isolated native store is eligible for automatic writes.
            always=!live||config.listen=="always"||config.voice_chat_key.is_empty()||config.test_only;
            if let Err(e)=ui.bindings(&config){eprintln!("Bindings active but not saved: {e}");}
            log.write("Bindings updated without restart");println!("Bindings updated without restart");
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
        for notice in runtime.notices(){if let crate::engine::Notice::Refused(reason)=&notice{ui.notice("refuse",None,Some(reason));}log.write(&format!("{notice:?}"));println!("{notice:?}");}
        std::thread::sleep(Duration::from_millis(if active.is_some(){2}else if runtime.listening(){4}else{10}));
    }
    arm.store(false,Ordering::Release);drop(active);runtime.ready(false,start.elapsed().as_millis() as u64);hook.stop()?;shell.stop()?;drop(settings_child);drop(server);drop(capture);
    log.write(if restart{"Restart requested"}else{"Session stopped"});
    Ok(restart)
}

/// Keep the configuration and diagnostic window available when audio cannot start.
/// No hook or executor is owned by this recovery path.
fn recovery(config:&Config,ui:&crate::ui::Ui,shell:&crate::shell::Shell,settings:&mut crate::settings_window::SettingsChild,port:u16,seconds:u64,error:&str)->Result<bool,Box<dyn std::error::Error>>{
    ui.set_discovery(crate::steam::diagnostic(config));ui.set_hook_ready(false);ui.set_voice_error(error);
    ui.update(false,false,false,config.timing_profile);
    eprintln!("Recovery: {error}");
    settings.open(port)?;
    let start=Instant::now();
    while start.elapsed()<Duration::from_secs(seconds){
        if ui.restart_requested(){return Ok(true);}
        match shell.events.recv_timeout(Duration::from_millis(100)){
            Ok(crate::shell::ShellEvent::Quit)=>return Ok(false),
            Ok(crate::shell::ShellEvent::Restart)=>return Ok(true),
            Ok(crate::shell::ShellEvent::Settings)=>settings.open(port)?,
            Ok(crate::shell::ShellEvent::Toggle)|Err(std::sync::mpsc::RecvTimeoutError::Timeout)=>{},
            Err(_)=>return Err("Diagnostic tray closed".into()),
        }
    }
    Ok(false)
}
