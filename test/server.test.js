import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createWindyServer } from '../server.js';

let server, base, dir;
const saved = [];
let onSaved = () => {};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'windy-'));
  server = createWindyServer({
    recordingsDir: dir,
    log: msg => { if (msg.startsWith('saved')) { saved.push(msg); onSaved(); } },
  });
  await new Promise(r => server.listen(0, r));
  base = `localhost:${server.address().port}`;
});

after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

test('serves the recorder page', async () => {
  const res = await fetch(`http://${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Windy/);
});

test('rejects paths outside public/', async () => {
  const res = await fetch(`http://${base}/%2e%2e/server.js`);
  assert.notEqual(res.status, 200);
});

test('streams PCM over /ingest into a WAV file', async () => {
  const ws = new WebSocket(`ws://${base}/ingest?sampleRate=16000&channels=2`);
  await new Promise(r => ws.on('open', r));
  const chunk = Buffer.alloc(16000 * 2 * 2 / 10, 1);
  for (let i = 0; i < 5; i++) ws.send(chunk);
  const done = new Promise(r => { onSaved = r; });
  ws.close();
  await done;

  const list = await (await fetch(`http://${base}/api/recordings`)).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].bytes, 44 + chunk.length * 5);

  const wav = readFileSync(join(dir, list[0].name));
  assert.equal(wav.readUInt32LE(40), chunk.length * 5);
  assert.equal(wav.readUInt32LE(24), 16000);

  const dl = await fetch(`http://${base}/recordings/${encodeURIComponent(list[0].name)}`);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'audio/wav');
});
