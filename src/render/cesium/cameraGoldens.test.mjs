import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recordCameraGoldens } from './cameraGoldens.js';

test('the committed camera traces are what the installed Cesium records', async () => {
  const committed = readFileSync(
    new URL('../conformance/goldens/camera.json', import.meta.url),
    'utf8',
  );
  const recorded = `${JSON.stringify(await recordCameraGoldens(), null, 2)}\n`;
  assert.ok(
    recorded === committed,
    'goldens/camera.json is out of date: run node scripts/record-camera-goldens.mjs and review the diff',
  );
});
