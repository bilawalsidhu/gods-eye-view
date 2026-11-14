#!/usr/bin/env node
/** Offline scene-to-USD camera CLI. Reads JSON only; never loads .env or a viewer. */
import { readFile, writeFile, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  parseSceneDocument,
  SCENE_DOCUMENT_LIMITS,
} from '../src/director/document.js';
import { exportCameraUsda } from '../src/tooling/blenderCamera.js';

try {
  const { values } = parseArgs({
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
    if ((await stat(values.input)).size > SCENE_DOCUMENT_LIMITS.bytes)
      throw new Error('Scene exceeds 5 MiB');
    const document = parseSceneDocument(await readFile(values.input, 'utf8'));
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
    await writeFile(values.output, usda, { flag: 'wx' });
    console.log(
      `CAMERA_EXPORT_OK: ${samples.shots.length} shots, ${samples.frames.length} frames`,
    );
  }
} catch (error) {
  console.error(`Camera export failed: ${error.message}`);
  process.exitCode = 1;
}
