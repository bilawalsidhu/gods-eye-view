#!/usr/bin/env node
// Download the Porcupine wake-word model (Apache-2.0, Picovoice) into
// public/wakeword/. The npm package ships the engine and built-in keyword
// bytes but not the acoustic model, which must be served as a file. The
// download is pinned to the commit that shipped Porcupine 4.0 (matching
// @picovoice/porcupine-web 4.0.1) and checked against its SHA-256, like
// scripts/fetch-speaker-model.mjs.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const WAKEWORD_MODEL_COMMIT = '97b6ee6f353fc27132ab126497033eea91df416b';
export const WAKEWORD_MODEL_SHA256 =
  '0b0685f170c5e73259fb45c32f481b100cdffb8ef6a4d87be871519c8d17df36';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = path.join(root, 'public', 'wakeword');
const file = path.join(dir, 'porcupine_params.pv');
const url =
  'https://raw.githubusercontent.com/Picovoice/porcupine/' +
  `${WAKEWORD_MODEL_COMMIT}/lib/common/porcupine_params.pv`;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

if (existsSync(file) && sha256(readFileSync(file)) === WAKEWORD_MODEL_SHA256) {
  console.log(`wake word model present: ${file}`);
  process.exit(0);
}
mkdirSync(dir, { recursive: true });
console.log(`downloading ${url}`);
const response = await fetch(url);
if (!response.ok) {
  console.error(`download failed: HTTP ${response.status}`);
  process.exit(1);
}
const bytes = Buffer.from(await response.arrayBuffer());
const digest = sha256(bytes);
if (digest !== WAKEWORD_MODEL_SHA256) {
  console.error(`checksum mismatch: ${digest}`);
  process.exit(1);
}
writeFileSync(file, bytes);
console.log(`saved ${file} (${bytes.length} bytes, sha256 ${digest.slice(0, 12)}…)`);
