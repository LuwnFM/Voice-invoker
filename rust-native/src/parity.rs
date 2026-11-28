//! JSONL adapter for differential tests against the original JavaScript.
use crate::{catalog, config::{Config,Profile},input::{self,Action,Step},recognition::{Parser,Gate},bindings};
use serde::Deserialize;
use serde_json::{json,Value};
use std::io::{BufRead,Write};

#[derive(Deserialize)]
#[serde(tag="op",rename_all="snake_case")]
enum Case{
    Parse{text:String,grammar:Vec<String>},
    Gate{grammar:Vec<String>,hypotheses:Vec<(String,bool)>},
    Key{key:String},
    Timing{config:Config,profile:Profile},
    Sequence{config:Config,id:String,action:u8,profile:Profile},
    Bindings{text:String},
}
fn parser(grammar:Vec<String>)->Parser{
    let active=grammar.into_iter().map(|p|(p,catalog::Target::Spell("test".into()))).collect();
    Parser::new(&catalog::Catalog{active,errors:Vec::new()})
}
fn commands(commands:Vec<crate::recognition::Command>)->Vec<String>{
    commands.into_iter().map(|c|if c.prepare_only{format!("подготовить {}",c.phrase)}else{c.phrase}).collect()
}
fn execute(c:Case)->Result<Value,String>{
    Ok(match c{
        Case::Parse{text,grammar}=>json!(commands(parser(grammar).parse(&text))),
        Case::Gate{grammar,hypotheses}=>{
            let p=parser(grammar);let mut gate=Gate::default();
            json!(hypotheses.into_iter().map(|(text,finalized)|commands(gate.read(&p,&text,finalized))).collect::<Vec<_>>())
        },
        Case::Key{key}=>json!(input::vk_of(&key).unwrap_or(0)),
        Case::Timing{config,profile}=>{let t=config.timing(profile);json!({"keyDelayMs":t.key,"castDelayMs":t.cast,"clickDelayMs":t.click,"altDelayMs":t.alt,"chainGapMs":t.chain})},
        Case::Sequence{config,id,action,profile}=>{
            let spell=catalog::spells().into_iter().find(|s|s.id==id).ok_or("Unknown spell")?;
            let a=match action{1=>Action::Slot1,2=>Action::Slot2,3=>Action::Invoke,4=>Action::Prepare,_=>return Err("Invalid action".into())};
            json!(input::sequence(&config,&spell,a,profile)?.into_iter().map(|s|match s{
                Step::Key(vk,wait)=>json!({"type":"key","vk":vk,"wait":wait}),
                Step::Down(vk,wait)=>json!({"type":"down","vk":vk,"wait":wait}),
                Step::Up(vk,wait)=>json!({"type":"up","vk":vk,"wait":wait}),
                Step::Click(wait)=>json!({"type":"click","wait":wait}),
            }).collect::<Vec<_>>())
        },
        Case::Bindings{text}=>{let b=bindings::read(&text)?;json!({"keys":b.keys,"slotCastModes":b.modes,"warningCount":b.warnings.len()})},
    })
}
pub fn run()->Result<(),Box<dyn std::error::Error>>{
    let stdout=std::io::stdout();let mut out=stdout.lock();
    for line in std::io::stdin().lock().lines(){
        let line=line?;if line.len()>1024*1024{return Err("Parity input too large".into());}
        let result=serde_json::from_str::<Case>(&line).map_err(|e|e.to_string()).and_then(execute);
        let value=match result{Ok(value)=>json!({"ok":true,"value":value}),Err(_)=>json!({"ok":false})};
        writeln!(out,"{}",value)?;
    }
    Ok(())
}
