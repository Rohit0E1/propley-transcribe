#!/usr/bin/env python3
"""Transcribe a call recording and score it against a QC rubric.

Pipeline:
  audio (file path or URL)
    -> Sarvam batch STT (Hindi, diarized)  -> transcript
    -> Gemini on Vertex AI scores it vs a rubric JSON
    -> JSON: per-parameter score/max + transparency fields, total /100, band

Two rubrics ship with the project:
  - qc_rubric.json           (the original 16-parameter loan/EMI rubric)
  - qc_rubric_cadence.json   (the 8-parameter "Cadence Call Intelligence" rubric;
                              this is the default, matching the dashboard UI)

Usage (CLI — what the Node /score endpoint shells out to):
    python src/score.py <audio-path-or-url> [--language hi-IN] [--rubric cadence]
    # prints a single JSON object to stdout

Env (from .env): SARVAM_API_KEY, VERTEX_CREDENTIAL (service-account JSON),
VERTEX_PROJECT, VERTEX_LOCATION.
"""

import argparse
import json
import os
import sys
import tempfile
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
RUBRICS = {
    "cadence": HERE / "qc_rubric_cadence.json",
    "loan": HERE / "qc_rubric.json",
}
DEFAULT_RUBRIC = "cadence"


def load_env(path: Path) -> None:
    """Minimal .env loader (project keeps deps light)."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def resolve_rubric(name_or_path: str) -> Path:
    """Accept a short name ('cadence'/'loan') or an explicit path."""
    if name_or_path in RUBRICS:
        return RUBRICS[name_or_path]
    p = Path(name_or_path)
    if p.is_file():
        return p
    raise FileNotFoundError(f"rubric not found: {name_or_path} (try one of {list(RUBRICS)})")


def fetch_audio(src: str) -> tuple[str, bool]:
    """Return (local_path, is_temp). Downloads if src is a URL."""
    if src.startswith("http://") or src.startswith("https://"):
        suffix = ".mp3"
        for ext in (".mp3", ".wav", ".m4a", ".ogg", ".flac"):
            if ext in src.lower():
                suffix = ext
                break
        fd, tmp = tempfile.mkstemp(suffix=suffix)
        os.close(fd)
        req = urllib.request.Request(src, headers={"User-Agent": "propley-qc/1.0"})
        with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as f:
            f.write(r.read())
        return tmp, True
    if not Path(src).is_file():
        raise FileNotFoundError(f"audio not found: {src}")
    return src, False


def transcribe(path: str, language: str, model: str = "saaras:v3") -> dict:
    """Sarvam batch STT with diarization. Returns {transcript, diarized, language_code, model}."""
    from sarvamai import SarvamAI

    api_key = os.environ.get("SARVAM_API_KEY")
    if not api_key:
        raise RuntimeError("Missing SARVAM_API_KEY")

    client = SarvamAI(api_subscription_key=api_key)
    with tempfile.TemporaryDirectory() as out_dir:
        job = client.speech_to_text_job.create_job(
            model=model,
            language_code=language,
            with_diarization=True,
            with_timestamps=False,
        )
        job.upload_files([path])
        job.start()
        status = job.wait_until_complete(poll_interval=5, timeout=900)
        if job.is_failed():
            raise RuntimeError(f"Sarvam job failed: {getattr(status, 'error_message', '?')}")
        job.download_outputs(out_dir)
        outs = sorted(Path(out_dir).glob("*.json"))
        if not outs:
            raise RuntimeError("Sarvam returned no transcript output")
        data = json.loads(outs[0].read_text())

    transcript = data.get("transcript", "") or ""
    # Build a readable diarized transcript if speakers are present.
    diar = data.get("diarized_transcript") or {}
    lines = []
    for entry in (diar.get("entries") or []):
        spk = entry.get("speaker_id", "?")
        txt = (entry.get("transcript") or "").strip()
        if txt:
            lines.append(f"{spk}: {txt}")
    diarized_text = "\n".join(lines)
    return {
        "transcript": transcript,
        "diarized": diarized_text,
        "language_code": data.get("language_code", language),
        "model": model,
    }


def build_prompt(rubric: dict, transcript: str, diarized: str) -> str:
    lines = []
    for p in rubric["parameters"]:
        crit = " [CRITICAL]" if p.get("critical") else ""
        name = p["name"] + (f" ({p['sublabel']})" if p.get("sublabel") else "")
        lines.append(
            f"- {p['key']} | {name} | max {p['max']} pts{crit}\n"
            f"    definition: {p.get('definition','')}\n"
            f"    expected:   {p.get('expected','')}\n"
            f"    FAIL/LOSE POINTS IF: {p['fail_if']}"
        )
    params_desc = "\n".join(lines)
    convo = diarized.strip() or transcript.strip() or "(empty transcript)"
    return f"""You are a fair, supportive QC reviewer for a loan/EMI collection call center.
