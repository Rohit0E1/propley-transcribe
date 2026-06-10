// HTTP API wrapping the Sarvam Speech-to-Text client.
//
// Endpoints:
//   GET  /                -> serves the upload + QC-result web page (public/index.html)
//   GET  /health          -> { ok: true }
//   POST /transcribe      -> multipart/form-data with an "audio" (or "file") field
//                            optional fields: language, model
//                            returns { transcript, language_code, request_id }
//   POST /score           -> JSON { "audio": "<url-or-path>", "language": "hi-IN", "rubric": "cadence" }
//                            transcribes (Sarvam batch) + QC-scores (Gemini/Vertex)
//   POST /score-upload    -> multipart/form-data with an "audio" file field
//                            optional fields: language, rubric
//                            uploads the file, transcribes + QC-scores it,
//                            returns { source, language_code, transcript, qc }
//
// Zero dependencies — uses Node's built-in http server and the global
// FormData/Request parsing available in Node >=20. /score shells out to the
// Python scorer (src/score.py), which owns the Sarvam-batch + Vertex logic.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile, writeFile, unlink, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { transcribe } from "./sarvam.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(dirname(__dirname), "public");
// Interpreter that has sarvamai + google-genai installed. Override with PYTHON_BIN.
const PYTHON_BIN = process.env.PYTHON_BIN || "python3";
const SCORE_SCRIPT = join(__dirname, "score.py");

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB safety cap

