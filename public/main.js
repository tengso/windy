import { createSegmenter, createWhisperEngine, deinterleave } from './transcriber.js';
import {
  CLOUD_MODELS, KEY_PROTOCOL_PREFIX, OPENAI_REALTIME_URL, createOpenAIChannel, createQwenChannel, openaiClientSecret,
} from './cloud-stt.js';

const SAMPLE_RATE = 16000;
const CHANNELS = 2;

const $ = id => document.getElementById(id);
const startBtn = $('start');
const stopBtn = $('stop');
const micBox = $('mic');
const transcribeBox = $('transcribe');
const modelSelect = $('model');
const keyInput = $('model-key');
const rememberBox = $('remember-key');
const regionSelect = $('qwen-region');
const statusEl = $('status');
const modeEl = $('mode');
const SPEAKING_THRESHOLD = 0.04;
const SPEAKERS = [{ name: 'Meeting', cls: 'tab' }, { name: 'You', cls: 'mic' }];
const MERGE_GAP_S = 3;
const HISTORY_LENGTH = 150;
const ICONS = {
  wave: '<svg viewBox="0 0 24 24"><path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
};
const serverOverride = new URLSearchParams(location.search).get('server');
const PROVIDER_NAMES = { whisper: 'Built-in', openai: 'OpenAI', qwen: 'Qwen', deepgram: 'Deepgram' };
const CLOUD = ['openai', 'qwen'];
const typedKeys = { openai: '', qwen: '' };

let mode = serverOverride ? 'remote' : 'local';
let serverConfig = { providers: {} };
let whisper = null;
let whisperState = { status: 'idle', device: null, progress: 0 };
let session = null;
const localRecordings = [];

const history = { tab: [], mic: [] };
const transcript = { lines: [], interim: [null, null], speaking: [false, false], pending: [0, 0], lastStart: [0, 0], engine: null, startedAt: null };

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

function ingestUrl(engine) {
  const base = serverOverride ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ingest`;
  const transcribe = engine === 'deepgram' ? '&transcribe=deepgram' : '';
  return `${base}?sampleRate=${SAMPLE_RATE}&channels=${CHANNELS}${transcribe}`;
}

function relayUrl(provider) {
  const url = new URL(serverOverride ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ingest`);
  url.pathname = url.pathname.replace(/ingest\/?$/, 'stt');
  url.search = '';
  url.searchParams.set('provider', provider);
  if (provider === 'qwen') url.searchParams.set('region', regionSelect.value);
  return url.toString();
}

const engineOf = choice => (choice === 'builtin' ? 'whisper' : choice);
const providerModel = provider => serverConfig.providers[provider]?.model ?? CLOUD_MODELS[provider];

function hasServerKey(provider) {
  if (provider === 'deepgram' && serverConfig.transcription === 'deepgram') return true;
  return Boolean(serverConfig.providers[provider]?.serverKey);
}

function engineLabel(engine) {
  if (engine === 'whisper') return 'Whisper · on this device';
  if (engine === 'deepgram') return 'Deepgram · cloud';
  return `${PROVIDER_NAMES[engine]} · ${providerModel(engine)} · cloud`;
}

function missingRequirement(choice) {
  if (!CLOUD.includes(choice) || hasServerKey(choice)) return null;
  if (choice === 'qwen' && mode === 'local') return 'Qwen needs a Windy server. Run npm start, or add ?server=… to the URL.';
  if (!typedKeys[choice].trim()) return `Paste your ${PROVIDER_NAMES[choice]} API key to use ${PROVIDER_NAMES[choice]}.`;
  return null;
}

function modelNote(choice) {
  if (choice === 'builtin') return 'Runs Whisper in this browser. Free and private; the model downloads on first use.';
  if (hasServerKey(choice)) return `Audio is sent to ${PROVIDER_NAMES[choice]} using this server's API key.`;
  if (choice === 'qwen' && mode === 'local') {
    return 'Qwen needs a Windy server: its realtime API requires an Authorization header, which browsers can’t send. '
      + 'Run npm start, or add ?server=wss://your-host/ingest to the URL.';
  }
  const via = mode === 'local' ? '' : ' through this Windy server';
  const vendor = choice === 'openai' ? 'OpenAI' : 'Alibaba Cloud Model Studio';
  return `Audio and your key go only to ${vendor}${via}, and usage is billed to your account. `
    + (rememberBox.checked ? 'The key is saved in this browser.' : 'The key is kept only until you close this tab.');
}

