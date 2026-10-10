// Audio never leaves memory. Batch small render quanta to reduce message overhead.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.samples = new Float32Array(2048); this.used = 0;
    this.port.onmessage = event => {
      if (event.data === 'stop') {
        if (this.used) this.port.postMessage(this.samples.slice(0, this.used));
        this.samples.fill(0); this.used = 0; this.port.postMessage('stopped');
        this.stopped = true;
      }
    };
  }
  process(inputs) {
    if (this.stopped) return false;
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (const sample of input) {
      this.samples[this.used++] = sample;
      if (this.used === this.samples.length) {
        this.port.postMessage(this.samples); this.samples.fill(0); this.used = 0;
      }
    }
    return true;
  }
}
registerProcessor('haze-pcm-capture', PcmCapture);
