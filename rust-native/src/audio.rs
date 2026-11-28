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

// Streaming area-average sample-rate conversion. Downsampling averages the
// input interval (rather than dropping samples); upsampling holds the sample.
// Exact integer phase across callbacks; no sample-count drift or allocation.
pub struct RateConverter {
    input_rate:u64,output_rate:u64,filled:u64,sum:i64,
}
impl RateConverter{
    pub fn new(input:u32,output:u32)->Result<Self,&'static str>{
        if !(8000..=192000).contains(&input)||!(8000..=192000).contains(&output){return Err("Unsupported audio rate");}
        Ok(Self{input_rate:u64::from(input),output_rate:u64::from(output),filled:0,sum:0})
    }
    pub fn push(&mut self,sample:i16,mut emit:impl FnMut(i16)){
        let mut remaining=self.output_rate;
        while remaining>0{
            let take=remaining.min(self.input_rate-self.filled);
            self.sum+=i64::from(sample)*take as i64;self.filled+=take;remaining-=take;
            if self.filled==self.input_rate{
                emit((self.sum/self.input_rate as i64) as i16);self.filled=0;self.sum=0;
            }
        }
    }
}
#[cfg(test)]
mod rate_tests{
    use super::*;
    #[test]
    fn exact_count_and_dc_across_blocks(){
        for (src,dst) in [(48000,16000),(44100,16000),(16000,48000),(48000,48000)]{
            let mut r=RateConverter::new(src,dst).unwrap();let mut out=Vec::new();
            for _ in 0..src{r.push(1234,|v|out.push(v));}
            assert_eq!(out.len(),dst as usize);assert!(out.iter().all(|v|*v==1234));
        }
    }
    #[test]
    fn downsample_averages_and_preserves_partial_interval(){
        let mut r=RateConverter::new(48000,16000).unwrap();let mut out=Vec::new();
        for v in [300,600,900,-300,-600,-900]{r.push(v,|v|out.push(v));}
        assert_eq!(out,vec![600,-600]);
    }
}
