// All unsafe FFI is contained in this module. The recognizer and model live on
// one thread, and the library remains loaded until both handles are freed.
use libloading::Library;
use std::{ffi::{c_char,c_int,c_void,CStr,CString},path::Path,ptr::NonNull};
type ModelNew=unsafe extern "C" fn(*const c_char)->*mut c_void;
type ModelFree=unsafe extern "C" fn(*mut c_void);
type RecNew=unsafe extern "C" fn(*mut c_void,f32,*const c_char)->*mut c_void;
type RecFree=unsafe extern "C" fn(*mut c_void);
type Accept=unsafe extern "C" fn(*mut c_void,*const i16,c_int)->c_int;
type Reset=unsafe extern "C" fn(*mut c_void);
type ResultFn=unsafe extern "C" fn(*mut c_void)->*const c_char;
pub struct Vosk{
    recognizer:NonNull<c_void>,model:NonNull<c_void>,free_rec:RecFree,free_model:ModelFree,
    accept:Accept,result:ResultFn,partial:ResultFn,final_result:ResultFn,reset:Reset,_library:Library,
}
impl Vosk{
    pub fn new(dll:&Path,model_path:&Path,rate:u32,grammar:&[String])->Result<Self,Box<dyn std::error::Error>>{
        if !(8000..=192000).contains(&rate){return Err("Unsupported sample rate".into());}
        let dll=dll.canonicalize()?;
        let model_path=std::path::absolute(model_path)?;
        if !model_path.is_dir(){return Err("Model directory missing".into());}
        // Vosk's path parameter is a C string; reject paths that cannot be represented.
        let path=CString::new(model_path.to_str().ok_or("Non-UTF8 model path")?)?;
        let grammar=CString::new(serde_json::to_string(grammar)?)?;
        // SAFETY: explicit local library path, signatures taken from vosk_api.h.
        unsafe{
            #[cfg(windows)]
            let library=Library::from(libloading::os::windows::Library::load_with_flags(&dll,0x00000100|0x00001000)?);
            #[cfg(not(windows))]
            let library=Library::new(dll)?;
            let create_model:ModelNew=*library.get(b"vosk_model_new\0")?;
            let free_model:ModelFree=*library.get(b"vosk_model_free\0")?;
            let create_rec:RecNew=*library.get(b"vosk_recognizer_new_grm\0")?;
            let free_rec:RecFree=*library.get(b"vosk_recognizer_free\0")?;
            let accept:Accept=*library.get(b"vosk_recognizer_accept_waveform_s\0")?;
            let result:ResultFn=*library.get(b"vosk_recognizer_result\0")?;
            let partial:ResultFn=*library.get(b"vosk_recognizer_partial_result\0")?;
            let final_result:ResultFn=*library.get(b"vosk_recognizer_final_result\0")?;
            let reset:Reset=*library.get(b"vosk_recognizer_reset\0")?;
            let model=NonNull::new(create_model(path.as_ptr())).ok_or("Vosk model load failed")?;
            let Some(recognizer)=NonNull::new(create_rec(model.as_ptr(),rate as f32,grammar.as_ptr()))else{free_model(model.as_ptr());return Err("Vosk recognizer creation failed".into());};
            Ok(Self{recognizer,model,free_rec,free_model,accept,result,partial,final_result,reset,_library:library})
        }
    }
    fn text(&mut self,f:ResultFn,field:&str)->Result<String,Box<dyn std::error::Error>>{
        // SAFETY: handle valid; copy returned string before another Vosk call.
        let raw=unsafe{f(self.recognizer.as_ptr())};if raw.is_null(){return Err("Null Vosk result".into());}
        let json:serde_json::Value=serde_json::from_slice(unsafe{CStr::from_ptr(raw)}.to_bytes())?;
        Ok(json.get(field).and_then(|s|s.as_str()).unwrap_or("").to_owned())
    }
    pub fn feed(&mut self,pcm:&[i16])->Result<(bool,String),Box<dyn std::error::Error>>{
        let len=c_int::try_from(pcm.len())?;
        let result=unsafe{(self.accept)(self.recognizer.as_ptr(),pcm.as_ptr(),len)};
        match result{0=>Ok((false,self.text(self.partial,"partial")?)),1=>Ok((true,self.text(self.result,"text")?)),_=>Err("Vosk accept failed".into())}
    }
    pub fn reset(&mut self){unsafe{(self.reset)(self.recognizer.as_ptr());}}
    pub fn finish(&mut self)->Result<String,Box<dyn std::error::Error>>{self.text(self.final_result,"text")}
}
impl Drop for Vosk{
    fn drop(&mut self){unsafe{(self.free_rec)(self.recognizer.as_ptr());(self.free_model)(self.model.as_ptr());}}
}
