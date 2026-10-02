import WebSocket from 'ws';

export const DEEPGRAM_URL = 'wss://api.deepgram.com/v1/listen';

export function deepgramQuery({ sampleRate, channels, model = 'nova-3', language = 'en' }) {
  return new URLSearchParams({
    model,
    language,
    encoding: 'linear16',
    sample_rate: String(sampleRate),
    channels: String(channels),
    multichannel: 'true',
    interim_results: 'true',
    punctuate: 'true',
    smart_format: 'true',
    endpointing: '300',
  });
}

export function toTranscript(msg) {
  if (msg.type !== 'Results') return null;
  const text = msg.channel?.alternatives?.[0]?.transcript ?? '';
  if (!text && !msg.is_final) return null;
  return {
    type: 'transcript',
    channel: msg.channel_index?.[0] ?? 0,
    text,
    final: Boolean(msg.is_final),
    start: msg.start ?? 0,
    end: (msg.start ?? 0) + (msg.duration ?? 0),
  };
}

export function openDeepgram({ apiKey, url = DEEPGRAM_URL, sampleRate, channels, model, language, onTranscript, onError }) {
  const ws = new WebSocket(`${url}?${deepgramQuery({ sampleRate, channels, model, language })}`, {
    headers: { Authorization: `Token ${apiKey}` },
  });
  const pending = [];
  let closing = false;
  const keepAlive = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }));
  }, 5000);

  ws.on('open', () => {
    pending.splice(0).forEach(b => ws.send(b));
    if (closing) ws.send(JSON.stringify({ type: 'CloseStream' }));
  });
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    const t = toTranscript(msg);
    if (t) onTranscript(t);
  });
  ws.on('error', err => { if (!closing) onError(err); });
  const closed = new Promise(resolve => ws.on('close', () => { clearInterval(keepAlive); resolve(); }));

  return {
    send(buf) {
      if (ws.readyState === WebSocket.OPEN) ws.send(buf);
      else if (ws.readyState === WebSocket.CONNECTING) pending.push(buf);
    },
    close(timeoutMs = 5000) {
      if (!closing) {
        closing = true;
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' }));
        else if (ws.readyState !== WebSocket.CONNECTING) ws.terminate();
      }
      const timer = setTimeout(() => ws.terminate(), timeoutMs);
      return closed.finally(() => clearTimeout(timer));
    },
  };
}
