use voice_invoker_native::{catalog,config::{Config,Profile},engine::{Engine,Notice},gsi::Packet,input::Step,recognition::Parser};
fn parser()->Parser{Parser::new(&catalog::resolve(&Config::default(),None))}
fn packet(ability:&str,alive:bool,can_cast:bool)->Packet{
    serde_json::from_value(serde_json::json!({"auth":{"token":"voice_invoke"},"hero":{"name":"npc_dota_hero_invoker","alive":alive},"abilities":{"ability3":{"name":ability,"cooldown":0,"can_cast":can_cast}}})).unwrap()
}
#[test]
fn split_invoke_waits_for_ack_and_gsi_and_preserves_profile(){
    let mut e=Engine::new(Config::default());e.set_ready(true);e.profile=Profile::Turbo;
    e.accept_gsi(1000,packet("invoker_empty1",true,true));
    assert!(e.enqueue(1001,parser().parse("торнадо").remove(0)));
    let first=e.poll(1001).unwrap();assert_eq!(first.steps.len(),4);assert_eq!(first.profile,Profile::Turbo);
    e.profile=Profile::Normal;e.accept_gsi(1050,packet("invoker_tornado",true,true));assert!(e.poll(1050).is_none());
    assert!(!e.acknowledge(first.id+1,true,1051));assert!(e.acknowledge(first.id,true,1051));
    let second=e.poll(1051).unwrap();assert_eq!(second.profile,Profile::Turbo);assert_eq!(second.steps,vec![Step::Key(68,0),Step::Click(10)]);
}
#[test]
fn prepare_and_invalid_hero_never_press_slot(){
    let p=parser();
    for (phrase,alive,can_cast) in [("готовь торнадо",true,false),("торнадо",false,true),("торнадо",true,false)]{
        let mut e=Engine::new(Config::default());e.set_ready(true);e.accept_gsi(1,packet("invoker_empty1",true,true));
        assert!(e.enqueue(2,p.parse(phrase).remove(0)));let r=e.poll(2).unwrap();e.acknowledge(r.id,true,3);
        e.accept_gsi(4,packet("invoker_tornado",alive,can_cast));assert!(e.poll(4).is_none());
        let notices=e.notices();if phrase.starts_with("готовь"){assert_eq!(notices,vec![Notice::Prepared{confirmed:true}]);}else{assert!(matches!(notices.first(),Some(Notice::Refused(_))));}
    }
}
#[test]
fn no_gsi_prepare_is_unconfirmed_and_failure_discards(){
    let p=parser();let mut e=Engine::new(Config::default());e.set_ready(true);
    e.enqueue(1,p.parse("готовь торнадо").remove(0));let r=e.poll(1).unwrap();e.acknowledge(r.id,true,2);
    assert_eq!(e.notices(),vec![Notice::Prepared{confirmed:false}]);
    e.enqueue(3,p.parse("метеор").remove(0));e.enqueue(4,p.parse("эмп").remove(0));let r=e.poll(42).unwrap();
    assert!(e.poll(9000).is_none());assert_eq!(e.notices(),vec![Notice::Watchdog]);assert!(!e.enqueue(9001,p.parse("торнадо").remove(0)));
    e.acknowledge(r.id,true,9002);assert_eq!(e.notices(),vec![Notice::InputFailed]);assert!(e.poll(9003).is_none());
}
#[test]
fn mic_loss_cancels_waiting_without_slot(){
    let mut e=Engine::new(Config::default());e.set_ready(true);e.accept_gsi(1,packet("invoker_empty1",true,true));
    e.enqueue(2,parser().parse("торнадо").remove(0));let r=e.poll(2).unwrap();
    e.set_ready(false);e.acknowledge(r.id,true,3);e.set_ready(true);e.accept_gsi(4,packet("invoker_tornado",true,true));assert!(e.poll(4).is_none());
}
