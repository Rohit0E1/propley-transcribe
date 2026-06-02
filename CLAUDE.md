# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

`sarvam-transcribe` — audio → text using the [Sarvam AI](https://docs.sarvam.ai/)
Speech-to-Text API. Two interfaces:

- **Node HTTP API** (sync, audio ≤ 30s)
- **Python batch CLI** (long audio, up to ~1h × 20 files per job)

## Test audio (Google Drive)

Sample recordings live here:
https://drive.google.com/drive/folders/1yHF49iG9FJXGlNtDjnU5MIs19SHQ36cZ

These are Exotel call recordings (`1.mp3` … `21.mp3`), Hindi loan/EMI collection
calls, ~2-3 min each (8 kHz mono). Because they exceed 30s, use the **batch CLI**
to transcribe them, not the sync endpoint.

A Drive *folder* link can't be curl'd directly. To download a file, get its file
ID from the folder and use:
`https://drive.google.com/uc?export=download&id=<FILE_ID>`

Known file IDs:
- `1.mp3` → `1prBnFELr-KlvL6CbjyfJN1Jpb5nmMHDs`
- `2.mp3` → `11OLxh7PLdh1UX7-LNN2ywUHs7Bli-IVG`
- `3.mp3` → `1JHa9lgBnp1tdFOhQDLvP78vJKTArTNaO`

## Setup

```bash
cp .env.example .env          # add SARVAM_API_KEY=sk_xxx
uv pip install sarvamai       # only needed for the batch CLI
```

Requires Node >= 20 (HTTP API/CLI have no npm deps) and Python 3 + `sarvamai`
(batch CLI).

## Run

```bash
# HTTP API (sync, ≤30s)
npm run serve                 # http://localhost:3000
curl -X POST localhost:3000/transcribe -F "audio=@clip.wav"

# Node CLI (sync, ≤30s)
node bin/transcribe.js clip.wav --language hi-IN

# Python batch CLI (long audio)
python src/batch_transcribe.py call.mp3 --language hi-IN
python src/batch_transcribe.py *.mp3 --out-dir transcripts --diarize
```

## Layout

- `src/sarvam.js` — core Sarvam STT client (`transcribe()`), used by the API & CLI
- `src/server.js` — Node HTTP API (`POST /transcribe`, `GET /health`)
- `bin/serve.js` — starts the HTTP API
- `bin/transcribe.js` — Node CLI entry point (sync)
- `src/batch_transcribe.py` — batch CLI for long audio (Sarvam Batch API via SDK)

## Conventions / gotchas

- **30s sync cap.** The `/speech-to-text` endpoint rejects audio > 30s
  (`Audio duration exceeds the maximum limit of 30 seconds`). Route long files to
  the batch CLI.
- **Auto language detect** is the default (`language=unknown` / `--language unknown`).
  Passing the actual code (e.g. `hi-IN`) improves accuracy. The Drive samples are
  all Hindi → prefer `hi-IN`.
- Default model: `saarika:v2.5`. Batch also supports `saaras:v3`.
- The Node side is intentionally **zero-dependency** (built-in `http`, global
  `fetch`/`FormData`/`File`). Keep it that way unless there's a strong reason.
- Never commit `.env` (it holds the real `SARVAM_API_KEY`); it's gitignored.
