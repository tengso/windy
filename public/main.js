const SAMPLE_RATE = 16000;
const CHANNELS = 2;

const $ = id => document.getElementById(id);
const startBtn = $('start');
const stopBtn = $('stop');
const micBox = $('mic');
const statusEl = $('status');

let session = null;

function setStatus(text) { statusEl.textContent = text; }

function ingestUrl() {
  const override = new URLSearchParams(location.search).get('server');
  const base = override ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ingest`;
  return `${base}?sampleRate=${SAMPLE_RATE}&channels=${CHANNELS}`;
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

function openSocket() {
  const ws = new WebSocket(ingestUrl());
  ws.binaryType = 'arraybuffer';
  const pending = [];
  ws.addEventListener('open', () => { pending.splice(0).forEach(b => ws.send(b)); });
  return {
    ws,
    send(buf) {
      if (ws.readyState === WebSocket.OPEN) ws.send(buf);
      else if (ws.readyState === WebSocket.CONNECTING) pending.push(buf);
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

    const socket = openSocket();
    socket.ws.addEventListener('close', () => { if (session) stop('Server connection closed'); });
    let seconds = 0;
    node.port.onmessage = ({ data }) => {
      socket.send(data.pcm);
      seconds += data.pcm.byteLength / (SAMPLE_RATE * CHANNELS * 2);
      $('lvl-tab').value = data.peak[0];
      $('lvl-mic').value = data.peak[1];
      setStatus(`Recording… ${seconds.toFixed(0)} s`);
    };

    tabStream.getAudioTracks()[0].addEventListener('ended', () => stop());
    session = { ctx, socket, streams: [tabStream, micStream].filter(Boolean) };
    stopBtn.disabled = false;
    setStatus(micStream ? 'Recording…' : 'Recording (meeting audio only)…');
  } catch (err) {
    startBtn.disabled = false;
    setStatus(err.name === 'NotAllowedError' ? 'Sharing cancelled' : `Error: ${err.message}`);
  }
}

function stop(reason = 'Stopped') {
  if (!session) return;
  const { ctx, socket, streams } = session;
  session = null;
  streams.forEach(s => s.getTracks().forEach(t => t.stop()));
  ctx.close();
  socket.ws.close();
  $('lvl-tab').value = 0;
  $('lvl-mic').value = 0;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus(reason);
  setTimeout(refreshRecordings, 500);
}

async function refreshRecordings() {
  const list = $('recordings');
  try {
    const res = await fetch('/api/recordings');
    if (!res.ok) return;
    const items = await res.json();
    list.replaceChildren(...items.map(({ name, bytes }) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = `/recordings/${encodeURIComponent(name)}`;
      a.download = name;
      a.textContent = `${name} (${(bytes / 1024).toFixed(0)} KB)`;
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'none';
      audio.src = a.href;
      li.append(a, audio);
      return li;
    }));
  } catch {
    list.replaceChildren();
  }
}

startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', () => stop());
refreshRecordings();
