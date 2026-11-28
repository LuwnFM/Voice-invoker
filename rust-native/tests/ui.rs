use voice_invoker_native::{config::Config,gsi_server::Server,ui::{self,Ui},storage::Store};
use std::io::{Read,Write};
use std::net::{TcpStream,SocketAddr};
fn http(addr:SocketAddr,method:&str,path:&str,body:&str,host:Option<&str>,origin:Option<&str>)->(u16,String){
    let mut s=TcpStream::connect(addr).unwrap();s.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
    let mut request=format!("{method} {path} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n",host.map(str::to_owned).unwrap_or_else(||addr.to_string()),body.len());
    if let Some(origin)=origin{request.push_str(&format!("Origin: {origin}\r\n"));}
    request.push_str("\r\n");request.push_str(body);s.write_all(request.as_bytes()).unwrap();
    let mut buf=Vec::new();s.read_to_end(&mut buf).unwrap();let text=String::from_utf8_lossy(&buf);
    let (headers,body)=text.split_once("\r\n\r\n").unwrap();
    (headers.split_whitespace().nth(1).unwrap().parse().unwrap(),body.to_owned())
}
#[test]
fn settings_routes_and_authentication_preserve_native_config(){
    let root=tempfile::tempdir().unwrap();let store=Store::open(root.path()).unwrap();
    let c=Config{port:0,..Config::default()};store.save(&c).unwrap();
    let server=Server::start_with_ui(&c,|gsi|ui::router(Ui::new(&c,Some(store.clone()),["буря".into()].into_iter().collect(),vec!["Mic".into()],true,gsi))).unwrap();
    let a=server.address;
    assert_eq!(http(a,"GET","/settings","",None,None).0,200);
    let (status,body)=http(a,"GET","/config","",None,None);assert_eq!(status,200);assert!(body.contains("phraseCatalog")&&!body.contains("authToken"));
    let (status,body)=http(a,"GET","/overlay.html","",None,None);assert_eq!(status,200);assert!(!body.contains("getUserMedia")&&!body.contains("vosk.js"));
    assert_eq!(http(a,"GET","/config","",Some("evil.example"),None).0,403);
    assert_eq!(http(a,"POST","/config",r#"{"bindingGeneration":0}"#,None,Some("https://evil.example")).0,403);
    assert_eq!(http(a,"POST","/config",r#"{"bindingGeneration":1}"#,None,None).0,400);
    assert_eq!(http(a,"POST","/config",r#"{"bindingGeneration":0,"voiceChatKey":"Q"}"#,None,None).0,400);
    let (status,body)=http(a,"POST","/config",r#"{"bindingGeneration":0,"customSpellPhrases":{"invoker_tornado":["буря"]},"audioRate":16000}"#,None,None);
    assert_eq!(status,200,"{body}");let saved=store.load().unwrap().unwrap();assert_eq!(saved.custom_spell_phrases["invoker_tornado"],vec!["буря"]);assert_eq!(saved.other["audioRate"],16000);
    assert_eq!(http(a,"GET","/support-report","",None,None).0,200);
}
