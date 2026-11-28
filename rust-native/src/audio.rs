// Pure PCM helpers used by offline and microphone paths.
pub fn pcm16(value:f32)->i16{
    if !value.is_finite(){return 0;}
    (value.clamp(-1.0,1.0)*32767.0).round() as i16
}
pub fn mono_f32(frame:&[f32])->i16{
    if frame.is_empty(){return 0;}
    pcm16(frame.iter().sum::<f32>()/frame.len() as f32)
}
#[derive(Debug)]
pub struct Blocks{size:usize,pending:Vec<i16>}
impl Blocks{
    pub fn new(size:usize)->Result<Self,&'static str>{
        if !matches!(size,256|512|1024|2048){return Err("Block size must be 256, 512, 1024 or 2048");}
        Ok(Self{size,pending:Vec::with_capacity(size)})
    }
    pub fn push(&mut self,sample:i16)->Option<Vec<i16>>{
        self.pending.push(sample);
        if self.pending.len()==self.size{Some(std::mem::replace(&mut self.pending,Vec::with_capacity(self.size)))}else{None}
    }
}
