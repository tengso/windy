const SAMPLE_RATE = 16000;
const CHANNELS = 2;

const $ = id => document.getElementById(id);
const startBtn = $('start');
const stopBtn = $('stop');
const micBox = $('mic');
const statusEl = $('status');
const modeEl = $('mode');
const SPEAKING_THRESHOLD = 0.04;
const HISTORY_LENGTH = 150;
const ICONS = {
  wave: '<svg viewBox="0 0 24 24"><path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
};
const serverOverride = new URLSearchParams(location.search).get('server');

let mode = serverOverride ? 'remote' : 'local';
let session = null;
const localRecordings = [];

const history = { tab: [], mic: [] };

function setStatus(text) { statusEl.textContent = text; }

function setLive(state, text) {
  $('live').dataset.state = state;
  $('live-text').textContent = text;
}

function formatClock(seconds) {
  const s = Math.floor(seconds);
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor(s / 60) % 60).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatDuration(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatSize(bytes) {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function recordingDate(name) {
  const iso = name.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z\.wav$/, 'T$1:$2:$3.$4Z');
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function setTimer(seconds) {
  $('timer').textContent = formatClock(seconds);
  document.title = session ? `● ${formatClock(seconds)} – Windy` : 'Windy – meeting assistant';
}

function setSpeaker(id, level) {
  $(`lvl-${id}`).value = level;
  $(`spk-${id}`).classList.toggle('speaking', level > SPEAKING_THRESHOLD);
}

function drawActivity() {
  const canvas = $('activity');
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, width, height);
  const styles = getComputedStyle(document.documentElement);
  const mid = height / 2;
  const step = width / HISTORY_LENGTH;
  const barWidth = Math.max(1, step * 0.6);
  g.fillStyle = styles.getPropertyValue('--line');
  g.fillRect(0, mid - 0.5, width, 1);
  const bars = (values, color, direction) => {
    g.fillStyle = color;
    const offset = HISTORY_LENGTH - values.length;
    values.forEach((v, i) => {
      const h = Math.max(1, Math.sqrt(v) * (mid - 4));
      g.fillRect((offset + i) * step, direction < 0 ? mid - h : mid, barWidth, h);
    });
  };
  bars(history.tab, styles.getPropertyValue('--brand'), -1);
  bars(history.mic, styles.getPropertyValue('--mic'), 1);
}

function pushHistory(tab, mic) {
  history.tab.push(tab);
  history.mic.push(mic);
  if (history.tab.length > HISTORY_LENGTH) {
    history.tab.shift();
    history.mic.shift();
  }
  drawActivity();
}

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
  const pill = $('mode-pill');
  pill.dataset.mode = mode;
  pill.textContent = { server: 'Saving to server', remote: 'Saving to remote server', local: 'Browser-only' }[mode];
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
  micBox.disabled = true;
  setLive('connecting', 'Connecting');
  setStatus('Choose the meeting tab in Chrome’s share dialog…');
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
      const micLevel = micStream ? data.peak[1] : 0;
      setSpeaker('tab', data.peak[0]);
      setSpeaker('mic', micLevel);
      pushHistory(data.peak[0], micLevel);
      setTimer(seconds);
    };

    tabStream.getAudioTracks()[0].addEventListener('ended', () => stop());
    session = { ctx, sink, streams: [tabStream, micStream].filter(Boolean) };
    history.tab.length = 0;
    history.mic.length = 0;
    setTimer(0);
    startBtn.hidden = true;
    stopBtn.hidden = false;
    stopBtn.disabled = false;
    $('how').hidden = true;
    $('spk-mic').classList.toggle('off', !micStream);
    $('spk-mic-note').textContent = micStream ? 'Microphone' : 'Microphone not recording';
    $('session-title').textContent = 'Meeting in progress';
    setLive('live', 'Recording');
    setStatus(micStream ? 'Capturing the meeting and your microphone' : 'Capturing meeting audio only');
  } catch (err) {
    startBtn.disabled = false;
    micBox.disabled = false;
    setLive('idle', 'Idle');
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
  setSpeaker('tab', 0);
  setSpeaker('mic', 0);
  startBtn.hidden = false;
  startBtn.disabled = false;
  stopBtn.hidden = true;
  stopBtn.disabled = true;
  micBox.disabled = false;
  $('how').hidden = false;
  $('session-title').textContent = 'Ready when your meeting is';
  setLive('idle', 'Idle');
  setTimer(0);
  history.tab.length = 0;
  history.mic.length = 0;
  drawActivity();
  setStatus(reason === 'Stopped' ? 'Recording saved' : reason);
  if (mode === 'server') setTimeout(refreshRecordings, 500);
  else refreshRecordings();
}

async function listRecordings() {
  if (mode === 'local') return localRecordings;
  if (mode === 'remote') return [];
  const res = await fetch('api/recordings');
  if (!res.ok) return [];
  return (await res.json())
    .map(r => ({ ...r, href: `recordings/${encodeURIComponent(r.name)}` }))
    .sort((a, b) => b.name.localeCompare(a.name));
}

function recordingItem({ name, bytes, href }) {
  const date = recordingDate(name);
  const seconds = Math.max(0, bytes - 44) / (SAMPLE_RATE * CHANNELS * 2);
  const li = document.createElement('li');
  li.className = 'rec';
  li.innerHTML = `
    <div class="rec-row">
      <span class="rec-icon">${ICONS.wave}</span>
      <span class="rec-text"><span class="rec-title"></span><span class="rec-meta"></span></span>
      <a class="rec-download" title="Download WAV">${ICONS.download}</a>
    </div>
    <audio controls preload="none"></audio>`;
  li.querySelector('.rec-title').textContent = date
    ? date.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : name;
  li.querySelector('.rec-meta').textContent = `${formatDuration(seconds)} · ${formatSize(bytes)}`;
  const link = li.querySelector('a');
  link.href = href;
  link.download = name;
  link.setAttribute('aria-label', `Download ${name}`);
  li.querySelector('audio').src = href;
  return li;
}

async function refreshRecordings() {
  const list = $('recordings');
  let items = [];
  try {
    items = await listRecordings();
  } catch {
    items = [];
  }
  list.replaceChildren(...items.map(recordingItem));
  $('rec-count').textContent = items.length ? String(items.length) : '';
  $('empty').hidden = items.length > 0;
  if (mode === 'remote') $('empty').textContent = `Recordings are saved on ${serverOverride}.`;
}

startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', () => stop());
mode = await detectMode();
describeMode();
drawActivity();
window.addEventListener('resize', drawActivity);
refreshRecordings();
