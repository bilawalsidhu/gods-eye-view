#!/usr/bin/env node
// Download the speaker-embedding model used for voice identity into
// .local/models/ (gitignored). Model: WeSpeaker CAM++ trained on VoxCeleb,
// exported to ONNX by the sherpa-onnx project (input "feats" [1, T, 80] Kaldi
// fbank, output "embs" [1, 512], 29 MB, CPU-only via onnxruntime).
// Licence: Apache-2.0 (WeSpeaker, https://github.com/wenet-e2e/wespeaker;
// redistribution by sherpa-onnx, https://github.com/k2-fsa/sherpa-onnx, also
// Apache-2.0). VoxCeleb itself is CC BY 4.0 research data; the trained weights
// are what ship here. See docs/SPEAKER-ID.md.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const SPEAKER_MODEL_NAME = 'wespeaker_en_voxceleb_CAM++';
export const SPEAKER_MODEL_SHA256 =
  'c46fad10b5f81e1aa4a60c162714208577093655076c5450f8c469e522ec54ef';
const url =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/' +
  'speaker-recongition-models/wespeaker_en_voxceleb_CAM%2B%2B.onnx';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = path.join(root, '.local', 'models');
const file = path.join(dir, `${SPEAKER_MODEL_NAME}.onnx`);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

if (existsSync(file) && sha256(readFileSync(file)) === SPEAKER_MODEL_SHA256) {
  console.log(`speaker model present: ${file}`);
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
if (digest !== SPEAKER_MODEL_SHA256) {
  console.error(`checksum mismatch: ${digest}`);
  process.exit(1);
}
writeFileSync(file, bytes);
console.log(`saved ${file} (${bytes.length} bytes, sha256 ${digest.slice(0, 12)}…)`);
