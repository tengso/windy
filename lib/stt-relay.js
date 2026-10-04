import WebSocket from 'ws';

export const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
export const QWEN_REALTIME_URLS = {
  intl: 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime',
  cn: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
};
export const DEFAULT_MODELS = { openai: 'gpt-live-transcribe', qwen: 'qwen3-asr-flash-realtime' };
export const RELAY_PROTOCOL = 'windy';
export const KEY_PROTOCOL_PREFIX = 'windy-key.';

const CLIENT_EVENTS = new Set([
  'session.update',
  'input_audio_buffer.append',
  'input_audio_buffer.commit',
  'input_audio_buffer.clear',
  'session.finish',
]);

export function clientKey(protocolHeader = '') {
  const entry = protocolHeader.split(',').map(p => p.trim()).find(p => p.startsWith(KEY_PROTOCOL_PREFIX));
  return entry ? entry.slice(KEY_PROTOCOL_PREFIX.length) : null;
}

export function qwenUrl({ base, region, model }) {
  const url = new URL(base ?? QWEN_REALTIME_URLS[region] ?? QWEN_REALTIME_URLS.intl);
  url.searchParams.set('model', model);
  return url.toString();
}

// Pipes provider JSON events between the browser and the provider, adding the Authorization header that browser
// WebSockets cannot send. Only transcription client events are forwarded.
export function relayTranscription(client, { url, apiKey, log = () => {} }) {
  const upstream = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  const pending = [];
  const fail = message => {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify({ type: 'error', error: { message } }));
      client.close(1011, 'upstream error');
    }
  };

  upstream.on('open', () => pending.splice(0).forEach(m => upstream.send(m)));
  upstream.on('message', (data, isBinary) => {
    if (!isBinary && client.readyState === client.OPEN) client.send(data.toString());
  });
  upstream.on('error', err => {
    log(`transcription relay error: ${err.message}`);
    fail(err.message);
  });
  upstream.on('close', () => { if (client.readyState === client.OPEN) client.close(); });

  client.on('message', (data, isBinary) => {
    if (isBinary) return;
    const text = data.toString();
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!CLIENT_EVENTS.has(msg?.type)) return;
    if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
    else if (upstream.readyState === WebSocket.CONNECTING) pending.push(text);
  });
  client.on('close', () => {
    if (upstream.readyState === WebSocket.OPEN) upstream.close();
    else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
  });
  return upstream;
}
