# Windy

Record the audio of an online meeting (Google Meet, Zoom web, Teams web, …) running in a Chrome tab, and
stream it in real time to a server that saves WAV files.

No extension or install is needed. The user opens the Windy page, clicks **Start**, and shares the meeting tab
through Chrome's built-in tab picker.

Live (browser-only mode): https://tengso.github.io/windy/

## How it works

```
meeting tab ──getDisplayMedia (tab audio)──┐
                                           ├─ AudioContext @16 kHz ─ ChannelMerger ─ AudioWorklet (Int16 PCM)
microphone ───getUserMedia (optional)──────┘                                             │ 100 ms batches
                                                                                         ▼
                                                     WebSocket /ingest ──► server.js ──► recordings/<timestamp>.wav
```

- `public/main.js`: captures the meeting tab with `getDisplayMedia` (the video track is dropped right away) and
  the microphone with `getUserMedia`, mixes them into one stereo graph, and streams PCM over a WebSocket.
- `public/pcm-worklet.js`: runs on the audio thread, converts Float32 to interleaved Int16, and posts 100 ms batches
  plus peak levels for the meters.
- `server.js`: serves `public/`, accepts `ws(s)://<host>/ingest?sampleRate=16000&channels=2`, writes the raw PCM
  into a WAV file and fixes up the header when the socket closes. `GET /api/recordings` lists the files, and
  `GET /recordings/<name>` downloads one.

Recording format: 16 kHz, 16-bit, stereo WAV. **Left channel = meeting participants (tab audio), right channel =
you (microphone).** Keeping the speakers on separate channels helps transcription and diarization.

## Run locally

Requires Node 20 or newer.

```sh
npm install
npm start            # http://localhost:8080
```

1. Open the meeting in one Chrome tab.
2. Open http://localhost:8080 in another tab and click **Start**.
3. Pick the meeting tab under **Chrome Tab** and keep **"Also share tab audio"** ticked.
4. Click **Stop**, click "Stop sharing" in Chrome's bar, or close the meeting tab to finish. The WAV file shows up
   under *Recordings* and in `./recordings/`.

