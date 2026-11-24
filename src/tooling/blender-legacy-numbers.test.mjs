// Reproduction: version 1-2 documents with numeric strings parse but do not export.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSceneDocument } from '../director/document.js';
import { sampleSceneCameras } from './blenderCamera.js';

const options = {
  origin: { lat: 45, lon: 10, height: 0 },
  fps: { numerator: 30, denominator: 1 },
  width: 1920,
  height: 1080,
  horizontalFovDegrees: 90,
};
const doc = (shotChanges, cameraChanges) =>
  JSON.stringify({
    version: 2,
    scenes: [
      {
        id: 'scene',
        title: 'S',
        shots: [
          {
            id: 'A',
            durationSec: 4,
            holdSec: 0,
            ...shotChanges,
            camera: {
              lat: 45,
              lon: 10,
              alt: 100,
              heading: 0,
              pitch: -30,
              roll: 0,
              ...cameraChanges,
            },
          },
        ],
      },
    ],
  });

test('legacy numeric fields', () => {
  const numeric = sampleSceneCameras(parseSceneDocument(doc({}, {})), options);
  for (const [label, text] of [
    ['string coordinates', doc({}, { lat: '45', lon: '10', alt: '100' })],
    ['string duration', doc({ durationSec: '4' }, {})],
  ]) {
    const parsed = parseSceneDocument(text); // the Director validator accepts it
    const samples = sampleSceneCameras(parsed, options);
    assert.deepEqual(samples.frames, numeric.frames, label);
  }
});
