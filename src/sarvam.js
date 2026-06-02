// Core Sarvam AI Speech-to-Text client.
// Docs: https://docs.sarvam.ai/api-reference-docs/speech-to-text/transcribe

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

const SARVAM_STT_URL = "https://api.sarvam.ai/speech-to-text";

// Map common audio extensions to MIME types Sarvam accepts (wav/mp3 work best).
const MIME_BY_EXT = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".mpeg": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".flac": "audio/flac",
  ".webm": "audio/webm",
};

/**
 * Transcribe a single audio file via Sarvam's synchronous STT endpoint.
 *
 * @param {string} filePath              Path to the audio file.
 * @param {object} [options]
 * @param {string} [options.apiKey]      Sarvam API subscription key (defaults to env SARVAM_API_KEY).
 * @param {string} [options.language]    BCP-47 code (e.g. "hi-IN") or "unknown" for auto-detect. Default: "unknown".
 * @param {string} [options.model]       Sarvam model id. Default: "saarika:v2.5".
 * @returns {Promise<{transcript: string, language_code: string, request_id: string, raw: object}>}
 */
export async function transcribe(filePath, options = {}) {
  const {
    apiKey = process.env.SARVAM_API_KEY,
    language = "unknown", // auto mode by default
    model = "saarika:v2.5",
  } = options;

  if (!apiKey) {
    throw new Error(
      "Missing Sarvam API key. Set SARVAM_API_KEY in your environment (.env) or pass { apiKey }."
    );
  }

  const buffer = await readFile(filePath);
  const ext = extname(filePath).toLowerCase();
  const type = MIME_BY_EXT[ext] || "application/octet-stream";
  const file = new File([buffer], basename(filePath), { type });

  const form = new FormData();
  form.append("file", file);
  form.append("model", model);
  form.append("language_code", language); // "unknown" => Sarvam auto-detects the language

  let response;
  try {
    response = await fetch(SARVAM_STT_URL, {
      method: "POST",
      headers: { "api-subscription-key": apiKey },
      body: form,
    });
  } catch (err) {
    throw new Error(`Network error calling Sarvam: ${err.message}`);
  }

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const detail =
      data?.error?.message || data?.message || text || response.statusText;
    throw new Error(`Sarvam API error (${response.status}): ${detail}`);
  }

  return {
    transcript: data.transcript ?? "",
    language_code: data.language_code ?? language,
    request_id: data.request_id ?? "",
    raw: data,
  };
}
