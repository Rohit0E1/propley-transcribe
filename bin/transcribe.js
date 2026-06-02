#!/usr/bin/env node
// CLI: transcribe an audio file with Sarvam AI.
//
// Usage:
//   node bin/transcribe.js <audio-file> [--language hi-IN] [--model saarika:v2.5] [--json]
//
// Language defaults to "unknown" (auto-detect / auto mode).

import { writeFile } from "node:fs/promises";
import { transcribe } from "../src/sarvam.js";

// Load .env if present (Node >=20.6 supports process.loadEnvFile).
try {
  process.loadEnvFile();
} catch {
  // No .env file — that's fine, rely on the real environment.
}

function parseArgs(argv) {
  const opts = { language: "unknown", model: "saarika:v2.5", json: false, out: null };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--language":
      case "-l":
        opts.language = argv[++i];
        break;
      case "--model":
      case "-m":
        opts.model = argv[++i];
        break;
      case "--out":
      case "-o":
        opts.out = argv[++i];
        break;
      case "--json":
        opts.json = true;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      default:
        positional.push(arg);
    }
  }

  opts.file = positional[0];
  return opts;
}

const HELP = `
sarvam-transcribe — audio → text via Sarvam AI

Usage:
  node bin/transcribe.js <audio-file> [options]

Options:
  -l, --language <code>   BCP-47 code (e.g. hi-IN, en-IN) or "unknown" to auto-detect. Default: unknown
  -m, --model <id>        Sarvam model. Default: saarika:v2.5
  -o, --out <file>        Also write the transcript to this file
      --json              Print the full JSON response instead of just the transcript
  -h, --help              Show this help

Setup:
  Put your key in a .env file:  SARVAM_API_KEY=sk_xxx
  (copy .env.example to .env)

Examples:
  node bin/transcribe.js sample.wav
  node bin/transcribe.js sample.mp3 --language hi-IN
  node bin/transcribe.js sample.wav --json --out transcript.txt
`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help || !opts.file) {
    console.log(HELP);
    process.exit(opts.file ? 0 : 1);
  }

  try {
    const result = await transcribe(opts.file, {
      language: opts.language,
      model: opts.model,
    });

    if (opts.json) {
      console.log(JSON.stringify(result.raw, null, 2));
    } else {
      console.log(result.transcript);
      console.error(
        `\n[detected language: ${result.language_code || "n/a"} | request: ${result.request_id || "n/a"}]`
      );
    }

    if (opts.out) {
      await writeFile(opts.out, result.transcript, "utf8");
      console.error(`[saved transcript to ${opts.out}]`);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
