//! Local settings and OBS interface. The browser never captures audio.
use crate::{catalog::{self,ITEM_KEYS},config::{Config,Profile},gsi_server::GsiState,recognition::Command,storage::Store};
use axum::{Router,Json,extract::{State,Query},http::{header,StatusCode},response::{Html,IntoResponse,sse::{Sse,Event,KeepAlive}},routing::{get,post}};
use serde_json::{json,Value};
use std::{collections::{BTreeSet,BTreeMap},convert::Infallible,path::PathBuf,sync::{Arc,Mutex},time::Duration};
use tokio::sync::broadcast;
use tokio_stream::{StreamExt,wrappers::BroadcastStream};

struct Data{
    config:Config,saved:Config,store:Option<Store>,words:BTreeSet<String>,devices:Vec<String>,
    generation:u64,binding_busy:bool,dirty:bool,restart:bool,ready:bool,enabled:bool,listening:bool,profile:Profile,
    level:f64,transcript:String,last_test:Value,model_verified:bool,watching:bool,diagnostic:Value,notice:Option<(std::time::Instant,String)>,
}
#[derive(Clone)]
pub struct Ui{data:Arc<Mutex<Data>>,gsi:GsiState,events:broadcast::Sender<Value>}
fn slots()->Vec<Value>{ITEM_KEYS.iter().enumerate().map(|(i,k)|json!({"id":format!("item_slot_{k}"),"key":k,"name":if i<6{format!("Предмет {}",i+1)}else if i==6{"Нейтральный предмет".into()}else{"Телепорт".into()}})).collect()}
fn state(d:&Data)->Value{json!({"enabled":d.enabled,"voiceReady":d.ready,"listening":d.listening,"timingProfile":d.profile,"testOnly":d.config.test_only,"talkKey":if d.config.listen=="always"{""}else{&d.config.voice_chat_key}})}
impl Ui{
    pub fn new(c:&Config,store:Option<Store>,words:BTreeSet<String>,devices:Vec<String>,model_verified:bool,gsi:GsiState)->Self{
        let (events,_)=broadcast::channel(128);
        Self{data:Arc::new(Mutex::new(Data{config:c.clone(),saved:c.clone(),store,words,devices,generation:0,binding_busy:false,dirty:false,restart:false,ready:false,enabled:true,listening:false,profile:c.timing_profile,level:0.0,transcript:String::new(),last_test:Value::Null,model_verified,watching:false,diagnostic:Value::Null,notice:None})),gsi,events}
    }
    pub fn snapshot(&self)->Value{
        let d=self.data.lock().unwrap_or_else(|e|e.into_inner());json!({"state":state(&d),"event":null,"level":d.level,"transcript":d.transcript})
    }
    pub fn update(&self,ready:bool,enabled:bool,listening:bool,profile:Profile){
        let mut d=self.data.lock().unwrap_or_else(|e|e.into_inner());
        if (d.ready,d.enabled,d.listening,d.profile)!=(ready,enabled,listening,profile){
            let event=if d.enabled!=enabled{"toggle"}else if d.profile!=profile{"profile"}else if d.listening!=listening&&listening{"listen"}else{"state"};
            d.ready=ready;d.enabled=enabled;d.listening=listening;d.profile=profile;
            let _=self.events.send(json!({"state":state(&d),"event":event,"level":d.level,"transcript":d.transcript}));
        }
    }
    pub fn meter(&self,level:f64){let mut d=self.data.lock().unwrap_or_else(|e|e.into_inner());d.level=level;let _=self.events.send(json!({"state":state(&d),"event":null,"level":level,"transcript":d.transcript}));}
    pub fn speech(&self,text:&str,commands:&[Command],finalized:bool){
        let mut d=self.data.lock().unwrap_or_else(|e|e.into_inner());
        if d.transcript==text&&!finalized&&commands.is_empty(){return;}
        d.transcript=text.to_owned();
        if finalized&&d.config.test_only&&!text.is_empty(){d.last_test=json!({"transcript":text,"matched":commands.iter().map(|c|c.phrase.clone()).collect::<Vec<_>>()});}
        let _=self.events.send(json!({"state":state(&d),"event":null,"level":d.level,"transcript":d.transcript}));
    }
    pub fn notice(&self,event:&str,spell:Option<Value>,reason:Option<&str>){
        let mut d=self.data.lock().unwrap_or_else(|e|e.into_inner());
        let name=spell.as_ref().and_then(|v|v.get("name")).and_then(Value::as_str).unwrap_or("");
        let text=match event{"cast"|"preview"|"item"=>name.to_owned(),"prepared"=>format!("Подготовлено: {name}"),"refuse"=>reason.unwrap_or("Каст отклонён").to_owned(),"blocked"=>"Только голосом!".into(),_=>String::new()};
        if !text.is_empty(){d.notice=Some((std::time::Instant::now(),text));}
        let _=self.events.send(json!({"state":state(&d),"event":event,"spell":spell,"reason":reason}));
    }
    pub fn overlay(&self)->(bool,bool,String,f64,Option<String>){let d=self.data.lock().unwrap_or_else(|e|e.into_inner());let notice=d.notice.as_ref().filter(|(at,_)|at.elapsed()<Duration::from_millis(1800)).map(|(_,text)|text.clone());(d.enabled,d.listening&&d.config.listen!="always",d.transcript.clone(),d.level,notice)}
    pub fn binding_status(&self,busy:bool,watching:bool){let mut d=self.data.lock().unwrap_or_else(|e|e.into_inner());d.binding_busy=busy;d.watching=watching;}
    pub fn can_sync(&self)->bool{!self.data.lock().unwrap_or_else(|e|e.into_inner()).dirty}
    pub fn bindings(&self,c:&Config)->Result<(),Box<dyn std::error::Error>>{
        let mut d=self.data.lock().unwrap_or_else(|e|e.into_inner());
        if d.dirty{return Err("Manual settings await restart".into());}
        d.config=c.clone();d.saved=c.clone();d.generation+=1;
        if let Some(store)=&d.store{store.save(c)?;}Ok(())
    }
    pub fn restart_requested(&self)->bool{self.data.lock().unwrap_or_else(|e|e.into_inner()).restart}
    pub fn diagnostics(&self)->Value{
        let d=self.data.lock().unwrap_or_else(|e|e.into_inner());let gsi=self.gsi.snapshot();
        let p=gsi.as_ref().map(|(_,p)|p);
        let items=p.map(|p|{let names=["slot0","slot1","slot2","slot3","slot4","slot5","neutral0","teleport0"];names.iter().map(|k|p.items.get(*k).map(|a|a.name.clone())).collect::<Vec<_>>()});
        let mut out=json!({"version":env!("CARGO_PKG_VERSION"),"runtime":"Rust / native Vosk","modelVerified":d.model_verified,"modelAvailable":true,"modelDictionaryReady":true,"voiceReady":d.ready,"voiceFailed":false,"hookReady":true,"hookFailed":false,"enabled":d.enabled,"profile":d.profile,"port":d.config.port,"serverReady":true,"testOnly":d.config.test_only,"activePhrases":catalog::resolve(&d.config,Some(&d.words)).active.len(),"experimentalActive":d.config.experimental_frames,"bindingGeneration":d.generation,"bindingsChanged":d.binding_busy,"bindingWatching":d.watching,"bindingWarningsCount":0,"bindingMatches":null,"dotaFound":false,"running":null,"launchFlag":null,"savedLaunchFlag":null,"gsiInstalled":false,"gsiConfigMatches":false,"itemsConfigured":false,"gsiRejected":false,"gsiAgeMs":gsi.as_ref().map(|(at,_)|at.elapsed().as_millis()),"hero":p.map(|p|p.hero.name.as_str()),"alive":p.map(|p|p.hero.alive),"slots":p.map(|p|p.slots()),"items":items,"lastTest":d.last_test,"level":d.level,"local":{"keys":d.config.keys,"voiceChatKey":d.config.voice_chat_key,"slotCastModes":d.config.slot_cast_modes,"voiceMessage":if d.ready{"Нативный Vosk / WASAPI готов"}else{"Ожидание микрофона"}}});
        if let (Some(a),Some(b))=(out.as_object_mut(),d.diagnostic.as_object()){for (k,v) in b{if k=="local"{if let (Some(local),Some(extra))=(a.get_mut("local").and_then(Value::as_object_mut),v.as_object()){local.extend(extra.clone());}}else{a.insert(k.clone(),v.clone());}}}
        out
    }
    pub fn set_audio(&self,device_rate:u32,rate:u32){let mut d=self.data.lock().unwrap_or_else(|e|e.into_inner());d.diagnostic["audioDeviceRate"]=json!(device_rate);d.diagnostic["audioRecognizerRate"]=json!(rate);}
    pub fn set_discovery(&self,value:Value){let mut d=self.data.lock().unwrap_or_else(|e|e.into_inner());if let (Some(a),Some(b))=(d.diagnostic.as_object_mut(),value.as_object()){a.extend(b.clone());}else{d.diagnostic=value;}}
}
async fn config(State(ui):State<Ui>)->Json<Value>{
    let d=ui.data.lock().unwrap_or_else(|e|e.into_inner());let c=&d.saved;
    let phrases:BTreeMap<_,_>=catalog::spells().into_iter().map(|s|(s.id,s.phrases)).collect();
    Json(json!({"keys":c.keys,"voiceChatKey":c.voice_chat_key,"castMode":c.cast_mode,"listen":c.listen,"blockKeys":c.block_keys,"microphone":c.microphone,"phraseCatalog":phrases,"customSpellPhrases":c.custom_spell_phrases,"disabledPhrases":c.disabled_phrases,"itemPhrases":c.item_phrases,"dictionaryReady":true,"itemSlots":slots(),"firstRun":false,"experimentalFrames":c.experimental_frames,"testOnly":c.test_only,"slotCastModes":c.slot_cast_modes,"itemCastModes":c.item_cast_modes,"autoSyncBindings":c.auto_sync_bindings,"syncQuickcast":c.sync_quickcast,"bindingNotifications":c.binding_notifications,"bindingGeneration":d.generation,"readOnly":d.store.is_none(),"audioRate":c.other.get("audioRate").and_then(Value::as_u64).unwrap_or(0),"audioBlock":c.other.get("audioBlock").and_then(Value::as_u64).unwrap_or(512)}))
}
fn patch(d:&mut Data,body:Value)->Result<(),Box<dyn std::error::Error>>{
    if d.binding_busy{return Err("Ожидается синхронизация клавиш".into());}
    let store=d.store.as_ref().ok_or("Внешние настройки только для чтения")?;
    let b=body.as_object().ok_or("Ожидается JSON object")?;
    if b.get("bindingGeneration").and_then(Value::as_u64)!=Some(d.generation){return Err("Клавиши изменились, обнови настройки".into());}
    let mut v=serde_json::to_value(&d.saved)?;
    for key in ["voiceChatKey","castMode","listen","blockKeys","microphone","customSpellPhrases","disabledPhrases","itemPhrases","experimentalFrames","testOnly","autoSyncBindings","syncQuickcast","bindingNotifications","itemCastModes","audioRate","audioBlock"]{
        if let Some(value)=b.get(key){v[key]=value.clone();}
    }
    if let Some(keys)=b.get("keys").and_then(Value::as_object){
        for (k,key) in keys{if ["quas","wex","exort","invoke","slot1","slot2"].contains(&k.as_str())||ITEM_KEYS.contains(&k.as_str()){v["keys"][k]=key.clone();}}
    }
    if let Some(modes)=b.get("slotCastModes").and_then(Value::as_object){
        v["slotCastModes"]=json!(modes.iter().filter(|(k,v)|(["slot1","slot2"].contains(&k.as_str())||ITEM_KEYS.contains(&k.as_str()))&&matches!(v.as_str(),Some("click"|"quickcast"))).collect::<BTreeMap<_,_>>());
    }
    let next=Config::from_json(&v.to_string())?;
    if next.block_keys.iter().any(|k|!["quas","wex","exort","invoke","slot1","slot2"].contains(&k.as_str())){return Err("Некорректная блокировка клавиши".into());}
    if next.other.get("audioRate").is_some_and(|v|!matches!(v.as_u64(),Some(0|16000|48000)))||next.other.get("audioBlock").is_some_and(|v|!matches!(v.as_u64(),Some(256|512|1024|2048))){return Err("Некорректная конфигурация аудио".into());}
    if !matches!(next.listen.as_str(),"hold"|"always")||next.microphone.len()>800||next.item_cast_modes.len()>200||next.item_cast_modes.keys().any(|k|!k.starts_with("item_")||k.len()>105||!k.bytes().all(|b|b.is_ascii_lowercase()||b.is_ascii_digit()||b==b'_')){return Err("Некорректные настройки".into());}
    if ["quas","wex","exort","invoke","slot1","slot2"].iter().any(|k|next.keys.get(*k).and_then(|v|crate::input::vk_of(v)).is_none()){return Err("Не назначена обязательная клавиша".into());}
    let resolved=catalog::resolve(&next,Some(&d.words));if !resolved.errors.is_empty(){return Err(resolved.errors.join("; ").into());}
    store.save(&next)?;d.saved=next;d.dirty=true;Ok(())
}
async fn save(State(ui):State<Ui>,Json(body):Json<Value>)->impl IntoResponse{
    let result=patch(&mut ui.data.lock().unwrap_or_else(|e|e.into_inner()),body);
    match result{Ok(())=>(StatusCode::OK,Json(json!({"ok":true}))),Err(e)=>(StatusCode::BAD_REQUEST,Json(json!({"ok":false,"error":e.to_string()})))}
}
async fn restart(State(ui):State<Ui>,Json(_):Json<Value>)->StatusCode{
    let mut d=ui.data.lock().unwrap_or_else(|e|e.into_inner());if d.store.is_none(){return StatusCode::FORBIDDEN;}d.restart=true;StatusCode::NO_CONTENT
}
async fn dictionary(State(ui):State<Ui>,Query(q):Query<BTreeMap<String,String>>)->Json<Value>{
    let d=ui.data.lock().unwrap_or_else(|e|e.into_inner());let q=q.get("q").map(|s|s.trim().to_lowercase().chars().take(100).collect::<String>()).unwrap_or_default();
    let matches:Vec<_>=if q.chars().count()>=2{d.words.iter().filter(|w|w.starts_with(&q)).take(30).collect()}else{Vec::new()};
    Json(json!({"ready":true,"exact":d.words.contains(&q),"matches":matches}))
}
async fn devices(State(ui):State<Ui>)->Json<Value>{let d=ui.data.lock().unwrap_or_else(|e|e.into_inner());Json(json!({"devices":d.devices}))}
async fn diagnostics(State(ui):State<Ui>)->Json<Value>{Json(ui.diagnostics())}
async fn report(State(ui):State<Ui>)->String{
    let mut v=ui.diagnostics();
    if let Some(m)=v.as_object_mut(){for k in ["local","lastTest","level","items","slots","hero","alive"]{m.remove(k);}}
    format!("Voice Invoker native — отчёт\n{}",serde_json::to_string_pretty(&v).unwrap_or_default())
}
async fn preview(State(ui):State<Ui>,Json(_):Json<Value>)->StatusCode{
    ui.notice("preview",Some(json!({"id":"invoker_sun_strike","name":"Sun Strike"})),None);StatusCode::NO_CONTENT
}
async fn events(State(ui):State<Ui>)->Sse<impl tokio_stream::Stream<Item=Result<Event,Infallible>>>{
    let rx=ui.events.subscribe();let initial=tokio_stream::once(Ok(Event::default().data(ui.snapshot().to_string())));
    let stream=BroadcastStream::new(rx).filter_map(|r|r.ok()).map(|v|Ok(Event::default().data(v.to_string())));
    Sse::new(initial.chain(stream)).keep_alive(KeepAlive::new().interval(Duration::from_secs(10)))
}
#[cfg(windows)]
async fn import(State(ui):State<Ui>,Json(_):Json<Value>)->Json<Value>{
    let generation=ui.data.lock().unwrap_or_else(|e|e.into_inner()).generation;
    let Some((steam,id))=crate::steam::automatic_steam()else{return Json(json!({"ok":false,"error":"Steam не найден"}));};
    let status=crate::steam::inspect(&steam,id);
    match status.bindings{Some(b)=>Json(json!({"ok":true,"keys":b.keys,"slotCastModes":b.modes,"warnings":b.warnings,"bindingGeneration":generation})),None=>Json(json!({"ok":false,"error":status.issue}))}
}
#[cfg(not(windows))]
async fn import(Json(_):Json<Value>)->Json<Value>{Json(json!({"ok":false,"error":"Windows only"}))}
async fn repair(State(ui):State<Ui>,Json(body):Json<Value>)->Json<Value>{
    let (store,c)={let d=ui.data.lock().unwrap_or_else(|e|e.into_inner());(d.store.clone(),d.saved.clone())};
    let result=(||->Result<(),Box<dyn std::error::Error>>{
        let store=store.ok_or("Внешняя конфигурация только для чтения")?;
        let path=body.get("dotaPath").and_then(Value::as_str).filter(|s|!s.is_empty()).map(PathBuf::from);
        #[cfg(windows)]
        let path=path.or_else(||crate::steam::automatic_steam().and_then(|(p,_)|crate::steam::discover_dota(&p,None)));
        let path=path.ok_or("Укажи папку Dota")?;
        crate::integration::install(&path,store.directory(),&c)?;Ok(())
    })();
    match result{Ok(())=>Json(json!({"ok":true,"message":"GSI проверен. Перезапусти Dota для загрузки файла."})),Err(e)=>Json(json!({"ok":false,"error":e.to_string()}))}
}
async fn logs(State(ui):State<Ui>,Json(_):Json<Value>)->StatusCode{
    let directory=ui.data.lock().unwrap_or_else(|e|e.into_inner()).store.as_ref().map(|s|s.directory().to_owned());
    #[cfg(windows)]
    if let Some(dir)=directory{return if std::process::Command::new("explorer.exe").arg(dir).spawn().is_ok(){StatusCode::NO_CONTENT}else{StatusCode::INTERNAL_SERVER_ERROR};}
    #[cfg(not(windows))]
    let _=directory;
    StatusCode::NOT_FOUND
}
pub fn router(ui:Ui)->Router{
    Router::new()
    .route("/settings",get(||async{Html(include_str!("../ui/settings.html"))}))
    .route("/",get(||async{Html(include_str!("../ui/overlay.html"))}))
    .route("/overlay.html",get(||async{Html(include_str!("../ui/overlay.html"))}))
    .route("/icon.png",get(||async{([(header::CONTENT_TYPE,"image/png")],include_bytes!("../../icon.png").as_slice())}))
    .route("/sounds/keys.wav",get(||async{([(header::CONTENT_TYPE,"audio/wav")],include_bytes!("../../keys.wav").as_slice())}))
    .route("/config",get(config).post(save)).route("/restart",post(restart))
    .route("/dictionary",get(dictionary)).route("/devices",get(devices))
    .route("/diagnostics",get(diagnostics)).route("/support-report",get(report))
    .route("/preview-sun-strike",post(preview)).route("/events",get(events))
    .route("/import-bindings",post(import)).route("/repair-gsi",post(repair)).route("/pick-dota",post(repair)).route("/open-logs",post(logs))
    .with_state(ui)
}