Environment variables: `PORT` (default `8080`), `RECORDINGS_DIR` (default `./recordings`), and the optional
transcript-model keys described under [Live transcript](#live-transcript).

To send audio to a different backend, append `?server=wss://other-host/ingest` to the page URL.

## Modes

The page picks a mode when it loads:

| Mode | When | Where recordings go |
|------|------|---------------------|
| server | page served by `server.js` (`api/recordings` responds) | streamed over WebSocket, saved in `RECORDINGS_DIR` |
| remote | `?server=wss://host/ingest` in the URL | streamed to that server |
| local | anything else (e.g. GitHub Pages) | kept in browser memory and offered as a WAV download |

Browser-only mode needs no backend. Audio is held in memory (about 64 KB/s, roughly 230 MB per hour) until you
stop, and it is lost if the tab closes before you download it.

## Live transcript

The page shows a live transcript, labelled **Meeting** (left channel) and **You** (right channel). Turn it off with
the *Live transcript* switch. Use *Copy* or *Download .txt* to save it. Pick the engine under **Transcript model**:

| Model | Where it runs | Needs |
|-------|---------------|-------|
| **Built-in** (default) | Whisper in a Web Worker via [Transformers.js](https://huggingface.co/docs/transformers.js): `whisper-base.en` on WebGPU, `whisper-tiny.en` on CPU/WASM | Nothing. Works on GitHub Pages. The model (about 40–150 MB) downloads on the first recording and is cached. English only. |
| **OpenAI** (`gpt-live-transcribe`) | OpenAI Realtime API, transcription session | `OPENAI_API_KEY` on the server, or an API key pasted in the page |
| **Qwen** (`qwen3-asr-flash-realtime`) | Alibaba Cloud Model Studio (DashScope) realtime ASR | `DASHSCOPE_API_KEY` on the server, or a DashScope key pasted in the page **and** a Windy server (see below) |
| **Deepgram** (`nova-3`) | Deepgram streaming API | `DEEPGRAM_API_KEY` on the server. Only listed when the server has a key. |

Each channel is transcribed separately (one provider session per channel), so lines keep their Meeting/You label.

- **Built-in**: an energy-based voice detector (`public/transcriber.js`) cuts each channel into utterances of up to
  8 s, so text appears about 1–3 s after someone stops talking.
- **OpenAI**: `gpt-live-transcribe` has no server-side VAD, so the same voice detector streams each utterance
  (resampled to the required 24 kHz PCM) with `input_audio_buffer.append`, then sends `input_audio_buffer.commit`.
  Partial text comes from `…transcription.delta` events and the final line from `…transcription.completed`.
- **Qwen**: audio is streamed continuously at 16 kHz and Qwen's server VAD (`server_vad`) splits utterances. Partial
  text is `text + stash` from `…transcription.text` events; the final line comes from `…transcription.completed`.
  The page sends `session.finish` when you stop so the last utterance is not lost.
- **Deepgram**: `server.js` forwards the stereo PCM over `/ingest` (`multichannel=true`) and relays the results back.

If a cloud model fails (bad key, quota, network), the page tells you why and switches to Built-in Whisper for the
rest of the session.

### API keys

Server keys always win: the page asks `GET /api/config` which providers have a key (it only gets `true`/`false`,
never the key) and skips the key field for those. Otherwise the user can paste their own key:

- **With a Windy server** (server mode, or `?server=wss://host/ingest`): the browser opens `/stt?provider=openai|qwen`
  on that server, which adds the `Authorization` header and relays only transcription events to the provider. A
  pasted key travels to the Windy server inside the WebSocket subprotocol list and is not stored or logged there.
- **Browser-only (GitHub Pages)**: OpenAI works. The page uses the pasted key once to mint a short-lived client secret
  (`POST /v1/realtime/client_secrets`, 10 minutes) and opens the Realtime WebSocket with that secret. **Qwen does not
  work browser-only**: Model Studio's realtime WebSocket needs an `Authorization` header, which browsers cannot set.
  Run a Windy server for Qwen.

Pasted keys stay in memory for the tab unless *Remember key in this browser* is ticked, which saves them in
`localStorage`. Audio sent to a cloud model is billed to that key's account.

Server settings:

| Variable | Default |
|----------|---------|
| `OPENAI_API_KEY` | – |
| `OPENAI_TRANSCRIPTION_MODEL` | `gpt-live-transcribe` |
| `OPENAI_REALTIME_URL` | `wss://api.openai.com/v1/realtime?intent=transcription` |
| `DASHSCOPE_API_KEY` | – |
| `QWEN_TRANSCRIPTION_MODEL` | `qwen3-asr-flash-realtime` |
| `QWEN_REGION` | `intl` (`wss://dashscope-intl.aliyuncs.com/…`); `cn` for Beijing (`wss://dashscope.aliyuncs.com/…`) |
| `QWEN_REALTIME_URL` | – (set to use a workspace domain such as `wss://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime`) |
| `DEEPGRAM_API_KEY`, `DEEPGRAM_MODEL`, `DEEPGRAM_LANGUAGE` | –, `nova-3`, `en` |

```sh
OPENAI_API_KEY=... DASHSCOPE_API_KEY=... npm start
```

Model Studio keys are region-specific. For a pasted Qwen key, pick the key's region next to the key field.

## Deploy to GitHub Pages (browser-only)

`.github/workflows/pages.yml` publishes `public/` on every push to `main`. One-time setup: in the repo's
**Settings → Pages**, set **Source** to **GitHub Actions**.

## Deploy the server

`getDisplayMedia` and `getUserMedia` only work on HTTPS (or `localhost`), so deploy behind TLS. The app is a
single Node process that serves both the page and the WebSocket, so any Node host with WebSocket support works:
Fly.io, Railway, Render, Cloud Run, or a VM behind Caddy or nginx. Mount a persistent volume at `RECORDINGS_DIR`.

```sh
docker build -t windy .
docker run -p 8080:8080 -v $PWD/recordings:/data windy
```

## Limitations

- Tab audio is only available when the user shares a **Chrome tab**. Desktop meeting apps (the native Zoom or
  Teams clients) are not tabs. On Windows and ChromeOS, sharing "Entire screen" with system audio can still
  capture them; macOS and Linux do not offer that option.
- Chrome shows the share picker every session. There is no "always allow" for tab capture.
- The Windy tab must stay open, although it can sit in the background.
- The on-device Whisper models are English-only. Accuracy is lower than the cloud models', particularly on CPU.
- If you use speakers instead of headphones, the microphone can pick up the meeting audio, so some of it may
  also appear under **You**.
- The server has no authentication. Put it behind your own auth before exposing it publicly, especially if it holds
  provider keys: anyone who can reach it can transcribe on your account.

## Development

```sh
npm test     # unit and server/WebSocket integration tests
npm run lint # syntax check
```
