#!/usr/bin/env node
// Start the Sarvam transcription HTTP API.
//
// Usage:
//   node bin/serve.js            # listens on PORT or 3000
//   PORT=8080 node bin/serve.js
//
// Requires SARVAM_API_KEY in the environment (or a .env file).

import { startServer } from "../src/server.js";

// Load .env if present (Node >=20.6).
try {
  process.loadEnvFile();
} catch {
  // No .env file — rely on the real environment.
}

if (!process.env.SARVAM_API_KEY) {
  console.error(
    "Warning: SARVAM_API_KEY is not set. Requests will fail until you set it " +
      "(copy .env.example to .env and add your key)."
  );
}

startServer();
