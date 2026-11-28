use voice_invoker_native::{catalog::{self,Target},config::{Config,Mode,Profile},recognition::{Parser,Gate,PREFIXES},input::{self,Action,Step},queue::Queue,audio::{self,Blocks},gsi::Packet};
#[test]
fn catalog_and_preparation_parity(){
    let cfg=Config::default();let cat=catalog::resolve(&cfg,None);assert!(cat.errors.is_empty(),"{:?}",cat.errors);assert_eq!(cat.active.len(),143);
    let parser=Parser::new(&cat);assert_eq!(parser.grammar().len(),143*7+6+1);
    for (phrase,target) in &cat.active{let hit=parser.parse(phrase);assert_eq!(hit.len(),1);assert_eq!(&hit[0].target,target);assert!(!hit[0].prepare_only);
        for prefix in PREFIXES{let hit=parser.parse(&format!("{prefix} {phrase}"));assert_eq!(hit.len(),1);assert!(hit[0].prepare_only);assert_eq!(&hit[0].target,target);}}
    let cfg=Config{expanded_vocabulary:false,..cfg};assert_eq!(catalog::resolve(&cfg,None).active.len(),96);
}
#[test]
fn longest_match_and_partial_preparation_guard(){
    let p=Parser::new(&catalog::resolve(&Config::default(),None));
    assert_eq!(p.parse("готовь торнадо метеор").len(),2);
    assert!(p.parse("запиши торнадо").is_empty());
    let mut g=Gate::default();assert!(g.read(&p,"готовь торнадо",false).is_empty());assert!(g.read(&p,"торнадо",true).is_empty());g.reset();assert_eq!(g.read(&p,"торнадо",false).len(),1);
}
#[test]
fn custom_aliases_exclusions_and_conflicts(){
    let mut c=Config::default();let words=["щит","эмп","буря"].into_iter().map(str::to_owned).collect();
    c.disabled_phrases.insert("invoker_emp".into(),vec!["эмп".into()]);
    c.custom_spell_phrases.insert("invoker_tornado".into(),vec!["буря".into()]);
    c.item_phrases.insert("item_slot_item1".into(),vec!["эмп".into(),"щит".into()]);
    let cat=catalog::resolve(&c,Some(&words));assert!(cat.errors.is_empty());assert_eq!(cat.active.get("эмп"),Some(&Target::Item(0)));
    c.disabled_phrases.clear();assert!(!catalog::resolve(&c,Some(&words)).errors.is_empty());
}
#[test]
fn all_spell_sequences_and_profiles(){
    let mut c=Config::default();let spells=catalog::spells();
    for s in &spells{for p in [Profile::Normal,Profile::Fast,Profile::Turbo]{
        let prepared=input::sequence(&c,s,Action::Prepare,p).unwrap();assert_eq!(prepared.len(),4);assert_eq!(prepared[3],Step::Key(82,c.timing(p).key));
        let full=input::sequence(&c,s,Action::Invoke,p).unwrap();assert!(full.len()>=5);
    }}
    let tornado=spells.iter().find(|s|s.id=="invoker_tornado").unwrap();
    assert_eq!(input::sequence(&c,tornado,Action::Invoke,Profile::Normal).unwrap(),vec![Step::Key(87,0),Step::Key(87,35),Step::Key(81,35),Step::Key(82,35),Step::Key(68,90),Step::Click(60)]);
    c.slot_cast_modes.insert("slot2".into(),Mode::Quickcast);
    assert_eq!(input::sequence(&c,tornado,Action::Slot2,Profile::Normal).unwrap(),vec![Step::Key(70,0)]);
}
#[test]
fn held_key_release_survives_rebinding(){
    let mut c=Config::default();let mut s=input::InputState::new(&c);
    assert!(s.handle(82,true,true).0);
    c.keys.insert("invoke".into(),"B".into());s.update_bindings(&c);
    assert!(s.handle(82,false,false).0);assert!(!s.handle(82,true,true).0);assert!(s.handle(66,true,true).0);
}
#[test]
fn ack_gate_and_expiry(){
    let p=Parser::new(&catalog::resolve(&Config::default(),None));let commands=p.parse("торнадо метеор");
    let mut q=Queue::default();for c in commands{assert!(q.push(1000,c));}
    let first=q.next(1000,Profile::Normal).unwrap();assert!(q.next(1050,Profile::Fast).is_none());
    assert!(!q.ack(first.id+1,true,1050,40));assert!(q.ack(first.id,true,1050,40));
    assert!(q.next(1089,Profile::Fast).is_none());let second=q.next(1090,Profile::Fast).unwrap();assert_eq!(second.profile,Profile::Fast);
    assert!(q.ack(second.id,false,1100,40));assert!(q.next(2000,Profile::Normal).is_none());
}
#[test]
fn gsi_items_and_slot_modes(){
    let mut c=Config::default();c.keys.insert("item1".into(),"Z".into());
    let p:Packet=serde_json::from_str(r#"{"auth":{"token":"voice_invoke"},"hero":{"name":"npc_dota_hero_invoker","alive":true},"items":{"slot0":{"name":"item_force_staff","cooldown":0,"can_cast":true}}}"#).unwrap();
    assert!(p.authenticated(&c));assert_eq!(p.item_mode(0,&c,true,false),Ok(Mode::Quickcast));c.item_cast_modes.insert("item_force_staff".into(),Mode::Click);assert_eq!(p.item_mode(0,&c,true,false),Ok(Mode::Click));assert!(p.item_mode(0,&c,false,false).is_err());
}
#[test]
fn audio_blocks_and_conversion(){
    assert_eq!(audio::pcm16(f32::NAN),0);assert_eq!(audio::mono_f32(&[1.0,-1.0]),0);
    let mut blocks=Blocks::new(512).unwrap();for i in 0..511{assert!(blocks.push(i).is_none());}assert_eq!(blocks.push(511).unwrap().len(),512);
    assert!(Blocks::new(0).is_err());
}
