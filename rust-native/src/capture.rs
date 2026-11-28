//! WASAPI capture owned by the session; bounded queue, no disk recording.
use cpal::{traits::{DeviceTrait,HostTrait,StreamTrait},SampleFormat,Stream};
use std::sync::{Arc,atomic::{AtomicBool,Ordering},mpsc::{sync_channel,Receiver}};
use crate::audio::{Blocks,mono_f32};
pub struct Capture{
    stream:Stream,
    pub blocks:Receiver<Vec<i16>>,
    pub failure:Arc<AtomicBool>,
    pub rate:u32,
    pub name:String,
}
pub fn devices()->Vec<String>{
    let mut names:Vec<_>=cpal::default_host().input_devices().ok().into_iter().flatten().filter_map(|d|d.name().ok()).collect();names.sort();names.dedup();names
}
impl Capture {
    pub fn open(name:Option<&str>,requested:Option<u32>,block:usize)->Result<Self,Box<dyn std::error::Error>>{
        let host=cpal::default_host();
        let device=if let Some(name)=name.filter(|s|!s.is_empty()){
            host.input_devices()?.find(|d|d.name().ok().as_deref()==Some(name)).ok_or("Input device missing")?
        }else{host.default_input_device().ok_or("No default input device")?};
        let default=device.default_input_config()?;
        let supported=if let Some(rate)=requested{
            let selected=device.supported_input_configs()?.filter(|r|r.min_sample_rate().0<=rate&&r.max_sample_rate().0>=rate&&matches!(r.sample_format(),SampleFormat::F32|SampleFormat::I16|SampleFormat::U16))
                .min_by_key(|r|(r.sample_format()!=default.sample_format(),r.channels()!=default.channels()));
            match selected{Some(range)=>range.with_sample_rate(cpal::SampleRate(rate)),None=>{eprintln!("Requested sample rate unavailable; using {}",default.sample_rate().0);default}}
        }else{default};
        let format=supported.sample_format();let config:cpal::StreamConfig=supported.into();
        let rate=config.sample_rate.0;let channels=usize::from(config.channels);
        if channels==0{return Err("Invalid channel count".into());}
        let (tx,blocks)=sync_channel(32);let failure=Arc::new(AtomicBool::new(false));
        let flag=failure.clone();let err=move |_|{flag.store(true,Ordering::Release);};
        let flag=failure.clone();let mut acc=Blocks::new(block)?;
        let mut push=move|sample|{if let Some(block)=acc.push(sample){if tx.try_send(block).is_err(){flag.store(true,Ordering::Release);}}};
        let stream=match format{
            SampleFormat::F32=>device.build_input_stream(&config,move|data:&[f32],_|{for frame in data.chunks_exact(channels){push(mono_f32(frame));}},err,None)?,
            SampleFormat::I16=>device.build_input_stream(&config,move|data:&[i16],_|{for frame in data.chunks_exact(channels){push((frame.iter().map(|v|i64::from(*v)).sum::<i64>()/channels as i64) as i16);}},err,None)?,
            SampleFormat::U16=>device.build_input_stream(&config,move|data:&[u16],_|{for frame in data.chunks_exact(channels){push((frame.iter().map(|v|i64::from(*v)-32768).sum::<i64>()/channels as i64) as i16);}},err,None)?,
            _=>return Err("Unsupported microphone format".into()),
        };
        Ok(Self{stream,blocks,failure,rate,name:device.name()?})
    }
    pub fn start(&self)->Result<(),cpal::PlayStreamError>{self.stream.play()}
}
