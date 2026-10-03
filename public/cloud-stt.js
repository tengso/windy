import { createSegmenter } from './transcriber.js';

export const CLOUD_MODELS = { openai: 'gpt-live-transcribe', qwen: 'qwen3-asr-flash-realtime' };
export const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
export const OPENAI_CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';
export const KEY_PROTOCOL_PREFIX = 'windy-key.';
const OPENAI_RATE = 24000;
const CLOSE_TIMEOUT_MS = 6000;

let nextEventId = 0;
const eventId = () => `windy_${Date.now().toString(36)}_${nextEventId++}`;

export function resample(samples, from, to) {
  if (from === to) return samples;
  const out = new Float32Array(Math.round(samples.length * to / from));
  const ratio = from / to;
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio;
    const j = Math.floor(x);
    const a = samples[j] ?? 0;
    const b = samples[j + 1] ?? a;
    out[i] = a + (b - a) * (x - j);
  }
  return out;
}

export function pcm16Base64(samples) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function openaiSession(model = CLOUD_MODELS.openai) {
  return {
    type: 'transcription',
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: OPENAI_RATE },
        transcription: { model },
        turn_detection: null,
      },
    },
  };
}

export function qwenSession() {
  return {
    input_audio_format: 'pcm',
    sample_rate: 16000,
    turn_detection: { type: 'server_vad', threshold: 0.2, silence_duration_ms: 800 },
  };
}

// Mints a short-lived OpenAI client secret so the browser can open a transcription session without a server.
export async function openaiClientSecret(apiKey, model, fetchImpl = fetch) {
  const res = await fetchImpl(OPENAI_CLIENT_SECRETS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expires_after: { anchor: 'created_at', seconds: 600 }, session: openaiSession(model) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message ?? `OpenAI returned ${res.status}`);
  const secret = data.value ?? data.client_secret?.value;
  if (!secret) throw new Error('OpenAI did not return a client secret');
  return secret;
}

// One provider WebSocket per audio channel. `open` returns (a promise of) a WebSocket that already carries auth.
function createSocket({ open, onEvent, onError }) {
  const queue = [];
  let ws = null;
  let closed = false;
  const ready = Promise.resolve().then(open).then(socket => {
    ws = socket;
    ws.addEventListener('open', () => queue.splice(0).forEach(m => ws.send(m)));
    ws.addEventListener('message', ({ data }) => {
      if (typeof data !== 'string') return;
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      onEvent(msg);
    });
    ws.addEventListener('close', ({ code, reason }) => {
      if (!closed) onError(new Error(reason || `Connection closed (${code})`));
      closed = true;
    });
    return ws;
  }).catch(err => { closed = true; onError(err); });

  return {
    send(msg) {
      const text = JSON.stringify({ event_id: eventId(), ...msg });
      if (ws?.readyState === 1) ws.send(text);
      else if (!closed) queue.push(text);
    },
    async close() {
      closed = true;
      await ready;
      ws?.close();
    },
    get closed() { return closed; },
  };
}

function waitFor(predicate, ms = CLOSE_TIMEOUT_MS) {
  return new Promise(resolve => {
    const started = Date.now();
    const tick = () => (predicate() || Date.now() - started > ms ? resolve() : setTimeout(tick, 50));
    tick();
  });
}

