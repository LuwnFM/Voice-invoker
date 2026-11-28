use std::{path::Path,io::Write};
use voice_invoker_native::{catalog,config::Config,recognition::Parser,speech::SpeechSession,model,vosk::Vosk,audio::Blocks};
fn main(){
    if let Err(e)=run(){eprintln!("Voice Invoker native: {e}");
        #[cfg(windows)]
        if std::env::args().nth(1).as_deref()==Some("launch"){voice_invoker_native::launcher::fatal(&e.to_string());}
        std::process::exit(1);}
}
fn run()->Result<(),Box<dyn std::error::Error>>{
    let args:Vec<String>=std::env::args().skip(1).collect();
    match args.first().map(String::as_str){
        Some("verify-model") if args.len()==2=>{model::verify(Path::new(&args[1]))?;println!("V2 SHA-256 OK");},
        Some("extract-model") if args.len()==3||args.len()==4&&args[3]=="--frames-per-chunk=3"=>{
            let path=model::extract_with_options(Path::new(&args[1]),Path::new(&args[2]),args.len()==4)?;println!("{}",path.display());
        },
        Some("parity-jsonl") if args.len()==1=>voice_invoker_native::parity::run()?,
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
            let mut session=SpeechSession::default();let mut previous=String::new();let mut tail=Vec::new();let mut samples=0u64;
            for sample in wav.samples::<i16>(){
                let sample=sample?;tail.push(sample);samples+=1;
                if let Some(pcm)=blocks.push(sample){tail.clear();let (finalized,text)=engine.feed(&pcm)?;print_result(&parser,&mut session,&mut previous,samples.saturating_mul(1000)/u64::from(spec.sample_rate),finalized,&text);}
            }
            if !tail.is_empty(){let (finalized,text)=engine.feed(&tail)?;print_result(&parser,&mut session,&mut previous,samples.saturating_mul(1000)/u64::from(spec.sample_rate),finalized,&text);}
            let text=engine.finish()?;let now=samples.saturating_mul(1000)/u64::from(spec.sample_rate);print_result(&parser,&mut session,&mut previous,now,true,&text);let tail=session.end(&parser,now);if !tail.is_empty(){println!("end: => {tail:?}");}
        },
        Some("init-config") if args.len()==2=>{
            let dir=voice_invoker_native::storage::native_directory()?;
            let store=voice_invoker_native::storage::Store::open(&dir)?;
            // Explicit migration only; never edit the original config.
            let copied=store.migrate(Path::new(&args[1]))?;
            let config=store.load()?;
            println!("{}",serde_json::json!({"copied":copied,"ready":config.is_some()}));
        },
        Some("gsi-install") if args.len()==3=>{
            let config=Config::load(Path::new(&args[2]))?;
            let dir=voice_invoker_native::storage::native_directory()?;
            println!("{:?}",voice_invoker_native::integration::install(Path::new(&args[1]),&dir,&config)?);
        },
        Some("gsi-remove") if args.len()==1=>{
            let dir=voice_invoker_native::storage::native_directory()?;
            println!("{:?}",voice_invoker_native::integration::remove(&dir)?);
        },
        Some("inspect-steam") if (2..=3).contains(&args.len())=>{
            let steam=Path::new(&args[1]);
            let active=args.get(2).map(|s|s.parse()).transpose()?;
            let status=voice_invoker_native::steam::inspect(steam,active);
            println!("{}",serde_json::json!({"dotaFound":voice_invoker_native::steam::discover_dota(steam,None).is_some(),"savedLaunchFlag":status.launch_flag,"bindingFileFound":status.binding_file.as_ref().is_some_and(|p|p.is_file()),"bindingsAvailable":status.bindings.is_some(),"bindingsIssue":status.issue}));
        },
        Some("watch-binds") if (2..=3).contains(&args.len())=>{
            let seconds=args.get(2).map(|s|s.parse()).transpose()?.unwrap_or(15);
            voice_invoker_native::binding_watch::monitor(Path::new(&args[1]),seconds)?;
        },
        Some("gsi-monitor") if (2..=3).contains(&args.len())=>{
            let cfg=Config{port:args[1].parse()?,..Config::default()};
            let seconds=args.get(2).map(|s|s.parse()).transpose()?.unwrap_or(15);
            voice_invoker_native::gsi_server::monitor(&cfg,seconds)?;
        },
        #[cfg(windows)]
        Some("check-install") if args.len()==1=>{let exe=std::env::current_exe()?;voice_invoker_native::launcher::verify_install(exe.parent().ok_or("Missing application directory")?)?;},
        #[cfg(windows)]
        Some("launch") if args.iter().skip(1).all(|s|s=="--live"||s=="--dota")=>voice_invoker_native::launcher::launch(args.iter().any(|s|s=="--live"),args.iter().any(|s|s=="--dota"))?,
        #[cfg(windows)]
        Some("session") if (4..=6).contains(&args.len())=>{
            let config=Config::load(Path::new(&args[3]))?;
            let live=args.iter().skip(4).any(|s|s=="--live");
            let seconds=args.iter().skip(4).find(|s|s.as_str()!="--live").map(|s|s.parse()).transpose()?.unwrap_or(300);
            if voice_invoker_native::desktop::run(Path::new(&args[1]),Path::new(&args[2]),config,Path::new(&args[3]),live,seconds,false)?{std::process::Command::new(std::env::current_exe()?).args(std::env::args_os().skip(1)).spawn()?;}
        },
        #[cfg(windows)]
        Some("shell-smoke") if args.len()==1=>voice_invoker_native::shell::smoke()?,
        #[cfg(windows)]
        Some("hook-smoke") if args.len()==1=>voice_invoker_native::win_input::smoke()?,
        #[cfg(windows)]
        Some("microphone") if (3..=7).contains(&args.len())=>microphone(&args)?,
        _=>{println!("Native prototype — dry run by default; session --live enables experimental game input.\nverify-model ARCHIVE\nextract-model ARCHIVE NEW_DIR\nparse TEXT\ngsi-monitor PORT [SECONDS=15]\nsession DLL MODEL_DIR CONFIG [SECONDS=300] [--live] (Windows; experimental)\nhook-smoke (Windows, observe only)\nrecognize-wav DLL MODEL_DIR WAV [BLOCK=512] [CONFIG]\nmicrophone DLL MODEL_DIR [SECONDS=15] [BLOCK=512] [DEVICE_NAME] [--rate=16000|48000|auto]");}
    }
    Ok(())
}
fn print_result(parser:&Parser,session:&mut SpeechSession,previous:&mut String,now:u64,finalized:bool,text:&str){
    let commands=session.observe(parser,now,text,finalized);
    if finalized||text!=previous||!commands.is_empty(){println!("{}: {} => {:?}",if finalized{"final"}else{"partial"},text,commands);let _=std::io::stdout().flush();}
    previous.clear();if !finalized{previous.push_str(text);}
}
#[cfg(windows)]
fn microphone(args:&[String])->Result<(),Box<dyn std::error::Error>>{
    use cpal::traits::{DeviceTrait,HostTrait,StreamTrait};
    use cpal::SampleFormat;
    use std::{sync::mpsc::{sync_channel,TrySendError},time::{Duration,Instant},sync::{Arc,atomic::{AtomicBool,Ordering}}};
    let rate_arg=args.iter().skip(3).find_map(|s|s.strip_prefix("--rate="));
    let requested=match rate_arg{None|Some("auto")=>None,Some("16000")=>Some(16000),Some("48000")=>Some(48000),_=>return Err("Rate must be auto, 16000 or 48000".into())};
    let args:Vec<_>=args.iter().filter(|s|!s.starts_with("--rate=")).cloned().collect();
    let host=cpal::default_host();
    let device=if let Some(name)=args.get(5){host.input_devices()?.find(|d|d.name().ok().as_ref()==Some(name)).ok_or("Input device not found")?}else{host.default_input_device().ok_or("No default input device")?};
    let default=device.default_input_config()?;
    let supported=if let Some(rate)=requested{
        let selected=device.supported_input_configs()?.filter(|r|r.min_sample_rate().0<=rate&&r.max_sample_rate().0>=rate&&matches!(r.sample_format(),SampleFormat::F32|SampleFormat::I16|SampleFormat::U16))
            .min_by_key(|r|(r.sample_format()!=default.sample_format(),r.channels()!=default.channels()));
        match selected{
            Some(range)=>range.with_sample_rate(cpal::SampleRate(rate)),
            None=>{eprintln!("Requested {rate} Hz unsupported by device; using default {} Hz",default.sample_rate().0);default}
        }
    }else{default};
    let format=supported.sample_format();let config:cpal::StreamConfig=supported.into();
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
    stream.play()?;let start=Instant::now();let mut session=SpeechSession::default();let mut previous=String::new();
    while start.elapsed()<Duration::from_secs(seconds){
        if failure.load(Ordering::Acquire){return Err("Capture failed or queue overflow".into());}
        if let Ok(pcm)=rx.recv_timeout(Duration::from_millis(100)){let (finalized,text)=engine.feed(&pcm)?;print_result(&parser,&mut session,&mut previous,start.elapsed().as_millis() as u64,finalized,&text);}
    }
    drop(stream);if failure.load(Ordering::Acquire){return Err("Capture failed".into());}
    let text=engine.finish()?;let now=start.elapsed().as_millis() as u64;print_result(&parser,&mut session,&mut previous,now,true,&text);let _=session.end(&parser,now);Ok(())
}
