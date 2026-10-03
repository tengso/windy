import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { createWindyServer } from '../server.js';
import { toTranscript } from '../lib/deepgram.js';

let fake, server, base, dir;
const upstream = { url: null, auth: null, audioBytes: 0, closeStream: false };

before(async () => {
  fake = new WebSocketServer({ port: 0 });
  fake.on('connection', (ws, req) => {
    upstream.url = new URL(req.url, 'http://localhost');
    upstream.auth = req.headers.authorization;
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        upstream.audioBytes += data.length;
        return;
      }
      if (JSON.parse(data.toString()).type !== 'CloseStream') return;
      upstream.closeStream = true;
      ws.send(JSON.stringify({
        type: 'Results',
        channel_index: [1, 2],
        start: 1.5,
        duration: 2,
        is_final: true,
        channel: { alternatives: [{ transcript: 'Hello from the mic.' }] },
      }));
      ws.close();
    });
    ws.send(JSON.stringify({
      type: 'Results',
      channel_index: [0, 2],
      start: 0,
      duration: 1,
      is_final: false,
      channel: { alternatives: [{ transcript: 'hello every' }] },
    }));
  });
  await new Promise(r => fake.on('listening', r));

  dir = mkdtempSync(join(tmpdir(), 'windy-dg-'));
  server = createWindyServer({
    recordingsDir: dir,
    log: () => {},
    deepgramApiKey: 'test-key',
    deepgramUrl: `ws://localhost:${fake.address().port}/v1/listen`,
  });
  await new Promise(r => server.listen(0, r));
  base = `localhost:${server.address().port}`;
});

after(() => {
  server.close();
  fake.close();
  rmSync(dir, { recursive: true, force: true });
});

test('advertises Deepgram when a key is configured', async () => {
  const config = await (await fetch(`http://${base}/api/config`)).json();
  assert.equal(config.transcription, 'deepgram');
  assert.deepEqual(config.providers.deepgram, { serverKey: true });
});

test('relays audio to Deepgram and transcripts back to the browser', async () => {
  const ws = new WebSocket(`ws://${base}/ingest?sampleRate=16000&channels=2&transcribe=deepgram`);
  const messages = [];
  ws.on('message', (data, isBinary) => { if (!isBinary) messages.push(JSON.parse(data.toString())); });
  await new Promise(r => ws.on('open', r));
  const chunk = Buffer.alloc(6400, 1);
  ws.send(chunk);
  ws.send(chunk);
  await new Promise(r => setTimeout(r, 200));
  ws.send(JSON.stringify({ type: 'stop' }));
  await new Promise(r => ws.on('close', r));

  assert.equal(upstream.auth, 'Token test-key');
  assert.equal(upstream.url.searchParams.get('encoding'), 'linear16');
  assert.equal(upstream.url.searchParams.get('sample_rate'), '16000');
  assert.equal(upstream.url.searchParams.get('channels'), '2');
  assert.equal(upstream.url.searchParams.get('multichannel'), 'true');
  assert.equal(upstream.audioBytes, chunk.length * 2);
  assert.ok(upstream.closeStream);
  assert.deepEqual(messages, [
    { type: 'transcript', channel: 0, text: 'hello every', final: false, start: 0, end: 1 },
    { type: 'transcript', channel: 1, text: 'Hello from the mic.', final: true, start: 1.5, end: 3.5 },
  ]);
});

test('ignores non-result and empty interim messages', () => {
  assert.equal(toTranscript({ type: 'Metadata' }), null);
  assert.equal(toTranscript({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: '' }] } }), null);
});