function renderPicker() {
  const deepgram = modelSelect.querySelector('option[value="deepgram"]');
  deepgram.hidden = deepgram.disabled = !hasServerKey('deepgram');
  if (modelSelect.selectedOptions[0]?.disabled) modelSelect.value = 'builtin';
  const choice = modelSelect.value;
  const needsKey = CLOUD.includes(choice) && !hasServerKey(choice) && !(choice === 'qwen' && mode === 'local');
  $('key-row').hidden = !needsKey;
  regionSelect.hidden = !(needsKey && choice === 'qwen');
  keyInput.placeholder = choice === 'qwen' ? 'Paste your DashScope API key' : 'Paste your OpenAI API key';
  if (needsKey) keyInput.value = typedKeys[choice];
  $('model-note').textContent = modelNote(choice);
}

function setPickerDisabled(disabled) {
  [modelSelect, keyInput, rememberBox, regionSelect].forEach(el => { el.disabled = disabled; });
}

function persistKeys() {
  for (const provider of CLOUD) {
    const name = `windy.key.${provider}`;
    if (rememberBox.checked && typedKeys[provider].trim()) localStorage.setItem(name, typedKeys[provider].trim());
    else localStorage.removeItem(name);
  }
}

function transcriptBlocks() {
  const blocks = [];
  for (const line of [...transcript.lines].sort((a, b) => a.start - b.start)) {
    const last = blocks.at(-1);
    if (last && last.channel === line.channel && line.start - last.end < MERGE_GAP_S) {
      last.text += ` ${line.text}`;
      last.end = Math.max(last.end, line.end);
    } else {
      blocks.push({ ...line });
    }
  }
  return blocks;
}

function transcriptLine(channel, start, text, live = false) {
  const { name, cls } = SPEAKERS[channel];
  const row = document.createElement('div');
  row.className = `line ${cls}${live ? ' live' : ''}`;
  row.innerHTML = '<span class="who"></span><span class="when"></span><p></p>';
  row.querySelector('.who').textContent = name;
  row.querySelector('.when').textContent = formatClock(start);
  const p = row.querySelector('p');
  if (text) p.textContent = text;
  else p.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
  return row;
}

function renderTranscript() {
  const box = $('transcript');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const rows = transcriptBlocks().map(b => transcriptLine(b.channel, b.start, b.text));
  SPEAKERS.forEach((_, channel) => {
    const interim = transcript.interim[channel];
    if (interim?.text) rows.push(transcriptLine(channel, interim.start, interim.text, true));
    else if (transcript.speaking[channel] || transcript.pending[channel] > 0) {
      rows.push(transcriptLine(channel, interim?.start ?? transcript.lastStart[channel], '', true));
    }
  });
  $('transcript-empty').hidden = rows.length > 0;
  box.replaceChildren(...rows);
  if (nearBottom) box.scrollTop = box.scrollHeight;
  $('copy-transcript').disabled = transcript.lines.length === 0;
  $('download-transcript').disabled = transcript.lines.length === 0;
}

function renderEngine() {
  const label = $('engine');
  const bar = $('model-progress');
  const loading = transcript.engine === 'whisper' && whisperState.status === 'loading';
  bar.hidden = !loading;
  $('model-bar').value = whisperState.progress;
  $('model-label').textContent = `Downloading speech model… ${Math.round(whisperState.progress * 100)}%`;
  if (transcript.engine && transcript.engine !== 'whisper') label.textContent = engineLabel(transcript.engine);
  else if (transcript.engine === 'whisper') {
    label.textContent = whisperState.status === 'error'
      ? 'Speech model failed to load'
      : `Whisper · on this device${whisperState.device ? ` (${whisperState.device === 'webgpu' ? 'GPU' : 'CPU'})` : ''}`;
  } else {
    label.textContent = transcribeBox.checked ? engineLabel(engineOf(modelSelect.value)) : 'Off';
  }
}

function addTranscript({ channel, text, start, end }) {
  if (text) transcript.lines.push({ channel, text, start, end });
  renderTranscript();
}

function transcriptText() {
  return transcriptBlocks()
    .map(b => `[${formatClock(b.start)}] ${SPEAKERS[b.channel].name}: ${b.text}`)
    .join('\n');
}

function resetTranscript(engine) {
  transcript.lines = [];
  transcript.interim = [null, null];
  transcript.speaking = [false, false];
  transcript.pending = [0, 0];
  transcript.lastStart = [0, 0];
  transcript.engine = engine;
  transcript.startedAt = new Date();
  renderTranscript();
  renderEngine();
}

function ensureWhisper() {
  if (whisper) return whisper;
  whisperState = { status: 'loading', device: null, progress: 0 };
  whisper = createWhisperEngine({
    onProgress: progress => { whisperState.progress = progress; renderEngine(); },
    onReady: device => { whisperState = { status: 'ready', device, progress: 1 }; renderEngine(); },
    onError: err => {
      console.error('Speech model failed', err);
      whisperState = { status: 'error', device: null, progress: 0 };
      transcript.pending = [0, 0];
      renderEngine();
      renderTranscript();
    },
    onResult: result => {
      transcript.pending[result.channel] = Math.max(0, transcript.pending[result.channel] - 1);
      addTranscript(result);
    },
  });
  whisper.load();
  return whisper;
}

