const SAMPLE_RATE = 16000;
const CHANNELS = 2;

const $ = id => document.getElementById(id);
const startBtn = $('start');
const stopBtn = $('stop');
const micBox = $('mic');
const statusEl = $('status');
const modeEl = $('mode');
const serverOverride = new URLSearchParams(location.search).get('server');

let mode = serverOverride ? 'remote' : 'local';
let session = null;
const localRecordings = [];

function setStatus(text) { statusEl.textContent = text; }

function ingestUrl() {
  const base = serverOverride ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ingest`;
  return `${base}?sampleRate=${SAMPLE_RATE}&channels=${CHANNELS}`;
}

async function detectMode() {
  if (serverOverride) return 'remote';
  try {
    const res = await fetch('api/recordings');
    return res.ok ? 'server' : 'local';
  } catch {
    return 'local';
  }
}

function describeMode() {
  modeEl.textContent = {
    server: 'Recordings are streamed to this server and saved there.',
    remote: `Recordings are streamed to ${serverOverride}.`,
    local: 'Browser-only mode: recordings stay on this computer. Download them before closing the tab.',
  }[mode];
}

async function captureMeetingTab() {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: { suppressLocalAudioPlayback: false },
    preferCurrentTab: false,
    selfBrowserSurface: 'exclude',
    displaySurface: 'browser',
    surfaceSwitching: 'include',
    systemAudio: 'exclude',
  });
  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach(t => t.stop());
    throw new Error('No tab audio. Pick a Chrome tab and keep "Also share tab audio" ticked.');
  }
  stream.getVideoTracks().forEach(t => t.stop());
  return stream;
}

async function captureMic() {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    console.warn('Microphone unavailable, recording meeting audio only', err);
    return null;
  }
}

function socketSink(onClosed) {
  const ws = new WebSocket(ingestUrl());
  ws.binaryType = 'arraybuffer';
  const pending = [];
  ws.addEventListener('open', () => { pending.splice(0).forEach(b => ws.send(b)); });
  ws.addEventListener('close', onClosed);
  return {
    write(buf) {
      if (ws.readyState === WebSocket.OPEN) ws.send(buf);
      else if (ws.readyState === WebSocket.CONNECTING) pending.push(buf);
    },
    close() {
      ws.removeEventListener('close', onClosed);
      ws.close();
    },
  };
}

function wavHeader(dataBytes) {
  const blockAlign = CHANNELS * 2;
  const view = new DataView(new ArrayBuffer(44));
  const ascii = (offset, s) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  return view.buffer;
}

function localSink() {
  const chunks = [];
  let bytes = 0;
  const startedAt = new Date();
  return {
    write(buf) { chunks.push(buf); bytes += buf.byteLength; },
    close() {
      const blob = new Blob([wavHeader(bytes), ...chunks], { type: 'audio/wav' });
      const name = `${startedAt.toISOString().replace(/[:.]/g, '-')}.wav`;
      localRecordings.unshift({ name, bytes: blob.size, href: URL.createObjectURL(blob) });
    },
  };
}

async function start() {
  startBtn.disabled = true;
  setStatus('Choose the meeting tab…');
  try {
    const tabStream = await captureMeetingTab();
    const micStream = micBox.checked ? await captureMic() : null;

    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    await ctx.audioWorklet.addModule('pcm-worklet.js');
    const merger = ctx.createChannelMerger(CHANNELS);
    ctx.createMediaStreamSource(tabStream).connect(merger, 0, 0);
    if (micStream) ctx.createMediaStreamSource(micStream).connect(merger, 0, 1);
    const node = new AudioWorkletNode(ctx, 'pcm', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: CHANNELS,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
    });
    merger.connect(node);

    const sink = mode === 'local' ? localSink() : socketSink(() => stop('Server connection closed'));
    let seconds = 0;
    node.port.onmessage = ({ data }) => {
      sink.write(data.pcm);
      seconds += data.pcm.byteLength / (SAMPLE_RATE * CHANNELS * 2);
      $('lvl-tab').value = data.peak[0];
      $('lvl-mic').value = data.peak[1];
      setStatus(`Recording… ${seconds.toFixed(0)} s`);
    };

    tabStream.getAudioTracks()[0].addEventListener('ended', () => stop());
    session = { ctx, sink, streams: [tabStream, micStream].filter(Boolean) };
    stopBtn.disabled = false;
    setStatus(micStream ? 'Recording…' : 'Recording (meeting audio only)…');
  } catch (err) {
    startBtn.disabled = false;
    setStatus(err.name === 'NotAllowedError' ? 'Sharing cancelled' : `Error: ${err.message}`);
  }
}

async function stop(reason = 'Stopped') {
  if (!session) return;
  const { ctx, sink, streams } = session;
  session = null;
  streams.forEach(s => s.getTracks().forEach(t => t.stop()));
  await ctx.close();
  sink.close();
  $('lvl-tab').value = 0;
  $('lvl-mic').value = 0;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus(reason);
  if (mode === 'server') setTimeout(refreshRecordings, 500);
  else refreshRecordings();
}

async function listRecordings() {
  if (mode === 'local') return localRecordings;
  if (mode === 'remote') return [];
  const res = await fetch('api/recordings');
  if (!res.ok) return [];
  return (await res.json()).map(r => ({ ...r, href: `recordings/${encodeURIComponent(r.name)}` }));
}

async function refreshRecordings() {
  const list = $('recordings');
  try {
    const items = await listRecordings();
    list.replaceChildren(...items.map(({ name, bytes, href }) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = href;
      a.download = name;
      a.textContent = `${name} (${(bytes / 1024).toFixed(0)} KB)`;
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'none';
      audio.src = href;
      li.append(a, audio);
      return li;
    }));
  } catch {
    list.replaceChildren();
  }
}

startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', () => stop());
mode = await detectMode();
describeMode();
refreshRecordings();
