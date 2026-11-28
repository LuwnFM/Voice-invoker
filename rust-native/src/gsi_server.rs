//! Loopback-only GSI receiver. No game input or configuration writes.
use crate::{config::Config,gsi::Packet};
use axum::{Router, routing::{get,post}, extract::{State,DefaultBodyLimit}, http::{HeaderMap,StatusCode}, response::IntoResponse, Json};
use serde_json::json;
use std::{sync::{Arc,Mutex},time::{Duration,Instant}};
#[derive(Clone)]
pub struct GsiState {token:Arc<str>, latest:Arc<Mutex<Option<(Instant,Packet)>>>}
impl GsiState{
    pub fn new(c:&Config)->Self{Self{token:Arc::from(c.auth_token.as_str()),latest:Arc::new(Mutex::new(None))}}
    pub fn snapshot(&self)->Option<(Instant,Packet)>{self.latest.lock().ok()?.clone()}
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

pub struct Server {
    stop: std::sync::mpsc::Sender<()>,
    thread: Option<std::thread::JoinHandle<()>>,
    pub state: GsiState,
    pub address: std::net::SocketAddr,
}
impl Server {
    pub fn start(c:&Config)->std::io::Result<Self>{Self::start_with_ui(c,|_|Router::new())}
    pub fn start_with_ui(c:&Config,make_ui:impl FnOnce(GsiState)->Router)->std::io::Result<Self>{
        let listener=std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST,c.port))?;
        listener.set_nonblocking(true)?;
        let address=listener.local_addr()?;
        let rt=tokio::runtime::Builder::new_current_thread().enable_all().build()?;
        let (stop,rx)=std::sync::mpsc::channel();
        let state=GsiState::new(c);let app=router(state.clone()).merge(make_ui(state.clone())).layer(DefaultBodyLimit::max(256*1024)).layer(axum::middleware::from_fn(move |req:axum::extract::Request,next:axum::middleware::Next|async move{
            let port=address.port();let local=[format!("127.0.0.1:{port}"),format!("localhost:{port}")];
            let host=req.headers().get(axum::http::header::HOST).and_then(|v|v.to_str().ok());
            let allowed_host=host.is_some_and(|h|local.iter().any(|a|a.eq_ignore_ascii_case(h)));
            let allowed_origin=req.headers().get(axum::http::header::ORIGIN).is_none_or(|v|v.to_str().ok().is_some_and(|o|local.iter().any(|a|o==format!("http://{a}"))));
            if !allowed_host||!allowed_origin{return StatusCode::FORBIDDEN.into_response();}next.run(req).await
        }));
        let thread=std::thread::spawn(move||{
            rt.block_on(async move{
                let Ok(listener)=tokio::net::TcpListener::from_std(listener)else{return;};
                let shutdown=async move{loop{match rx.try_recv(){
                    Ok(())|Err(std::sync::mpsc::TryRecvError::Disconnected)=>break,
                    Err(std::sync::mpsc::TryRecvError::Empty)=>tokio::time::sleep(Duration::from_millis(25)).await,
                }}};
                // Dropping the server future closes connections without an indefinite graceful drain.
                tokio::select!{_ = async {let _=axum::serve(listener,app).await;}=>{},_ = shutdown=>{}}
            });
        });
        Ok(Self{stop,thread:Some(thread),state,address})
    }
    pub fn running(&self)->bool{self.thread.as_ref().is_some_and(|t|!t.is_finished())}
}
impl Drop for Server {
    fn drop(&mut self){let _=self.stop.send(());if let Some(t)=self.thread.take(){let _=t.join();}}
}
