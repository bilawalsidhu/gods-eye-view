#!/usr/bin/env node
// Writes the reference camera traces the conformance suite compares a
// renderer against: src/render/conformance/goldens/camera.json. Run it after
// a Cesium upgrade or a change to the camera scripts, and review the diff.
//
//   node scripts/record-camera-goldens.mjs [--check]
//
// With --check it writes nothing and exits 1 when the file is out of date.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordCameraGoldens } from '../src/render/cesium/cameraGoldens.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src/render/conformance/goldens/camera.json');

const text = `${JSON.stringify(await recordCameraGoldens(), null, 2)}\n`;
if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== text) {
    console.error(`${path.relative(ROOT, OUT)} is out of date`);
    process.exit(1);
  }
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(ROOT, OUT)}`);
}
