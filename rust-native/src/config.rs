use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

pub type Phrases = BTreeMap<String, Vec<String>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Click,
    Quickcast,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Profile {
    #[default]
    Normal,
    Fast,
    Turbo,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TimingOverrides {
    pub key_delay_ms: Option<u64>,
    pub cast_delay_ms: Option<u64>,
    pub click_delay_ms: Option<u64>,
    pub alt_delay_ms: Option<u64>,
    pub chain_gap_ms: Option<u64>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timing {
    pub key: u64,
    pub cast: u64,
    pub click: u64,
    pub alt: u64,
    pub chain: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub port: u16,
    pub auth_token: String,
    pub keys: BTreeMap<String, String>,
    pub voice_chat_key: String,
    pub block_keys: Vec<String>,
    pub listen: String,
    pub cast_mode: Mode,
    pub timing_profile: Profile,
    pub key_delay_ms: u64,
    pub cast_delay_ms: u64,
    pub slot_wait_ms: u64,
    pub click_delay_ms: u64,
    pub alt_delay_ms: u64,
    pub chain_gap_ms: u64,
    pub fast_timing: TimingOverrides,
    pub turbo_timing: TimingOverrides,
    pub microphone: String,
    pub window_title: String,
    pub phrases: Phrases,
    pub custom_spell_phrases: Phrases,
    pub disabled_phrases: Phrases,
    pub item_phrases: Phrases,
    pub slot_cast_modes: BTreeMap<String, Mode>,
    pub item_cast_modes: BTreeMap<String, Mode>,
    pub expanded_vocabulary: bool,
    pub experimental_frames: bool,
    pub auto_sync_bindings: bool,
    pub sync_quickcast: bool,
    pub binding_notifications: bool,
    pub accept_injected: bool,
    pub debug_steps: bool,
    pub test_only: bool,
    #[serde(flatten)]
    pub other: BTreeMap<String, serde_json::Value>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            port: 3055, auth_token: "voice_invoke".into(),
            keys: [("quas","Q"),("wex","W"),("exort","E"),("invoke","R"),("slot1","D"),("slot2","F")].into_iter().map(|(k,v)|(k.into(),v.into())).collect(),
            voice_chat_key: "G".into(), block_keys: vec!["invoke".into()], listen: "hold".into(),
            cast_mode: Mode::Click, timing_profile: Profile::Normal,
            key_delay_ms:35, cast_delay_ms:90, slot_wait_ms:1500, click_delay_ms:60, alt_delay_ms:30, chain_gap_ms:40,
            fast_timing:Default::default(), turbo_timing:Default::default(),
            microphone:String::new(),window_title:"Dota 2".into(),
            phrases:Default::default(),custom_spell_phrases:Default::default(),disabled_phrases:Default::default(),item_phrases:Default::default(),
            slot_cast_modes:Default::default(),item_cast_modes:Default::default(),
            expanded_vocabulary:true,experimental_frames:false,auto_sync_bindings:true,sync_quickcast:true,binding_notifications:true,
            accept_injected:false,debug_steps:false,test_only:false,other:Default::default(),
        }
    }
}
impl Config {
    // Read only: the native prototype must never change existing 1.1.1 preferences.
    pub fn load(path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let text=std::fs::read_to_string(path)?;
        Self::from_json(&text)
    }
    pub fn from_json(text:&str)->Result<Self,Box<dyn std::error::Error>>{
        let mut cfg:Self=serde_json::from_str(text.trim_start_matches('\u{feff}'))?;
        let mut keys=Self::default().keys;
        keys.append(&mut cfg.keys);
        cfg.keys=keys;
        crate::input::validate_keys(&cfg)?;
        Ok(cfg)
    }
    pub fn timing(&self, profile:Profile) -> Timing {
        let bounded=|value:u64,default:u64| if value<=5000{value}else{default};
        let normal=Timing { key:bounded(self.key_delay_ms,35),cast:bounded(self.cast_delay_ms,90),click:bounded(self.click_delay_ms,60),alt:bounded(self.alt_delay_ms,30),chain:bounded(self.chain_gap_ms,40) };
        let (preset,o)=match profile {
            Profile::Normal=>return normal,
            Profile::Fast=>(Timing{key:20,cast:90,click:30,alt:20,chain:20},&self.fast_timing),
            Profile::Turbo=>(Timing{key:10,cast:90,click:10,alt:10,chain:10},&self.turbo_timing),
        };
        let cap=|base:u64,default:u64,override_value:Option<u64>|base.min(override_value.filter(|v|*v<=5000).unwrap_or(default));
        Timing{key:cap(normal.key,preset.key,o.key_delay_ms),cast:cap(normal.cast,preset.cast,o.cast_delay_ms),click:cap(normal.click,preset.click,o.click_delay_ms),alt:cap(normal.alt,preset.alt,o.alt_delay_ms),chain:cap(normal.chain,preset.chain,o.chain_gap_ms)}
    }
}
