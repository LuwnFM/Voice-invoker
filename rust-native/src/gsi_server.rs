//! Loopback-only GSI receiver. No game input or configuration writes.
use crate::{config::Config,gsi::Packet};
use axum::{Router, routing::{get,post}, extract::{State,DefaultBodyLimit}, http::{HeaderMap,StatusCode}, response::IntoResponse, Json};
use serde_json::json;
use std::{sync::{Arc,Mutex},time::{Duration,Instant}};
#[derive(Clone)]
pub struct GsiState {token:Arc<str>, latest:Arc<Mutex<Option<(Instant,Packet)>>>}
impl GsiState{
    pub fn new(c:&Config)->Self{Self{token:Arc::from(c.auth_token.as_str()),latest:Arc::new(Mutex::new(None))}}
    pub fn take(&self)->Option<(Instant,Packet)>{self.latest.lock().ok()?.take()}
}
async fn receive(State(state):State<GsiState>,headers:HeaderMap,Json(packet):Json<Packet>)->StatusCode{
    // GSI is a native game client. Browser cross-origin calls are not accepted.
    if headers.contains_key("origin"){return StatusCode::FORBIDDEN;}
    if state.token.is_empty()||packet.auth.token!=state.token.as_ref(){return StatusCode::UNAUTHORIZED;}
    match state.latest.lock(){
        Ok(mut latest)=>{*latest=Some((Instant::now(),packet));StatusCode::NO_CONTENT},
        Err(_)=>StatusCode::SERVICE_UNAVAILABLE,
    }
}
async fn status(State(state):State<GsiState>)->impl IntoResponse{
    match state.latest.lock(){
        Ok(latest)=>Json(json!({"ready":true,"gsiAgeMs":latest.as_ref().map(|(at,_)|at.elapsed().as_millis()),"hero":latest.as_ref().map(|(_,p)|p.hero.name.as_str()),"alive":latest.as_ref().map(|(_,p)|p.hero.alive)})),
        Err(_)=>Json(json!({"ready":false})),
    }
}
pub fn router(state:GsiState)->Router{
    Router::new().route("/gsi",post(receive)).route("/status",get(status)).layer(DefaultBodyLimit::max(256*1024)).with_state(state)
}
pub fn monitor(c:&Config,seconds:u64)->Result<(),Box<dyn std::error::Error>>{
    if !(1..=300).contains(&seconds){return Err("Seconds must be 1..300".into());}
    let rt=tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    rt.block_on(async{
        let listener=tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST,c.port)).await?;
        println!("GSI monitor http://{}",listener.local_addr()?);
        use std::io::Write;
        std::io::stdout().flush()?;
        let state=GsiState::new(c);
        // Timeout drops the listener; no indefinite background task.
        let result=tokio::time::timeout(Duration::from_secs(seconds),async{axum::serve(listener,router(state)).await}).await;
        if let Ok(result)=result{result?;}
        Ok(())
    })
}
