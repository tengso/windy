# Windy

Record the audio of an online meeting (Google Meet, Zoom web, Teams web, …) running in a Chrome tab, and
stream it in real time to a server that saves WAV files.

No extension or install is needed. The user opens the Windy page, clicks **Start**, and shares the meeting tab
through Chrome's built-in tab picker.

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

Environment variables: `PORT` (default `8080`) and `RECORDINGS_DIR` (default `./recordings`).

To send audio to a different backend, append `?server=wss://other-host/ingest` to the page URL.

## Deploy

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
- The server has no authentication. Put it behind your own auth before exposing it publicly.

## Development

```sh
npm test     # unit and server/WebSocket integration tests
npm run lint # syntax check
```
