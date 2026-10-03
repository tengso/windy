import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createOpenAIChannel, createQwenChannel, openaiClientSecret, openaiSession, pcm16Base64, resample,
} from '../public/cloud-stt.js';

class FakeSocket extends EventTarget {
  constructor() {
    super();
    this.readyState = 0;
    this.sent = [];
    setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }, 0);
  }
  send(text) { this.sent.push(JSON.parse(text)); this.onSend?.(JSON.parse(text)); }
  emit(msg) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(msg) })); }
  close() { this.readyState = 3; this.dispatchEvent(new CloseEvent('close', { code: 1000 })); }
}

const tick = () => new Promise(r => setTimeout(r, 5));
const tone = (n, amp = 0.2) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin(i / 5));

test('resamples 16 kHz to 24 kHz and encodes little-endian PCM16', () => {
  const out = resample(Float32Array.from([0, 1, 0, -1]), 16000, 24000);
  assert.equal(out.length, 6);
  assert.equal(out[0], 0);
  assert.ok(Math.abs(out[3] - 0) < 1e-6 || out[3] <= 1);
  const bytes = Buffer.from(pcm16Base64(Float32Array.from([0, 1, -1, 2])), 'base64');
  assert.deepEqual([...new Int16Array(bytes.buffer, bytes.byteOffset, 4)], [0, 32767, -32767, 32767]);
});

test('builds the documented OpenAI transcription session', () => {
  assert.deepEqual(openaiSession('gpt-live-transcribe'), {
    type: 'transcription',
    audio: { input: { format: { type: 'audio/pcm', rate: 24000 }, transcription: { model: 'gpt-live-transcribe' }, turn_detection: null } },
  });
});

test('mints an OpenAI client secret with a transcription session', async () => {
  let request;
  const secret = await openaiClientSecret('sk-test', 'gpt-live-transcribe', async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ value: 'ek_123' }), { status: 200 });
  });
  assert.equal(secret, 'ek_123');
  assert.equal(request.url, 'https://api.openai.com/v1/realtime/client_secrets');
  assert.equal(request.init.headers.Authorization, 'Bearer sk-test');
  assert.equal(JSON.parse(request.init.body).session.type, 'transcription');
  await assert.rejects(
    openaiClientSecret('bad', 'm', async () => new Response(JSON.stringify({ error: { message: 'Incorrect API key' } }), { status: 401 })),
    /Incorrect API key/,
  );
});

test('OpenAI channel streams utterances, commits them, and maps deltas to transcript lines', async () => {
  const socket = new FakeSocket();
  const interim = [];
  const finals = [];
  socket.onSend = msg => {
    if (msg.type === 'input_audio_buffer.append' && !socket.delta) {
      socket.delta = true;
      setTimeout(() => socket.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: 'Hello' }), 0);
    }
    if (msg.type === 'input_audio_buffer.commit') {
      setTimeout(() => socket.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'Hello there.' }), 0);
    }
  };
  const ch = createOpenAIChannel({
    channel: 1,
    sampleRate: 16000,
    model: 'gpt-live-transcribe',
    open: () => socket,
    onSpeaking: () => {},
    onInterim: line => interim.push(line),
    onFinal: line => finals.push(line),
    onError: err => assert.fail(err),
  });
  for (let i = 0; i < 5; i++) ch.push(new Float32Array(1600));
  for (let i = 0; i < 10; i++) { ch.push(tone(1600)); await tick(); }
  for (let i = 0; i < 8; i++) ch.push(new Float32Array(1600));
  await ch.close();

  const types = socket.sent.map(m => m.type);
  assert.equal(types[0], 'session.update');
  assert.equal(types.filter(t => t === 'input_audio_buffer.commit').length, 1);
  const append = socket.sent.find(m => m.type === 'input_audio_buffer.append');
  assert.equal(Buffer.from(append.audio, 'base64').length, 1600 * 1.5 * 2);
  assert.deepEqual(interim[0], { channel: 1, text: 'Hello', start: 0.3 });
  assert.equal(finals.length, 1);
  assert.equal(finals[0].channel, 1);
  assert.equal(finals[0].text, 'Hello there.');
  assert.ok(finals[0].start >= 0.29 && finals[0].start < 0.5);
  assert.ok(finals[0].end > finals[0].start);
});

test('OpenAI channel clears too-short noise instead of committing it', async () => {
  const socket = new FakeSocket();
  const ch = createOpenAIChannel({
    channel: 0, sampleRate: 16000, model: 'm', open: () => socket,
    onSpeaking: () => {}, onInterim: () => {}, onFinal: () => {}, onError: err => assert.fail(err),
  });
  ch.push(tone(1600));
  for (let i = 0; i < 8; i++) ch.push(new Float32Array(1600));
  await tick();
  await ch.close();
  const types = socket.sent.map(m => m.type);
  assert.ok(types.includes('input_audio_buffer.clear'));
  assert.ok(!types.includes('input_audio_buffer.commit'));
});

test('Qwen channel streams all audio and uses server VAD events', async () => {
  const socket = new FakeSocket();
  socket.onSend = msg => {
    if (msg.type === 'session.finish') setTimeout(() => socket.emit({ type: 'session.finished' }), 0);
  };
  const speaking = [];
  const interim = [];
  const finals = [];
  const ch = createQwenChannel({
    channel: 0,
    open: () => socket,
    onSpeaking: (s, t) => speaking.push([s, t]),
    onInterim: line => interim.push(line),
    onFinal: line => finals.push(line),
    onError: err => assert.fail(err),
  });
  ch.push(new Float32Array(1600));
  ch.push(tone(1600));
  await tick();
  socket.emit({ type: 'input_audio_buffer.speech_started', item_id: 'q', audio_start_ms: 120 });
  socket.emit({ type: 'conversation.item.input_audio_transcription.text', item_id: 'q', text: '今天', stash: '天气' });
  socket.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'q', audio_end_ms: 2400 });
  socket.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'q', transcript: '今天天气不错。' });
  await ch.close();

  const session = socket.sent[0];
  assert.equal(session.type, 'session.update');
  assert.ok(session.event_id);
  assert.deepEqual(session.session, {
    input_audio_format: 'pcm', sample_rate: 16000, turn_detection: { type: 'server_vad', threshold: 0.2, silence_duration_ms: 800 },
  });
  assert.equal(socket.sent.filter(m => m.type === 'input_audio_buffer.append').length, 2);
  assert.equal(socket.sent.at(-1).type, 'session.finish');
  assert.deepEqual(speaking, [[true, 0.12], [false, undefined]]);
  assert.deepEqual(interim, [{ channel: 0, text: '今天天气', start: 0.12 }]);
  assert.deepEqual(finals, [{ channel: 0, text: '今天天气不错。', start: 0.12, end: 2.4 }]);
});

test('provider errors are reported once', async () => {
  const socket = new FakeSocket();
  const errors = [];
  const ch = createQwenChannel({
    channel: 0, open: () => socket, onSpeaking: () => {}, onInterim: () => {}, onFinal: () => {},
    onError: err => errors.push(err.message),
  });
  await tick();
  socket.emit({ type: 'error', error: { message: 'Invalid API-key provided.' } });
  socket.close();
  await ch.close();
  assert.deepEqual(errors, ['Invalid API-key provided.']);
});