function whisperSegmenters(channels) {
  const engine = ensureWhisper();
  return channels.map(channel => createSegmenter({
    sampleRate: SAMPLE_RATE,
    onSpeaking: (speaking, start) => {
      transcript.speaking[channel] = speaking;
      if (speaking) transcript.lastStart[channel] = start;
      renderTranscript();
    },
    onSegment: segment => {
      if (whisperState.status === 'error') return;
      transcript.pending[channel]++;
      transcript.lastStart[channel] = segment.start;
      engine.transcribe({ channel, ...segment });
      renderTranscript();
    },
  }));
}

function cloudOpener(provider) {
  const key = hasServerKey(provider) ? null : typedKeys[provider].trim();
  if (mode !== 'local') {
    return () => new WebSocket(relayUrl(provider), key ? ['windy', `${KEY_PROTOCOL_PREFIX}${key}`] : ['windy']);
  }
  let secret = null;
  return async () => {
    secret ??= openaiClientSecret(key, providerModel(provider));
    return new WebSocket(OPENAI_REALTIME_URL, ['realtime', `openai-insecure-api-key.${await secret}`]);
  };
}

function cloudChannels(engine, channels) {
  const open = cloudOpener(engine);
  const create = engine === 'openai' ? createOpenAIChannel : createQwenChannel;
  return channels.map(channel => create({
    channel,
    sampleRate: SAMPLE_RATE,
    model: providerModel(engine),
    open,
    onSpeaking: (speaking, start) => {
      transcript.speaking[channel] = speaking;
      if (speaking) transcript.lastStart[channel] = start;
      renderTranscript();
    },
    onInterim: ({ text, start }) => {
      transcript.interim[channel] = text ? { text, start } : null;
      renderTranscript();
    },
    onFinal: line => {
      transcript.interim[channel] = null;
      addTranscript(line);
    },
    onError: err => fallBackToWhisper(engine, err.message),
  }));
}

function fallBackToWhisper(engine, message) {
  if (session?.engine !== engine) return;
  console.warn(`${PROVIDER_NAMES[engine]} transcription failed, switching to on-device Whisper:`, message);
  session.cloud.forEach(channel => channel.close());
  session.cloud = [];
  session.engine = 'whisper';
  session.segmenters = whisperSegmenters(session.channels);
  transcript.engine = 'whisper';
  transcript.interim = [null, null];
  transcript.speaking = [false, false];
  setStatus(`${PROVIDER_NAMES[engine]} transcription failed (${message}). Switched to on-device Whisper.`);
  renderEngine();
  renderTranscript();
}

