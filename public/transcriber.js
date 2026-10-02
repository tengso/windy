const VOICE_RMS = 0.01;
const END_SILENCE_S = 0.7;
const MAX_SEGMENT_S = 8;
const MIN_VOICE_S = 0.3;
const PRE_ROLL_BATCHES = 2;

// Splits one channel into utterances using a simple energy-based voice detector.
export function createSegmenter({ sampleRate, onSpeaking, onSegment }) {
  let batches = [];
  let preRoll = [];
  let speaking = false;
  let silence = 0;
  let voiced = 0;
  let start = 0;
  let position = 0;

  function emit() {
    const length = batches.reduce((n, b) => n + b.length, 0);
    if (voiced >= MIN_VOICE_S) {
      const audio = new Float32Array(length);
      let offset = 0;
      for (const b of batches) { audio.set(b, offset); offset += b.length; }
      onSegment({ audio, start: start / sampleRate, end: (start + length) / sampleRate });
    }
    batches = [];
    voiced = 0;
    silence = 0;
  }

  return {
    push(samples) {
      const seconds = samples.length / sampleRate;
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      const isVoice = Math.sqrt(sum / samples.length) > VOICE_RMS;

      if (!speaking && isVoice) {
        speaking = true;
        batches = [...preRoll];
        start = position - preRoll.reduce((n, b) => n + b.length, 0);
        onSpeaking(true, start / sampleRate);
      }
      if (speaking) {
        batches.push(samples);
        if (isVoice) { voiced += seconds; silence = 0; } else silence += seconds;
        const length = batches.reduce((n, b) => n + b.length, 0) / sampleRate;
        if (silence >= END_SILENCE_S) {
          emit();
          speaking = false;
          onSpeaking(false);
        } else if (length >= MAX_SEGMENT_S) {
          emit();
          start = position + samples.length;
        }
      }
      preRoll.push(samples);
      if (preRoll.length > PRE_ROLL_BATCHES) preRoll.shift();
      position += samples.length;
    },
    flush() {
      if (speaking) emit();
      if (speaking) onSpeaking(false);
      speaking = false;
      preRoll = [];
    },
  };
}

export function deinterleave(int16, channels) {
  const frames = int16.length / channels;
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) out[c][i] = int16[i * channels + c] / 0x8000;
  }
  return out;
}

// Runs Whisper in a Web Worker; the model is downloaded once and cached by the browser.
export function createWhisperEngine({ onProgress, onReady, onError, onResult }) {
  const worker = new Worker(new URL('whisper-worker.js', import.meta.url), { type: 'module' });
  let nextId = 0;
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') onProgress(data.progress);
    else if (data.type === 'ready') onReady(data.device);
    else if (data.type === 'error') onError(new Error(data.message));
    else if (data.type === 'result') onResult(data);
  };
  worker.onerror = e => onError(new Error(e.message || 'Speech model failed to load'));
  return {
    load() { worker.postMessage({ type: 'load' }); },
    transcribe({ channel, audio, start, end }) {
      const id = nextId++;
      worker.postMessage({ type: 'transcribe', id, channel, audio, start, end }, [audio.buffer]);
      return id;
    },
  };
}
