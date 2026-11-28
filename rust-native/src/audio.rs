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

/// Optional pure Rust RNNoise pipeline. Only use on the DSP worker, not a WASAPI callback.
pub struct NoiseReducer{
    state:Box<nnnoiseless::DenoiseState<'static>>,
    input:[f32;480],output:[f32;480],used:usize,first:bool,rate:RateConverter,
}
impl NoiseReducer{
    pub fn new(output_rate:u32)->Result<Self,&'static str>{
        Ok(Self{state:nnnoiseless::DenoiseState::new(),input:[0.0;480],output:[0.0;480],used:0,first:true,rate:RateConverter::new(48000,output_rate)?})
    }
    pub fn push(&mut self,pcm:&[i16],mut emit:impl FnMut(i16)){
        for &sample in pcm{
            self.input[self.used]=f32::from(sample);self.used+=1;
            if self.used==480{
                self.state.process_frame(&mut self.output,&self.input);self.used=0;
                if self.first{self.first=false;continue;}
                for &v in &self.output{
                    let v=if v.is_finite(){v.round().clamp(-32768.0,32767.0) as i16}else{0};
                    self.rate.push(v,&mut emit);
                }
            }
        }
    }
}
#[cfg(test)]
mod noise_tests{
    use super::*;
    #[test]
    fn rnnoise_framing_keeps_rate_and_discards_first_frame(){
        let mut nr=NoiseReducer::new(16000).unwrap();let mut out=Vec::new();
        for _ in 0..100{nr.push(&[0;480],|v|out.push(v));}
        assert_eq!(out.len(),99*160);assert!(out.iter().all(|v|v.abs()<10));
    }
}
