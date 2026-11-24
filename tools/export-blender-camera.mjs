#!/usr/bin/env node
/** Offline scene-to-USD camera CLI. Reads JSON only; never loads .env or a viewer. */
import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  parseSceneDocument,
  SCENE_DOCUMENT_LIMITS,
} from '../src/director/document.js';
import { exportCameraUsda } from '../src/tooling/blenderCamera.js';

/** Read a regular file through one descriptor, at most one byte past the scene limit. */
async function readSceneText(path) {
  // Non-blocking, so a FIFO without a writer reaches the isFile check instead
  // of hanging in open(). Windows has no O_NONBLOCK.
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
  );
  try {
    if (!(await file.stat()).isFile())
      throw new Error('input must be a regular file');
    const buffer = Buffer.alloc(SCENE_DOCUMENT_LIMITS.bytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        length,
        buffer.length - length,
      );
      // Decode at EOF, dropping a UTF-8 BOM as Director's File.text() does.
      if (!bytesRead)
        return new TextDecoder().decode(buffer.subarray(0, length));
      length += bytesRead;
    }
    throw new Error('Scene exceeds 5 MiB');
  } finally {
    await file.close();
  }
}

try {
  // parseArgs reads a value starting with "-" as a missing argument, so join a
  // southern-hemisphere `--origin -33.86,151.21,0` into `--origin=...` first.
  const args = process.argv.slice(2);
  for (let i = args.length - 2; i >= 0; i -= 1) {
    if (args[i] === '--origin' && /^-[\d.]/.test(args[i + 1]))
      args.splice(i, 2, `--origin=${args[i + 1]}`);
  }
  const { values } = parseArgs({
    args,
    options: {
      input: { type: 'string' },
      output: { type: 'string' },
      scene: { type: 'string' },
      origin: { type: 'string' },
      fps: { type: 'string' },
      width: { type: 'string' },
      height: { type: 'string' },
      'horizontal-fov-deg': { type: 'string' },
      'sensor-width-mm': { type: 'string', default: '36' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(
      'Usage: node tools/export-blender-camera.mjs --input scene.json --output cameras.usda --origin lat,lon,ellipsoidHeight --fps 30 (or 30000/1001) --width 1920 --height 1080 --horizontal-fov-deg 60 [--scene id] [--sensor-width-mm 36]',
    );
  } else {
    for (const key of [
      'input',
      'output',
      'origin',
      'fps',
      'width',
      'height',
      'horizontal-fov-deg',
    ]) {
      if (!values[key]?.trim()) throw new Error(`Missing --${key}; use --help`);
    }
    if (!values.output.endsWith('.usda'))
      throw new Error('output must be a new file ending in .usda');
    if (!/^\d+(?:\/\d+)?$/.test(values.fps))
      throw new Error('fps must be an integer or integer ratio');
    const originParts = values.origin.split(',');
    if (originParts.length !== 3 || originParts.some((part) => !part.trim()))
      throw new Error('origin must be lat,lon,ellipsoidHeight');
    const document = parseSceneDocument(await readSceneText(values.input));
    const [numerator, denominator = 1] = values.fps.split('/').map(Number);
    const [lat, lon, height] = originParts.map(Number);
    const { usda, samples } = exportCameraUsda(document, {
      sceneId: values.scene,
      origin: { lat, lon, height },
      fps: { numerator, denominator },
      width: Number(values.width),
      height: Number(values.height),
      horizontalFovDegrees: Number(values['horizontal-fov-deg']),
      sensorWidthMm: Number(values['sensor-width-mm']),
    });
    const file = await open(values.output, 'wx', 0o600);
    try {
      await file.writeFile(usda);
      await file.close();
    } catch (error) {
      // Remove the partial stage this run created, so a retry can succeed.
      await file.close().catch(() => {});
      await unlink(values.output);
      throw error;
    }
    console.log(
      `CAMERA_EXPORT_OK: ${samples.shots.length} shots, ${samples.frames.length} frames`,
    );
  }
} catch (error) {
  // Field names and IDs come from the document: escape terminal control bytes.
  const message = String(error.message).replace(
    /[\x00-\x1f\x7f-\x9f]/g,
    (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`,
  );
  console.error(`Camera export failed: ${message}`);
  process.exitCode = 1;
}
