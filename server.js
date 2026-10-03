import { createServer } from 'node:http';
import { createReadStream, createWriteStream, mkdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { extname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { wavHeader, WAV_HEADER_BYTES } from './lib/wav.js';
import { openDeepgram, DEEPGRAM_URL } from './lib/deepgram.js';
import {
  clientKey, qwenUrl, relayTranscription, DEFAULT_MODELS, OPENAI_REALTIME_URL, RELAY_PROTOCOL,
} from './lib/stt-relay.js';

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

export function createWindyServer({
  recordingsDir = join(ROOT, 'recordings'),
  log = console.log,
  deepgramApiKey = process.env.DEEPGRAM_API_KEY,
  deepgramUrl = DEEPGRAM_URL,
  deepgramModel = process.env.DEEPGRAM_MODEL,
  deepgramLanguage = process.env.DEEPGRAM_LANGUAGE,
  openaiApiKey = process.env.OPENAI_API_KEY,
  openaiUrl = process.env.OPENAI_REALTIME_URL ?? OPENAI_REALTIME_URL,
  openaiModel = process.env.OPENAI_TRANSCRIPTION_MODEL ?? DEFAULT_MODELS.openai,
  qwenApiKey = process.env.DASHSCOPE_API_KEY,
  qwenBaseUrl = process.env.QWEN_REALTIME_URL,
  qwenRegion = process.env.QWEN_REGION ?? 'intl',
  qwenModel = process.env.QWEN_TRANSCRIPTION_MODEL ?? DEFAULT_MODELS.qwen,
} = {}) {
  const dir = resolve(recordingsDir);
  mkdirSync(dir, { recursive: true });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({
        transcription: deepgramApiKey ? 'deepgram' : 'browser',
        providers: {
          deepgram: { serverKey: Boolean(deepgramApiKey) },
          openai: { serverKey: Boolean(openaiApiKey), model: openaiModel },
          qwen: { serverKey: Boolean(qwenApiKey), model: qwenModel },
        },
      }));
    }
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

  const ingest = new WebSocketServer({ noServer: true });
  const stt = new WebSocketServer({
    noServer: true,
    handleProtocols: protocols => (protocols.has(RELAY_PROTOCOL) ? RELAY_PROTOCOL : false),
  });
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const wss = { '/ingest': ingest, '/stt': stt }[pathname];
    if (!wss) return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  stt.on('connection', (ws, req) => {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const provider = params.get('provider');
    if (provider !== 'openai' && provider !== 'qwen') return ws.close(4400, 'unknown provider');
    const serverKey = provider === 'openai' ? openaiApiKey : qwenApiKey;
    const apiKey = serverKey || clientKey(req.headers['sec-websocket-protocol']);
    if (!apiKey) {
      ws.send(JSON.stringify({ type: 'error', error: { message: `No ${provider} API key` } }));
      return ws.close(4401, 'missing key');
    }
    const url = provider === 'openai'
      ? openaiUrl
      : qwenUrl({ base: qwenBaseUrl, region: serverKey ? qwenRegion : params.get('region'), model: qwenModel });
    log(`transcription relay (${provider}, ${serverKey ? 'server' : 'browser'} key)`);
    relayTranscription(ws, { url, apiKey, log });
  });

  ingest.on('connection', (ws, req) => {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const sampleRate = Number(params.get('sampleRate')) || 16000;
    const channels = Number(params.get('channels')) || 2;
    const rec = startRecording(dir, sampleRate, channels);
    log(`recording ${rec.name} (${sampleRate} Hz, ${channels} ch)`);
    const relay = msg => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
    const dg = deepgramApiKey && params.get('transcribe') === 'deepgram'
      ? openDeepgram({
        apiKey: deepgramApiKey,
        url: deepgramUrl,
        sampleRate,
        channels,
        model: deepgramModel,
        language: deepgramLanguage,
        onTranscript: relay,
        onError: err => {
          log(`deepgram error: ${err.message}`);
          relay({ type: 'transcript-error', message: err.message });
        },
      })
      : null;

    let finished = null;
    const finish = () => {
      finished ??= Promise.all([rec.finish(), dg?.close()]).then(([{ name, dataBytes }]) => {
        const seconds = dataBytes / (sampleRate * channels * 2);
        log(`saved ${name} (${seconds.toFixed(1)} s)`);
      });
      return finished;
    };

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        rec.write(data);
        dg?.send(data);
        return;
      }
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'stop') finish().then(() => ws.close());
    });
    ws.on('close', finish);
  });

  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8080;
  createWindyServer({ recordingsDir: process.env.RECORDINGS_DIR })
    .listen(port, () => console.log(`windy listening on http://localhost:${port}`));
}
