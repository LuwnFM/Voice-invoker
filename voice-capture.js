// Native AudioContext sample rate; no resampling.
class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(1024);
    this.used = 0;
  }
  process(inputs, outputs) {
    for (const output of outputs) for (const channel of output) channel.fill(0);
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    let offset = 0;
    while (offset < channel.length) {
      const count = Math.min(channel.length - offset, this.block.length - this.used);
      this.block.set(channel.subarray(offset, offset + count), this.used);
      this.used += count;
      offset += count;
      if (this.used === this.block.length) {
        this.port.postMessage(this.block, [this.block.buffer]);
        this.block = new Float32Array(1024);
        this.used = 0;
      }
    }
    return true;
  }
}
registerProcessor('voice-capture', VoiceCapture);
