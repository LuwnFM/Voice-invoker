use std::{path::Path,io::Write};
use voice_invoker_native::{catalog,config::Config,recognition::{Parser,Gate},model,vosk::Vosk,audio::Blocks};
fn main(){
    if let Err(e)=run(){eprintln!("Voice Invoker native: {e}");std::process::exit(1);}
}
fn run()->Result<(),Box<dyn std::error::Error>>{
    let args:Vec<String>=std::env::args().skip(1).collect();
    match args.first().map(String::as_str){
        Some("verify-model") if args.len()==2=>{model::verify(Path::new(&args[1]))?;println!("V2 SHA-256 OK");},
        Some("extract-model") if args.len()==3=>{let path=model::extract_verified(Path::new(&args[1]),Path::new(&args[2]))?;println!("{}",path.display());},
        Some("parse") if args.len()>=2=>{
            let cat=catalog::resolve(&Config::default(),None);let parser=Parser::new(&cat);
            for c in parser.parse(&args[1..].join(" ")){println!("{c:?}");}
        },
        Some("recognize-wav") if (4..=6).contains(&args.len())=>{
            let path=Path::new(&args[2]);let words=model::read_words(path)?;
            let cfg=if let Some(file)=args.get(5){Config::load(Path::new(file))?}else{Config::default()};
            let cat=catalog::resolve(&cfg,Some(&words));
            if !cat.errors.is_empty(){return Err(cat.errors.join("; ").into());}
            let parser=Parser::new(&cat);
            let mut wav=hound::WavReader::open(&args[3])?;let spec=wav.spec();
            if spec.channels!=1||spec.bits_per_sample!=16||spec.sample_format!=hound::SampleFormat::Int{return Err("Expected mono PCM16 WAV".into());}
            let block=args.get(4).map(|s|s.parse()).transpose()?.unwrap_or(512);
            let mut blocks=Blocks::new(block)?;let mut engine=Vosk::new(Path::new(&args[1]),path,spec.sample_rate,&parser.grammar())?;
            let mut gate=Gate::default();let mut previous=String::new();let mut tail=Vec::new();
            for sample in wav.samples::<i16>(){
                let sample=sample?;tail.push(sample);
                if let Some(pcm)=blocks.push(sample){tail.clear();let (finalized,text)=engine.feed(&pcm)?;print_result(&parser,&mut gate,&mut previous,finalized,&text);}
            }
            if !tail.is_empty(){let (finalized,text)=engine.feed(&tail)?;print_result(&parser,&mut gate,&mut previous,finalized,&text);}
            let text=engine.finish()?;print_result(&parser,&mut gate,&mut previous,true,&text);
        },
        #[cfg(windows)]
        Some("microphone") if (3..=6).contains(&args.len())=>microphone(&args)?,
        _=>{println!("Native prototype — NO keyboard or mouse injection.\nverify-model ARCHIVE\nextract-model ARCHIVE NEW_DIR\nparse TEXT\nrecognize-wav DLL MODEL_DIR WAV [BLOCK=512] [CONFIG]\nmicrophone DLL MODEL_DIR [SECONDS=15] [BLOCK=512] [DEVICE_NAME]");}
    }
    Ok(())
}
fn print_result(parser:&Parser,gate:&mut Gate,previous:&mut String,finalized:bool,text:&str){
    if finalized||text!=previous{println!("{}: {} => {:?}",if finalized{"final"}else{"partial"},text,gate.read(parser,text,finalized));let _=std::io::stdout().flush();}
    previous.clear();previous.push_str(text);
    if finalized{gate.reset();previous.clear();}
}
#[cfg(windows)]
fn microphone(args:&[String])->Result<(),Box<dyn std::error::Error>>{
    use cpal::traits::{DeviceTrait,HostTrait,StreamTrait};
    use cpal::SampleFormat;
    use std::{sync::mpsc::{sync_channel,TrySendError},time::{Duration,Instant},sync::{Arc,atomic::{AtomicBool,Ordering}}};
    let host=cpal::default_host();
    let device=if let Some(name)=args.get(5){host.input_devices()?.find(|d|d.name().ok().as_ref()==Some(name)).ok_or("Input device not found")?}else{host.default_input_device().ok_or("No default input device")?};
    let supported=device.default_input_config()?;let format=supported.sample_format();let config:cpal::StreamConfig=supported.into();
    let rate=config.sample_rate.0;let channels=usize::from(config.channels);
    if channels==0{return Err("Invalid channel count".into());}
    let seconds:u64=args.get(3).map(|s|s.parse()).transpose()?.unwrap_or(15);
    if !(1..=300).contains(&seconds){return Err("Seconds must be 1..300".into());}
    let size=args.get(4).map(|s|s.parse()).transpose()?.unwrap_or(512);
    let path=Path::new(&args[2]);let words=model::read_words(path)?;let cat=catalog::resolve(&Config::default(),Some(&words));let parser=Parser::new(&cat);
    let mut engine=Vosk::new(Path::new(&args[1]),path,rate,&parser.grammar())?;
    let (tx,rx)=sync_channel::<Vec<i16>>(16);let failure=Arc::new(AtomicBool::new(false));
    // Bounded queue; on overflow/device failure stop, never silently process stale speech.
    let flag=failure.clone();let err=move |e|{eprintln!("Audio error: {e}");flag.store(true,Ordering::Release);};
    let mut blocks=Blocks::new(size)?;let flag=failure.clone();
    let mut push=move |sample:i16|{if let Some(block)=blocks.push(sample){if let Err(TrySendError::Full(_)|TrySendError::Disconnected(_))=tx.try_send(block){flag.store(true,Ordering::Release);}}};
    let stream=match format{
        SampleFormat::F32=>device.build_input_stream(&config,move |data:&[f32],_|{for frame in data.chunks_exact(channels){push(voice_invoker_native::audio::mono_f32(frame));}},err,None)?,
        SampleFormat::I16=>device.build_input_stream(&config,move |data:&[i16],_|{for frame in data.chunks_exact(channels){push((frame.iter().map(|v|i64::from(*v)).sum::<i64>()/channels as i64) as i16);}},err,None)?,
        SampleFormat::U16=>device.build_input_stream(&config,move |data:&[u16],_|{for frame in data.chunks_exact(channels){push((frame.iter().map(|v|i64::from(*v)-32768).sum::<i64>()/channels as i64) as i16);}},err,None)?,
        _=>return Err(format!("Unsupported microphone format: {format:?}").into()),
    };
    println!("Microphone: {} / {} Hz / {} channels / {} samples. Test only.",device.name()?,rate,channels,size);
    stream.play()?;let start=Instant::now();let mut gate=Gate::default();let mut previous=String::new();
    while start.elapsed()<Duration::from_secs(seconds){
        if failure.load(Ordering::Acquire){return Err("Capture failed or queue overflow".into());}
        if let Ok(pcm)=rx.recv_timeout(Duration::from_millis(100)){let (finalized,text)=engine.feed(&pcm)?;print_result(&parser,&mut gate,&mut previous,finalized,&text);}
    }
    drop(stream);if failure.load(Ordering::Acquire){return Err("Capture failed".into());}
    let text=engine.finish()?;print_result(&parser,&mut gate,&mut previous,true,&text);Ok(())
}
