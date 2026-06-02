#!/usr/bin/env python3
"""Batch-transcribe long audio files with the Sarvam Speech-to-Text Batch API.

The synchronous /speech-to-text endpoint (see the Node API in this repo) caps
audio at 30 seconds. For longer files (up to ~1 hour each, 20 files per job),
Sarvam provides an asynchronous batch job API. This script wraps the official
`sarvamai` SDK's batch workflow:

    create_job -> upload_files -> start -> wait_until_complete -> download_outputs

Usage:
    python src/batch_transcribe.py audio1.mp3 audio2.wav ...
    python src/batch_transcribe.py *.mp3 --language hi-IN --out-dir transcripts
    python src/batch_transcribe.py call.mp3 --diarize --timestamps

Requires SARVAM_API_KEY in the environment (or a .env file) and the SDK:
    uv pip install sarvamai   (or: pip install sarvamai)
"""

import argparse
import json
import os
import sys
from pathlib import Path

try:
    from sarvamai import SarvamAI
except ImportError:
    sys.exit(
        "The 'sarvamai' SDK is not installed. Install it with:\n"
        "    uv pip install sarvamai   (or: pip install sarvamai)"
    )


def load_env(path: Path = Path(".env")) -> None:
    """Minimal .env loader so we don't add a python-dotenv dependency."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def parse_args(argv):
    p = argparse.ArgumentParser(
        description="Transcribe long audio files via the Sarvam Batch STT API."
    )
    p.add_argument("files", nargs="+", help="Audio file(s) to transcribe (max 20 per job).")
    p.add_argument(
        "-l", "--language", default="unknown",
        help='BCP-47 code (e.g. hi-IN, en-IN) or "unknown" to auto-detect. Default: unknown',
    )
    p.add_argument(
        "-m", "--model", default="saarika:v2.5",
        choices=["saarika:v2.5", "saaras:v3"],
        help="Sarvam model id. Default: saarika:v2.5",
    )
    p.add_argument("--diarize", action="store_true", help="Enable speaker diarization.")
    p.add_argument("--num-speakers", type=int, default=None, help="Hint for number of speakers.")
    p.add_argument("--timestamps", action="store_true", help="Include word/segment timestamps.")
    p.add_argument(
        "-o", "--out-dir", default="transcripts",
        help="Directory to write the raw per-file JSON results. Default: transcripts/",
    )
    p.add_argument("--json", action="store_true", help="Print full JSON results to stdout.")
    p.add_argument(
        "--timeout", type=int, default=1200,
        help="Max seconds to wait for the job to finish. Default: 1200.",
    )
    return p.parse_args(argv)


def main(argv):
    args = parse_args(argv)
    load_env()

    api_key = os.environ.get("SARVAM_API_KEY")
    if not api_key:
        sys.exit("Missing SARVAM_API_KEY. Set it in your environment or a .env file.")

    paths = []
    for f in args.files:
        path = Path(f)
        if not path.is_file():
            sys.exit(f"File not found: {f}")
        paths.append(str(path))

    if len(paths) > 20:
        sys.exit(f"Sarvam allows up to 20 files per batch job; got {len(paths)}.")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    client = SarvamAI(api_subscription_key=api_key)

    print(f"Creating batch job ({args.model}, language={args.language}) ...", file=sys.stderr)
    job = client.speech_to_text_job.create_job(
        model=args.model,
        language_code=args.language,
        with_diarization=args.diarize,
        with_timestamps=args.timestamps,
        num_speakers=args.num_speakers,
    )
    print(f"  job_id = {job.job_id}", file=sys.stderr)

    print(f"Uploading {len(paths)} file(s) ...", file=sys.stderr)
    job.upload_files(paths)

    print("Starting job ...", file=sys.stderr)
    job.start()

    print("Waiting for completion (polling) ...", file=sys.stderr)
    status = job.wait_until_complete(poll_interval=5, timeout=args.timeout)
    print(
        f"  job_state = {status.job_state} "
        f"(ok={status.successful_files_count}, failed={status.failed_files_count})",
        file=sys.stderr,
    )

    if job.is_failed():
        sys.exit(f"Job failed: {getattr(status, 'error_message', 'unknown error')}")

    print(f"Downloading outputs to {out_dir}/ ...", file=sys.stderr)
    job.download_outputs(str(out_dir))

    # Pair each downloaded JSON with its source file and print the transcript.
    results = []
    for src in paths:
        stem = Path(src).stem
        # Sarvam names outputs after the input file; match by stem.
        matches = sorted(out_dir.glob(f"{stem}*.json"))
        if not matches:
            matches = sorted(out_dir.glob("*.json"))
        for out_file in matches:
            try:
                data = json.loads(out_file.read_text())
            except Exception as e:
                print(f"  ! could not parse {out_file.name}: {e}", file=sys.stderr)
                continue
            transcript = data.get("transcript", "")
            lang = data.get("language_code", args.language)
            results.append({"file": Path(src).name, "output": out_file.name,
                            "language_code": lang, "transcript": transcript, "raw": data})

    print(file=sys.stderr)  # blank separator before stdout output
    if args.json:
        print(json.dumps([{k: v for k, v in r.items() if k != "raw"} | {"raw": r["raw"]}
                          for r in results], ensure_ascii=False, indent=2))
    else:
        for r in results:
            print(f"===== {r['file']}  [{r['language_code']}] =====")
            print(r["transcript"] or "(empty transcript)")
            print()

    print(f"[raw JSON saved in {out_dir}/]", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1:])
