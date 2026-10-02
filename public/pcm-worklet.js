const BATCH_SECONDS = 0.1;

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.frames = 0;
    this.peak = [0, 0];
  }

  process([input]) {
    const left = input[0];
    if (!left) return true;
    const right = input[1] ?? left;
    const out = new Int16Array(left.length * 2);
    for (let i = 0; i < left.length; i++) {
      const l = Math.max(-1, Math.min(1, left[i]));
      const r = Math.max(-1, Math.min(1, right[i]));
      out[2 * i] = l * 0x7fff;
      out[2 * i + 1] = r * 0x7fff;
      this.peak[0] = Math.max(this.peak[0], Math.abs(l));
      this.peak[1] = Math.max(this.peak[1], Math.abs(r));
    }
    this.chunks.push(out);
    this.frames += left.length;

    if (this.frames >= sampleRate * BATCH_SECONDS) {
      const pcm = new Int16Array(this.frames * 2);
      let offset = 0;
      for (const c of this.chunks) { pcm.set(c, offset); offset += c.length; }
      this.port.postMessage({ pcm: pcm.buffer, peak: this.peak }, [pcm.buffer]);
      this.chunks = [];
      this.frames = 0;
      this.peak = [0, 0];
    }
    return true;
  }
}

registerProcessor('pcm', PcmProcessor);
