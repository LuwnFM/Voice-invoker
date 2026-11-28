// Read-only parser for Steam's Valve KeyValues format.
use crate::{config::{Config,Mode},input::{vk_of,validate_keys}};
use std::collections::BTreeMap;
#[derive(Debug,Clone)]
pub enum Value{Text(String),Object(BTreeMap<String,Value>)}
impl Value{
    pub fn get(&self,key:&str)->Option<&Self>{if let Self::Object(m)=self{m.get(&key.to_ascii_lowercase())}else{None}}
    pub fn text(&self)->Option<&str>{if let Self::Text(s)=self{Some(s)}else{None}}
}
#[derive(Debug,PartialEq,Eq)]
enum Token{Text(String),Open,Close}
fn tokenize(s:&str)->Result<Vec<Token>,String>{
    let mut chars=s.trim_start_matches('\u{feff}').chars().peekable();let mut tokens=Vec::new();
    while let Some(c)=chars.next(){
        match c{
            c if c.is_whitespace()=>{},
            '/' if chars.peek()==Some(&'/')=>{chars.next();for x in chars.by_ref(){if x=='\n'{break;}}},
            '{'=>tokens.push(Token::Open),'}'=>tokens.push(Token::Close),
            '"'=>{let mut text=String::new();let mut closed=false;while let Some(x)=chars.next(){if x=='"'{closed=true;break;}if x=='\\'&&matches!(chars.peek(),Some('"'|'\\')){text.push(chars.next().unwrap());}else{text.push(x);}}if !closed{return Err("Unclosed VDF string".into());}tokens.push(Token::Text(text));},
            _=>{let mut text=String::from(c);while chars.peek().is_some_and(|x|!x.is_whitespace()&&!matches!(x,'{'|'}'|'"')){text.push(chars.next().unwrap());}tokens.push(Token::Text(text));}
        }
        if tokens.len()>500_000{return Err("Too many VDF tokens".into());}
    }
    Ok(tokens)
}
fn block(tokens:&mut std::iter::Peekable<std::vec::IntoIter<Token>>,depth:usize)->Result<Value,String>{
    if depth>64{return Err("VDF nesting limit".into());}
    let mut out=BTreeMap::new();
    loop{
        let key=match tokens.next(){
            Some(Token::Text(k))=>k.to_ascii_lowercase(),
            Some(Token::Close) if depth>0=>break,
            None if depth==0=>break,
            _=>return Err("Expected VDF key or closing brace".into()),
        };
        let v=match tokens.next(){Some(Token::Text(v))=>Value::Text(v),Some(Token::Open)=>block(tokens,depth+1)?,_=>return Err("Missing VDF value".into())};
        out.insert(key,v);
    }
    Ok(Value::Object(out))
}
pub fn parse(s:&str)->Result<Value,String>{block(&mut tokenize(s)?.into_iter().peekable(),0)}
#[derive(Debug,Default)]
pub struct Bindings{pub keys:BTreeMap<String,String>,pub modes:BTreeMap<String,Mode>,pub warnings:Vec<String>}
fn key_alias(raw:&str)->String{
    let raw=raw.to_ascii_lowercase();
    match raw.as_str(){
        "uparrow"=>"UP","downarrow"=>"DOWN","leftarrow"=>"LEFT","rightarrow"=>"RIGHT",
        "kp_multiply"=>"NUM*","kp_plus"=>"NUM+","kp_minus"=>"NUM-","kp_del"=>"NUM.","kp_slash"=>"NUM/",
        "semicolon"=>";","key_cyrillic_be"=>",","key_cyrillic_yu"=>".","key_cyrillic_e"=>"'","key_cyrillic_zhe"=>";",
        "key_cyrillic_ha"=>"[","key_cyrillic_hard_sign"=>"]","key_cyrillic_yo"=>"`",
        _=>return if let Some(n)=raw.strip_prefix("kp_").filter(|s|s.len()==1&&s.as_bytes()[0].is_ascii_digit()){format!("NUM{n}")}else{raw.to_ascii_uppercase()},
    }.to_owned()
}
pub fn read(s:&str)->Result<Bindings,String>{
    let root=parse(s)?;let root=root.get("keybindings").ok_or("Missing KeyBindings")?;
    let keys=root.get("keys").ok_or("Missing Keys")?;
    let mut b=Bindings::default();
    if root.get("useherobindings").and_then(Value::text)==Some("1"){b.warnings.push("Hero-specific bindings unsupported".into());}
    let mut actions:Vec<(String,String)>= [("quas","abilityprimary1"),("wex","abilityprimary2"),("exort","abilityprimary3"),("invoke","abilityultimate"),("slot1","abilitysecondary1"),("slot2","abilitysecondary2"),("voice","chatvoiceteam"),("neutral","inventoryneutral"),("teleport","inventorytp")].into_iter().map(|(a,k)|(a.into(),k.into())).collect();
    actions.extend((1..=6).map(|i|(format!("item{i}"),format!("inventory{i}"))));
    for (name,action) in actions{
        let normal=keys.get(&action).filter(|n|n.get("key").and_then(Value::text).is_some_and(|v|!v.is_empty()));
        let quick=keys.get(&format!("{action}quickcast")).filter(|n|n.get("key").and_then(Value::text).is_some_and(|v|!v.is_empty()));
        let Some(node)=normal.or(quick)else{continue;};
        let key=key_alias(node.get("key").and_then(Value::text).unwrap_or(""));
        if vk_of(&key).is_none()||node.get("modifier").and_then(Value::text).is_some_and(|s|!s.is_empty()&&!s.eq_ignore_ascii_case("none")){b.warnings.push(format!("Unsupported binding: {action}"));continue;}
        b.keys.insert(name.clone(),key);
        if name.starts_with("slot")||name.starts_with("item")||matches!(name.as_str(),"neutral"|"teleport"){
            match (normal.is_none(),node.get("mode").and_then(Value::text)){
                (true,_)|(_,Some("1"|"2"))=>{b.modes.insert(name,Mode::Quickcast);},
                (_,Some("0"))=>{b.modes.insert(name,Mode::Click);},
                _=>{}
            }
        }
    }
    Ok(b)
}
pub fn apply(c:&Config,b:&Bindings)->Result<Config,String>{
    if !b.warnings.is_empty(){return Err(b.warnings.join("; "));}
    if ["quas","wex","exort","invoke","slot1","slot2","voice"].iter().any(|k|!b.keys.contains_key(*k)){return Err("Incomplete core bindings".into());}
    if crate::catalog::ITEM_KEYS.iter().any(|k|c.keys.get(*k).is_some_and(|v|!v.is_empty())&&!b.keys.contains_key(*k)){return Err("Previously assigned item binding missing".into());}
    let mut next=c.clone();
    for (k,v) in &b.keys{if k=="voice"{next.voice_chat_key=v.clone();}else{next.keys.insert(k.clone(),v.clone());}}
    if c.sync_quickcast{next.slot_cast_modes.extend(b.modes.clone());}
    validate_keys(&next)?;Ok(next)
}
