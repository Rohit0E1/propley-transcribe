# sarvam-transcribe

Transcribe audio to text using the [Sarvam AI](https://docs.sarvam.ai/) Speech-to-Text API. Ships with both a **CLI** and an **HTTP API**.

## Setup

```bash
cp .env.example .env      # then add your key
# .env -> SARVAM_API_KEY=sk_xxx
```

Requires Node >= 20. No npm dependencies.

## HTTP API

Start the server:

```bash
npm run serve          # or: node bin/serve.js
PORT=8080 npm run serve # custom port (default 3000)
```

### `POST /transcribe`

Send `multipart/form-data` with an audio file.

| field      | required | description                                              |
| ---------- | -------- | -------------------------------------------------------- |
| `audio`    | yes      | the audio file (`wav`, `mp3`, `m4a`, `flac`, `ogg`, ...) |
| `language` | no       | BCP-47 code like `hi-IN`; default `unknown` (auto)       |
| `model`    | no       | Sarvam model id; default `saarika:v2.5`                  |

`file` is accepted as an alias for `audio`.

**Example:**

```bash
curl -X POST http://localhost:3000/transcribe \
  -F "audio=@recording.wav" \
  -F "language=hi-IN"
```

**Response:**

```json
{
  "transcript": "नमस्ते, यह एक परीक्षण है।",
  "language_code": "hi-IN",
  "request_id": "20260602_..."
}
```

Errors return `{ "error": "..." }` with an appropriate status code (`400` bad request, `413` payload too large, `415` wrong content type, `500` Sarvam/server error). Max upload size is 50 MB.

### `GET /health`

```json
{ "ok": true }
```

> **30-second limit.** The sync endpoint (and the Node CLI below) reject audio
> longer than 30s — Sarvam returns `Audio duration exceeds the maximum limit of
> 30 seconds`. For longer files use the **batch CLI** below.

## CLI (short audio, ≤30s)

```bash
node bin/transcribe.js recording.wav
node bin/transcribe.js recording.mp3 --language hi-IN
node bin/transcribe.js recording.wav --json --out transcript.txt
```

## Batch CLI (long audio, up to ~1h × 20 files)

For full-length recordings, use Sarvam's asynchronous batch job API via the
official Python SDK. Install it once:

```bash
uv pip install sarvamai      # or: pip install sarvamai
```

Then transcribe one or many files:

```bash
python src/batch_transcribe.py call1.mp3 call2.mp3 --language hi-IN
python src/batch_transcribe.py *.mp3 --out-dir transcripts
python src/batch_transcribe.py call.mp3 --diarize --num-speakers 2 --timestamps
```

It runs the full `create_job → upload → start → poll → download` flow and prints
each transcript, saving the raw per-file JSON (with `transcript`, `timestamps`,
`diarized_transcript`, `language_code`) to `transcripts/`.

## Project layout

- `src/sarvam.js` — core Sarvam STT client (`transcribe()`)
- `src/server.js` — HTTP API wrapping the client
- `bin/serve.js` — starts the API server
- `bin/transcribe.js` — CLI entry point (sync, ≤30s)
- `src/batch_transcribe.py` — batch CLI for long audio (Sarvam Batch API)