function onServerMessage(msg) {
  if (msg.type === 'transcript') {
    if (msg.final) {
      transcript.interim[msg.channel] = null;
      addTranscript(msg);
    } else {
      transcript.interim[msg.channel] = { text: msg.text, start: msg.start };
      renderTranscript();
    }
  } else if (msg.type === 'transcript-error') {
    fallBackToWhisper('deepgram', msg.message);
  }
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

function socketSink(engine, onClosed) {
  const ws = new WebSocket(ingestUrl(engine));
  ws.binaryType = 'arraybuffer';
  const pending = [];
  ws.addEventListener('open', () => { pending.splice(0).forEach(b => ws.send(b)); });
  ws.addEventListener('close', onClosed);
  ws.addEventListener('message', ({ data }) => {
    if (typeof data !== 'string') return;
    try { onServerMessage(JSON.parse(data)); } catch (err) { console.warn('Bad server message', err); }
  });
  return {
    write(buf) {
      if (ws.readyState === WebSocket.OPEN) ws.send(buf);
      else if (ws.readyState === WebSocket.CONNECTING) pending.push(buf);
    },
    close() {
      ws.removeEventListener('close', onClosed);
      if (ws.readyState !== WebSocket.OPEN) {
        ws.close();
        return Promise.resolve();
      }
      ws.send(JSON.stringify({ type: 'stop' }));
      return new Promise(resolve => {
        const timer = setTimeout(() => { ws.close(); resolve(); }, 6000);
        ws.addEventListener('close', () => { clearTimeout(timer); resolve(); });
      });
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
  const choice = transcribeBox.checked ? modelSelect.value : null;
  const problem = choice && missingRequirement(choice);
  if (problem) {
    setStatus(problem);
    if (!$('key-row').hidden) keyInput.focus();
    return;
  }
  startBtn.disabled = true;
  micBox.disabled = true;
  transcribeBox.disabled = true;
  setPickerDisabled(true);
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

    const engine = choice && engineOf(choice);
    const channels = micStream ? [0, 1] : [0];
    resetTranscript(engine);
    const sink = mode === 'local' ? localSink() : socketSink(engine, () => stop('Server connection closed'));
    const live = {
      engine,
      channels,
      segmenters: engine === 'whisper' ? whisperSegmenters(channels) : [],
      cloud: CLOUD.includes(engine) ? cloudChannels(engine, channels) : [],
    };
    let seconds = 0;
    node.port.onmessage = ({ data }) => {
      if (live.segmenters.length || live.cloud.length) {
        const perChannel = deinterleave(new Int16Array(data.pcm), CHANNELS);
        live.segmenters.forEach((seg, i) => seg.push(perChannel[live.channels[i]]));
        live.cloud.forEach((stt, i) => stt.push(perChannel[live.channels[i]]));
      }
      sink.write(data.pcm);
      seconds += data.pcm.byteLength / (SAMPLE_RATE * CHANNELS * 2);
      const micLevel = micStream ? data.peak[1] : 0;
      setSpeaker('tab', data.peak[0]);
      setSpeaker('mic', micLevel);
      pushHistory(data.peak[0], micLevel);
      setTimer(seconds);
    };

    tabStream.getAudioTracks()[0].addEventListener('ended', () => stop());
    session = Object.assign(live, { ctx, sink, streams: [tabStream, micStream].filter(Boolean) });
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
    transcribeBox.disabled = false;
    setPickerDisabled(false);
    setLive('idle', 'Idle');
    setStatus(err.name === 'NotAllowedError' ? 'Sharing cancelled' : `Error: ${err.message}`);
  }
}

async function stop(reason = 'Stopped') {
  if (!session) return;
  const { ctx, sink, streams, segmenters, cloud } = session;
  session = null;
  streams.forEach(s => s.getTracks().forEach(t => t.stop()));
  await ctx.close();
  segmenters.forEach(seg => seg.flush());
  const closing = Promise.all([sink.close(), ...cloud.map(stt => stt.close())]);
  setSpeaker('tab', 0);
  setSpeaker('mic', 0);
  startBtn.hidden = false;
  startBtn.disabled = false;
  stopBtn.hidden = true;
  stopBtn.disabled = true;
  micBox.disabled = false;
  transcribeBox.disabled = false;
  setPickerDisabled(false);
  $('how').hidden = false;
  $('session-title').textContent = 'Ready when your meeting is';
  setLive('idle', 'Idle');
  setTimer(0);
  history.tab.length = 0;
  history.mic.length = 0;
  drawActivity();
  setStatus(reason === 'Stopped' ? 'Recording saved' : reason);
  await closing;
  transcript.interim = [null, null];
  renderTranscript();
  refreshRecordings();
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

function configUrl() {
  if (mode === 'server') return 'api/config';
  if (mode !== 'remote') return null;
  const url = new URL(serverOverride);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = url.pathname.replace(/ingest\/?$/, 'api/config');
  url.search = '';
  return url.toString();
}

async function detectConfig() {
  const url = configUrl();
  if (!url) return { providers: {} };
  try {
    const res = await fetch(url);
    return res.ok ? { providers: {}, ...(await res.json()) } : { providers: {} };
  } catch {
    return { providers: {} };
  }
}

$('copy-transcript').addEventListener('click', async () => {
  await navigator.clipboard.writeText(transcriptText());
  $('copy-transcript').textContent = 'Copied';
  setTimeout(() => { $('copy-transcript').textContent = 'Copy'; }, 1500);
});
$('download-transcript').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([transcriptText()], { type: 'text/plain' }));
  a.download = `transcript-${(transcript.startedAt ?? new Date()).toISOString().replace(/[:.]/g, '-')}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
transcribeBox.addEventListener('change', renderEngine);
modelSelect.addEventListener('change', () => {
  localStorage.setItem('windy.model', modelSelect.value);
  renderPicker();
  renderEngine();
});
keyInput.addEventListener('input', () => {
  typedKeys[modelSelect.value] = keyInput.value;
  persistKeys();
});
rememberBox.addEventListener('change', () => {
  persistKeys();
  renderPicker();
});
regionSelect.addEventListener('change', () => localStorage.setItem('windy.qwen-region', regionSelect.value));
startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', () => stop());
mode = await detectMode();
serverConfig = await detectConfig();
for (const provider of CLOUD) typedKeys[provider] = localStorage.getItem(`windy.key.${provider}`) ?? '';
rememberBox.checked = CLOUD.some(provider => typedKeys[provider]);
regionSelect.value = localStorage.getItem('windy.qwen-region') ?? 'intl';
modelSelect.value = localStorage.getItem('windy.model') ?? 'builtin';
if (!modelSelect.value) modelSelect.value = 'builtin';
describeMode();
renderPicker();
renderEngine();
renderTranscript();
drawActivity();
window.addEventListener('resize', drawActivity);
refreshRecordings();