// OpenAI gpt-live-transcribe has no server VAD, so Windy's own voice detector streams each utterance and commits it.
export function createOpenAIChannel({ channel, sampleRate, model, open, onSpeaking, onInterim, onFinal, onError }) {
  const items = new Map();
  const committed = [];
  let current = null;
  let failed = false;
  const fail = err => { if (!failed) { failed = true; onError(err); } };

  const itemFor = id => {
    if (!items.has(id)) {
      const utterance = committed.find(u => !u.id) ?? current;
      if (!utterance) return null;
      utterance.id = id;
      items.set(id, utterance);
    }
    return items.get(id);
  };
  const finish = utterance => {
    items.delete(utterance.id);
    committed.splice(committed.indexOf(utterance), 1);
  };

  const socket = createSocket({
    open,
    onError: fail,
    onEvent(msg) {
      if (msg.type === 'error') return fail(new Error(msg.error?.message ?? 'OpenAI transcription error'));
      if (!msg.item_id) return;
      const u = itemFor(msg.item_id);
      if (!u) return;
      if (msg.type === 'conversation.item.input_audio_transcription.delta') {
        u.text += msg.delta ?? '';
        onInterim({ channel, text: u.text.trim(), start: u.start });
      } else if (msg.type === 'conversation.item.input_audio_transcription.completed') {
        if (committed.includes(u)) finish(u);
        onFinal({ channel, text: (msg.transcript ?? u.text).trim(), start: u.start, end: u.end ?? u.start });
      } else if (msg.type === 'conversation.item.input_audio_transcription.failed') {
        console.warn('OpenAI could not transcribe an utterance', msg.error);
        if (committed.includes(u)) finish(u);
        onFinal({ channel, text: '', start: u.start, end: u.end ?? u.start });
      }
    },
  });
  socket.send({ type: 'session.update', session: openaiSession(model) });

  const segmenter = createSegmenter({
    sampleRate,
    onSpeaking,
    onAudio(samples, time) {
      current ??= { id: null, text: '', start: time, end: null };
      socket.send({ type: 'input_audio_buffer.append', audio: pcm16Base64(resample(samples, sampleRate, OPENAI_RATE)) });
    },
    onSegment({ start, end }) {
      if (!current) return;
      Object.assign(current, { start, end });
      committed.push(current);
      current = null;
      socket.send({ type: 'input_audio_buffer.commit' });
    },
    onDiscard() {
      if (current?.id) items.delete(current.id);
      current = null;
      socket.send({ type: 'input_audio_buffer.clear' });
    },
  });

  return {
    push: samples => { if (!failed) segmenter.push(samples); },
    async close() {
      segmenter.flush();
      await waitFor(() => failed || socket.closed || committed.length === 0);
      failed = true;
      await socket.close();
    },
  };
}

// Qwen3-ASR realtime runs its own server VAD, so audio is streamed continuously and the server marks utterances.
export function createQwenChannel({ channel, open, onSpeaking, onInterim, onFinal, onError }) {
  const starts = new Map();
  const ends = new Map();
  let failed = false;
  let finished = false;
  const fail = err => { if (!failed) { failed = true; onError(err); } };

  const socket = createSocket({
    open,
    onError: err => { if (!finished) fail(err); },
    onEvent(msg) {
      const start = starts.get(msg.item_id) ?? 0;
      switch (msg.type) {
        case 'error':
          return fail(new Error(msg.error?.message ?? 'Qwen transcription error'));
        case 'input_audio_buffer.speech_started':
          starts.set(msg.item_id, (msg.audio_start_ms ?? 0) / 1000);
          return onSpeaking(true, (msg.audio_start_ms ?? 0) / 1000);
        case 'input_audio_buffer.speech_stopped':
          ends.set(msg.item_id, (msg.audio_end_ms ?? 0) / 1000);
          return onSpeaking(false);
        case 'conversation.item.input_audio_transcription.text':
          return onInterim({ channel, text: `${msg.text ?? ''}${msg.stash ?? ''}`.trim(), start });
        case 'conversation.item.input_audio_transcription.completed':
        {
          const end = ends.get(msg.item_id) ?? start;
          starts.delete(msg.item_id);
          ends.delete(msg.item_id);
          return onFinal({ channel, text: (msg.transcript ?? '').trim(), start, end });
        }
        case 'conversation.item.input_audio_transcription.failed':
          console.warn('Qwen could not transcribe an utterance', msg.error);
          return onFinal({ channel, text: '', start, end: start });
        case 'session.finished':
          finished = true;
          return undefined;
        default:
          return undefined;
      }
    },
  });
  socket.send({ type: 'session.update', session: qwenSession() });

  return {
    push(samples) {
      if (!failed) socket.send({ type: 'input_audio_buffer.append', audio: pcm16Base64(samples) });
    },
    async close() {
      if (!failed) socket.send({ type: 'session.finish' });
      await waitFor(() => failed || finished || socket.closed);
      finished = true;
      await socket.close();
    },
  };
}