// Read the full request body into a single Buffer, rejecting oversized uploads.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_UPLOAD_BYTES) {
        reject(Object.assign(new Error("Payload too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

// Parse a multipart/form-data body using the platform Request/formData APIs.
// Returns a Map-like FormData instance.
async function parseMultipart(req, buffer) {
  const contentType = req.headers["content-type"] || "";
  if (!contentType.includes("multipart/form-data")) {
    throw Object.assign(
      new Error('Expected multipart/form-data with an "audio" file field.'),
      { statusCode: 415 }
    );
  }
  // Reconstruct a web Request so we can use the built-in multipart parser.
  const request = new Request("http://localhost/transcribe", {
    method: "POST",
    headers: { "content-type": contentType },
    body: buffer,
  });
  try {
    return await request.formData();
  } catch (err) {
    throw Object.assign(new Error(`Could not parse upload: ${err.message}`), {
      statusCode: 400,
    });
  }
}

async function handleTranscribe(req, res) {
  const buffer = await readBody(req);
  const form = await parseMultipart(req, buffer);

  const file = form.get("audio") || form.get("file");
  if (!file || typeof file === "string") {
    throw Object.assign(
      new Error('No audio file uploaded. Send a file in the "audio" form field.'),
      { statusCode: 400 }
    );
  }

  // Optional overrides from the form.
  const language = form.get("language") || "unknown";
  const model = form.get("model") || "saarika:v2.5";

  // transcribe() reads from disk, so write the upload to a temp file first.
  const { writeFile, unlink, mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = await mkdtemp(join(tmpdir(), "sarvam-"));
  const safeName = (file.name || "audio").replace(/[^\w.\-]/g, "_");
  const tmpPath = join(dir, safeName);

  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    await writeFile(tmpPath, bytes);

    const result = await transcribe(tmpPath, { language, model });
    sendJson(res, 200, {
      transcript: result.transcript,
      language_code: result.language_code,
      request_id: result.request_id,
    });
  } finally {
    await unlink(tmpPath).catch(() => {});
    await import("node:fs/promises").then(({ rmdir }) => rmdir(dir).catch(() => {}));
  }
}

// Run the Python scorer for one audio URL/path, resolving to its parsed JSON.
function runScorer(audio, language, rubric) {
  return new Promise((resolve, reject) => {
    const args = [
      SCORE_SCRIPT, audio,
      "--language", language || "hi-IN",
      "--rubric", rubric || "cadence",
    ];
    const child = spawn(PYTHON_BIN, args, { cwd: dirname(__dirname) });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d)); // batch progress logs; ignored on success
    child.on("error", (e) =>
      reject(Object.assign(new Error(`Could not start scorer: ${e.message}`), { statusCode: 500 }))
    );
    child.on("close", (code) => {
      let parsed;
      try {
        parsed = JSON.parse(out.trim());
      } catch {
        return reject(
          Object.assign(
            new Error(`Scorer produced no JSON (exit ${code}). ${err.slice(-300)}`),
            { statusCode: 502 }
          )
        );
      }
      if (parsed.error) {
        return reject(Object.assign(new Error(parsed.error), { statusCode: 502 }));
      }
      resolve(parsed);
    });
  });
}

async function handleScore(req, res) {
  const buffer = await readBody(req);
  let body;
  try {
    body = JSON.parse(buffer.toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Body must be JSON."), { statusCode: 400 });
  }
  const audio = body.audio || body.url || body.recording_url;
  if (!audio || typeof audio !== "string") {
    throw Object.assign(
      new Error('Provide an audio URL or path in the "audio" field.'),
      { statusCode: 400 }
    );
  }
  const result = await runScorer(audio, body.language, body.rubric);
  sendJson(res, 200, result);
}

// Upload an audio file, then transcribe + QC-score it. This is what the web
// page hits: the user uploads a recording and gets the scorecard back.
async function handleScoreUpload(req, res) {
  const buffer = await readBody(req);
  const form = await parseMultipart(req, buffer);

  const file = form.get("audio") || form.get("file");
  if (!file || typeof file === "string") {
    throw Object.assign(
      new Error('No audio file uploaded. Send a file in the "audio" form field.'),
      { statusCode: 400 }
    );
  }
  const language = form.get("language") || "hi-IN";
  const rubric = form.get("rubric") || "cadence";

  // The scorer reads from disk, so write the upload to a temp file first.
  const dir = await mkdtemp(join(tmpdir(), "qc-upload-"));
  const safeName = (file.name || "audio.mp3").replace(/[^\w.\-]/g, "_");
  const tmpPath = join(dir, safeName);
  try {
    await writeFile(tmpPath, Buffer.from(await file.arrayBuffer()));
    const result = await runScorer(tmpPath, language, rubric);
    // Don't leak the server-side temp path back to the client.
    result.source = file.name || safeName;
    sendJson(res, 200, result);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Serve the single-page upload UI.
async function serveIndex(res) {
  try {
    const html = await readFile(join(PUBLIC_DIR, "index.html"));
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": html.length,
    });
    res.end(html);
  } catch {
    sendJson(res, 404, { error: "index.html not found in public/" });
  }
}

export function createApp() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return await serveIndex(res);
      }

      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === "POST" && url.pathname === "/transcribe") {
        return await handleTranscribe(req, res);
      }

      if (req.method === "POST" && url.pathname === "/score") {
        return await handleScore(req, res);
      }

      if (req.method === "POST" && url.pathname === "/score-upload") {
        return await handleScoreUpload(req, res);
      }

      sendJson(res, 404, { error: "Not found", path: url.pathname });
    } catch (err) {
      const status = err.statusCode || 500;
      sendJson(res, status, { error: err.message });
    }
  });
}

export function startServer(port = process.env.PORT || 3000) {
  const server = createApp();
  server.listen(port, () => {
    console.log(`sarvam-transcribe API listening on http://localhost:${port}`);
    console.log(`  GET  /              -> upload + QC-result web page`);
    console.log(`  POST /score-upload  (multipart/form-data, field "audio") -> QC score`);
    console.log(`  POST /score         (JSON { audio: "<url>", language?, rubric? })`);
    console.log(`  POST /transcribe    (multipart/form-data, field "audio")`);
    console.log(`  GET  /health`);
  });
  return server;
}