You are given the transcript of ONE collection call (Hindi, may be code-mixed).
Score the AGENT (the collection executive, not the customer) against the rubric.

SCORING METHOD:
- Each parameter has a MAX score. Award an integer score from 0..max based on how
  well the agent performed it. Be GENEROUS with partial credit — reward what the
  agent did reasonably well rather than nitpicking minor wording or phrasing.
- Only give very low scores for genuine, clear failures (per the FAIL rule). Clunky
  grammar, slightly fast pace, or imperfect phrasing should NOT cost many points.
- final total_score = sum of all earned scores (out of {rubric['total']}).
- A parameter marked [CRITICAL]: set is_breach=true ONLY for a serious conduct
  breach as described in its FAIL rule (coercion, explicit threats, or abusive
  language). A merely-omitted disclosure is a small deduction, NOT a breach, and
  does NOT auto-fail the call.
- Judge ONLY from what the transcript shows. If something cannot be observed from
  the transcript at all, give the benefit of the doubt (award the points) and say
  so in the reason.

RUBRIC:
{params_desc}

BANDS (by numeric total): Good >= 80, Average 60-79, Bad < 60.

TRANSCRIPT:
\"\"\"
{convo}
\"\"\"

Respond with ONLY a JSON object, no markdown, in exactly this shape:
{{
  "parameters": [
    {{
      "key": "opening_greeting",
      "score": 9,
      "is_breach": false,
      "what_was_correct": "what the agent did well for this parameter",
      "what_was_missed": "what was missing or weak",
      "reason": "one-line reason for the score / points deducted",
      "coaching": "specific, actionable coaching guidance to improve next time"
    }}
    // one entry per rubric parameter, same keys, same order
  ],
  "total_score": <int 0-100>,
  "band": "Good|Average|Bad|Critical Fail",
  "summary": "2-3 sentence overall assessment of the agent's performance on this call"
}}"""


def score_transcript(rubric: dict, transcript: str, diarized: str) -> dict:
    from google import genai
    from google.genai import types
    from google.oauth2 import service_account

    cred_json = os.environ.get("VERTEX_CREDENTIAL")
    project = os.environ.get("VERTEX_PROJECT")
    location = os.environ.get("VERTEX_LOCATION", "asia-south1")
    if not cred_json or not project:
        raise RuntimeError("Missing VERTEX_CREDENTIAL or VERTEX_PROJECT")

    creds = service_account.Credentials.from_service_account_info(
        json.loads(cred_json),
        scopes=["https://www.googleapis.com/auth/cloud-platform"],
    )
    client = genai.Client(
        vertexai=True, project=project, location=location, credentials=creds
    )
    prompt = build_prompt(rubric, transcript, diarized)
    resp = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=prompt,
        config=types.GenerateContentConfig(
            temperature=0,
            response_mime_type="application/json",
        ),
    )
    raw = resp.text or "{}"
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # strip accidental markdown fences
        cleaned = raw.strip().lstrip("`").rstrip("`")
        if cleaned.startswith("json"):
            cleaned = cleaned[4:]
        return json.loads(cleaned)


def reconcile(rubric: dict, scored: dict) -> dict:
    """Recompute total from per-parameter scores so the math is authoritative,
    attach max/weight/critical metadata, derive deductions, and apply the
    critical auto-fail to the band."""
    meta = {p["key"]: p for p in rubric["parameters"]}
    total = 0
    any_breach = False
    # keep rubric order
    by_key = {p.get("key"): p for p in scored.get("parameters", [])}
    rebuilt = []
    for rp in rubric["parameters"]:
        key = rp["key"]
        sp = by_key.get(key, {})
        mx = rp["max"]
        score = sp.get("score")
        if not isinstance(score, (int, float)):
            score = 0
        score = max(0, min(int(round(score)), mx))
        is_breach = bool(sp.get("is_breach")) and bool(rp.get("critical"))
        if is_breach:
            any_breach = True
        total += score
        rebuilt.append({
            "key": key,
            "code": rp.get("code"),
            "name": rp["name"],
            "sublabel": rp.get("sublabel"),
            "score": score,
            "max": mx,
            "weight": rp.get("weight", mx),
            "deduction": mx - score,
            "critical": bool(rp.get("critical")),
            "auto_fail": bool(rp.get("auto_fail")),
            "is_breach": is_breach,
            "status": ("fail" if (is_breach or score == 0)
                       else "pass" if score == mx
                       else "partial"),
            "what_was_correct": sp.get("what_was_correct", ""),
            "what_was_missed": sp.get("what_was_missed", ""),
            "reason": sp.get("reason", ""),
            "coaching": sp.get("coaching", ""),
        })

    total = max(0, min(total, rubric["total"]))
    scored["parameters"] = rebuilt
    scored["total_score"] = total
    scored["critical_fail"] = any_breach

    if any_breach:
        scored["band"] = "Critical Fail"
    else:
        for band in rubric["bands"]:
            if total >= band["min"]:
                scored["band"] = band["label"]
                break

    # rollup counts for the UI
    scored["counts"] = {
        "passed": sum(1 for p in rebuilt if p["status"] == "pass"),
        "partial": sum(1 for p in rebuilt if p["status"] == "partial"),
        "failed": sum(1 for p in rebuilt if p["status"] == "fail"),
    }
    return scored


def run(src: str, language: str, model: str = "saaras:v3",
        rubric_name: str = DEFAULT_RUBRIC) -> dict:
    rubric = json.loads(resolve_rubric(rubric_name).read_text())
    path, is_temp = fetch_audio(src)
    try:
        tr = transcribe(path, language, model)
    finally:
        if is_temp:
            try:
                os.unlink(path)
            except OSError:
                pass
    scored = score_transcript(rubric, tr["transcript"], tr["diarized"])
    scored = reconcile(rubric, scored)
    return {
        "source": src,
        "rubric": rubric.get("name"),
        "language_code": tr["language_code"],
        "stt_model": tr["model"],
        "transcript": tr["transcript"],
        "diarized_transcript": tr["diarized"],
        "qc": scored,
    }


def main(argv):
    ap = argparse.ArgumentParser(description="Transcribe + QC-score a call recording")
    ap.add_argument("audio", help="audio file path or URL")
    ap.add_argument("-l", "--language", default="hi-IN")
    ap.add_argument("-m", "--model", default="saaras:v3",
                    choices=["saarika:v2.5", "saaras:v3"],
                    help="Sarvam STT model. Default saaras:v3 (stronger on code-mixed audio).")
    ap.add_argument("-r", "--rubric", default=DEFAULT_RUBRIC,
                    help="rubric: 'cadence' (8-param, default), 'loan' (16-param), or a path.")
    ap.add_argument("--no-transcript", action="store_true",
                    help="omit the full transcript from output")
    ap.add_argument("-o", "--out-dir", default=None,
                    help="if set, also save the result JSON to this directory")
    args = ap.parse_args(argv)

    load_env(HERE.parent / ".env")
    try:
        result = run(args.audio, args.language, args.model, args.rubric)
        if args.out_dir:
            out = Path(args.out_dir)
            out.mkdir(parents=True, exist_ok=True)
            model_tag = args.model.replace(":", "-").replace(".", "")
            stem = Path(args.audio.split("?")[0].rstrip("/")).stem or "result"
            (out / f"{stem}.{model_tag}.score.json").write_text(
                json.dumps(result, ensure_ascii=False, indent=2))
            txt = result.get("diarized_transcript") or result.get("transcript") or ""
            (out / f"{stem}.{model_tag}.transcript.txt").write_text(txt)
            print(f"[saved {out}/{stem}.{model_tag}.score.json and .transcript.txt]",
                  file=sys.stderr)
        if args.no_transcript:
            result.pop("transcript", None)
            result.pop("diarized_transcript", None)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
