import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { createWindyServer } from '../server.js';
import { clientKey, qwenUrl } from '../lib/stt-relay.js';

let fake, base, dir;
const servers = [];
const upstream = [];

async function start(options) {
  const server = createWindyServer({ recordingsDir: dir, log: () => {}, ...options });
  await new Promise(r => server.listen(0, r));
  servers.push(server);
  return `localhost:${server.address().port}`;
}

function connect(host, query, protocols = ['windy']) {
  const ws = new WebSocket(`ws://${host}/stt?${query}`, protocols);
  const messages = [];
  ws.on('message', data => messages.push(JSON.parse(data.toString())));
  const closed = new Promise(r => ws.on('close', code => r(code)));
  return { ws, messages, closed, opened: new Promise(r => ws.on('open', r)) };
}

before(async () => {
  fake = new WebSocketServer({ port: 0 });
  fake.on('connection', (ws, req) => {
    const seen = { url: new URL(req.url, 'http://localhost'), auth: req.headers.authorization, events: [] };
    upstream.push(seen);
    ws.on('message', data => {
      const msg = JSON.parse(data.toString());
      seen.events.push(msg.type);
      if (msg.type === 'input_audio_buffer.commit') {
        ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: 'hi' }));
      }
      if (msg.type === 'session.finish') ws.send(JSON.stringify({ type: 'session.finished' }));
    });
  });
  await new Promise(r => fake.on('listening', r));
  dir = mkdtempSync(join(tmpdir(), 'windy-stt-'));
  const fakeUrl = `ws://localhost:${fake.address().port}`;
  base = await start({
    openaiApiKey: 'server-openai',
    openaiUrl: `${fakeUrl}/v1/realtime`,
    qwenApiKey: undefined,
    qwenBaseUrl: `${fakeUrl}/api-ws/v1/realtime`,
    deepgramApiKey: undefined,
  });
});

after(() => {
  servers.forEach(s => s.close());
  fake.close();
  rmSync(dir, { recursive: true, force: true });
});

test('advertises which providers have server keys without exposing them', async () => {
  const res = await fetch(`http://${base}/api/config`);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const config = await res.json();
  assert.deepEqual(config, {
    transcription: 'browser',
    providers: {
      deepgram: { serverKey: false },
      openai: { serverKey: true, model: 'gpt-live-transcribe' },
      qwen: { serverKey: false, model: 'qwen3-asr-flash-realtime' },
    },
  });
  assert.doesNotMatch(JSON.stringify(config), /server-openai/);
});

test('relays OpenAI events with the server key and drops non-transcription events', async () => {
  const before = upstream.length;
  const c = connect(base, 'provider=openai', ['windy', 'windy-key.browser-key']);
  await c.opened;
  assert.equal(c.ws.protocol, 'windy');
  c.ws.send(JSON.stringify({ type: 'session.update', session: { type: 'transcription' } }));
  c.ws.send(JSON.stringify({ type: 'response.create' }));
  c.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: 'AAAA' }));
  c.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
  while (!c.messages.length) await new Promise(r => setTimeout(r, 20));
  c.ws.close();
  await c.closed;

  const seen = upstream[before];
  assert.equal(seen.auth, 'Bearer server-openai');
  assert.equal(seen.url.pathname, '/v1/realtime');
  assert.deepEqual(seen.events, ['session.update', 'input_audio_buffer.append', 'input_audio_buffer.commit']);
  assert.deepEqual(c.messages, [{ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: 'hi' }]);
});

test('uses a browser-supplied key for Qwen when the server has none', async () => {
  const before = upstream.length;
  const c = connect(base, 'provider=qwen&region=cn', ['windy', 'windy-key.sk-user']);
  await c.opened;
  c.ws.send(JSON.stringify({ type: 'session.finish' }));
  while (!c.messages.length) await new Promise(r => setTimeout(r, 20));
  c.ws.close();
  await c.closed;

  const seen = upstream[before];
  assert.equal(seen.auth, 'Bearer sk-user');
  assert.equal(seen.url.pathname, '/api-ws/v1/realtime');
  assert.equal(seen.url.searchParams.get('model'), 'qwen3-asr-flash-realtime');
  assert.deepEqual(c.messages, [{ type: 'session.finished' }]);
});

test('rejects Qwen without any key and unknown providers', async () => {
  const noKey = connect(base, 'provider=qwen');
  assert.equal(await noKey.closed, 4401);
  assert.match(noKey.messages[0].error.message, /No qwen API key/);
  const unknown = connect(base, 'provider=other');
  assert.equal(await unknown.closed, 4400);
});

test('reports upstream failures to the browser', async () => {
  const host = await start({ openaiApiKey: 'k', openaiUrl: 'ws://localhost:1/v1/realtime' });
  const c = connect(host, 'provider=openai');
  assert.equal(await c.closed, 1011);
  assert.equal(c.messages[0].type, 'error');
});

test('parses relay keys and Qwen endpoints', () => {
  assert.equal(clientKey('windy, windy-key.sk-abc_123'), 'sk-abc_123');
  assert.equal(clientKey('windy'), null);
  assert.equal(
    qwenUrl({ region: 'intl', model: 'qwen3-asr-flash-realtime' }),
    'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime',
  );
  assert.equal(
    qwenUrl({ region: 'cn', model: 'm' }),
    'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=m',
  );
  assert.equal(qwenUrl({ region: 'evil.example', model: 'm' }), 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=m');
});
