import { createServer } from 'node:http';
import { createReadStream, createWriteStream, mkdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { extname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { wavHeader, WAV_HEADER_BYTES } from './lib/wav.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wav': 'audio/wav',
};

function sendFile(res, path) {
  const type = MIME[extname(path)] ?? 'application/octet-stream';
  createReadStream(path)
    .on('error', () => { res.writeHead(404).end('Not found'); })
    .once('open', () => res.writeHead(200, { 'Content-Type': type }))
    .pipe(res);
}

async function listRecordings(dir) {
  const names = (await readdir(dir)).filter(n => n.endsWith('.wav')).sort().reverse();
  return Promise.all(names.map(async name => ({ name, bytes: (await stat(join(dir, name))).size })));
}

function startRecording(dir, sampleRate, channels) {
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}.wav`;
  const path = join(dir, name);
  const out = createWriteStream(path);
  out.write(wavHeader({ sampleRate, channels, dataBytes: 0 }));
  let dataBytes = 0;
  return {
    name,
    write(chunk) { dataBytes += chunk.length; out.write(chunk); },
    finish() {
      return new Promise(done => out.end(() => {
        const fd = openSync(path, 'r+');
        writeSync(fd, wavHeader({ sampleRate, channels, dataBytes }), 0, WAV_HEADER_BYTES, 0);
        closeSync(fd);
        done({ name, dataBytes });
      }));
    },
  };
}

export function createWindyServer({ recordingsDir = join(ROOT, 'recordings'), log = console.log } = {}) {
  const dir = resolve(recordingsDir);
  mkdirSync(dir, { recursive: true });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/recordings') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(await listRecordings(dir)));
    }
    if (url.pathname.startsWith('/recordings/')) {
      return sendFile(res, join(dir, basename(decodeURIComponent(url.pathname))));
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const path = resolve(PUBLIC_DIR, rel);
    if (!path.startsWith(PUBLIC_DIR)) return res.writeHead(403).end('Forbidden');
    sendFile(res, path);
  });

  const wss = new WebSocketServer({ server, path: '/ingest' });
  wss.on('connection', (ws, req) => {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const sampleRate = Number(params.get('sampleRate')) || 16000;
    const channels = Number(params.get('channels')) || 2;
    const rec = startRecording(dir, sampleRate, channels);
    log(`recording ${rec.name} (${sampleRate} Hz, ${channels} ch)`);
    ws.on('message', (data, isBinary) => { if (isBinary) rec.write(data); });
    ws.on('close', async () => {
      const { name, dataBytes } = await rec.finish();
      const seconds = dataBytes / (sampleRate * channels * 2);
      log(`saved ${name} (${seconds.toFixed(1)} s)`);
    });
  });

  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8080;
  createWindyServer({ recordingsDir: process.env.RECORDINGS_DIR })
    .listen(port, () => console.log(`windy listening on http://localhost:${port}`));
}
