import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0';

const MODELS = {
  webgpu: { id: 'onnx-community/whisper-base.en', options: { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } } },
  wasm: { id: 'onnx-community/whisper-tiny.en', options: { device: 'wasm' } },
};
const NOISE = /^[\s.,!?-]*$|^\s*[[(*♪].*[\])*♪]\s*$/;

let loading = null;
const queue = [];
let busy = false;

function progress(info) {
  if (info.status === 'progress_total') self.postMessage({ type: 'progress', progress: info.progress / 100 });
}

async function create(device) {
  const { id, options } = MODELS[device];
  return pipeline('automatic-speech-recognition', id, { ...options, progress_callback: progress });
}

async function load() {
  if (navigator.gpu && await navigator.gpu.requestAdapter()) {
    try {
      return { asr: await create('webgpu'), device: 'webgpu' };
    } catch (err) {
      console.warn('WebGPU Whisper failed, falling back to WASM', err);
    }
  }
  return { asr: await create('wasm'), device: 'wasm' };
}

async function drain() {
  if (busy) return;
  busy = true;
  const { asr } = await loading;
  while (queue.length) {
    const { id, channel, start, end, audio } = queue.shift();
    try {
      const { text } = await asr(audio);
      const clean = text.trim();
      self.postMessage({ type: 'result', id, channel, start, end, text: NOISE.test(clean) ? '' : clean, backlog: queue.length });
    } catch (err) {
      self.postMessage({ type: 'result', id, channel, start, end, text: '', backlog: queue.length });
      console.warn('Whisper failed on a segment', err);
    }
  }
  busy = false;
}

self.onmessage = ({ data }) => {
  if (data.type === 'load' || data.type === 'transcribe') {
    loading ??= load().then(
      model => { self.postMessage({ type: 'ready', device: model.device }); return model; },
      err => { self.postMessage({ type: 'error', message: err.message }); throw err; },
    );
  }
  if (data.type === 'transcribe') {
    queue.push(data);
    drain().catch(() => { busy = false; });
  }
};
