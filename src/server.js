// HTTP API wrapping the Sarvam Speech-to-Text client.
//
// Endpoints:
//   GET  /health       -> { ok: true }
//   POST /transcribe   -> multipart/form-data with an "audio" (or "file") field
//                         optional fields: language, model
//                         returns { transcript, language_code, request_id }
//
// Zero dependencies — uses Node's built-in http server and the global
// FormData/Request parsing available in Node >=20.

import { createServer } from "node:http";
import { transcribe } from "./sarvam.js";

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

export function createApp() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");

      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === "POST" && url.pathname === "/transcribe") {
        return await handleTranscribe(req, res);
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
    console.log(`  POST /transcribe  (multipart/form-data, field "audio")`);
    console.log(`  GET  /health`);
  });
  return server;
}
