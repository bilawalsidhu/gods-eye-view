// Reproduction: the exporter samples the raw document, Director seeks the normalized one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sceneSeekState } from '../director/timeline.js';
import { parseSceneDocument } from '../director/document.js';
import { normalizeProject } from '../scenes/project.js';
import {
  effectiveShotHoldSec,
  shotRuntimeDurationSec,
} from '../scenes/shotPresentation.js';
import { createDefaultScenePacks } from '../scenes/packs/defaults.js';
import { sampleSceneCameras } from './blenderCamera.js';

const packs = createDefaultScenePacks();
const pose = (heading) => ({
  lat: 0,
  lon: 0,
  alt: 0,
  heading,
  pitch: 0,
  roll: 0,
});
const options = {
  origin: { lat: 0, lon: 0, height: 0 },
  fps: { numerator: 30, denominator: 1 },
  width: 1920,
  height: 1080,
  horizontalFovDegrees: 90,
};

test('Director import timing', () => {
  const text = JSON.stringify({
    version: 6,
    scenes: [
      {
        id: 'scene',
        title: 'S',
        shots: [
          { id: 'A', durationSec: 0.1, holdSec: 0, camera: pose(0) },
          { id: 'B', durationSec: 1, holdSec: 0, camera: pose(90) },
        ],
      },
    ],
  });
  const loaded = normalizeProject(parseSceneDocument(text)).scenes[0];
  assert.equal(loaded.shots[0].durationSec, 0.2, 'Director loads A as 0.2 s');
  let samples;
  try {
    samples = sampleSceneCameras(parseSceneDocument(text), options);
  } catch (error) {
    // Rejecting a timing-changing document is an acceptable fix.
    assert.match(error.message, /duration/i);
    return;
  }
  const dur = (s, shot) => shotRuntimeDurationSec(s, shot, packs);
  const hold = (s, shot) => effectiveShotHoldSec(s, shot, packs);
  const total = loaded.shots.reduce((sum, shot) => sum + dur(loaded, shot), 0);
  for (const frame of samples.frames) {
    const reference = sceneSeekState(loaded, frame.timeSec / total, dur, hold)
      .shot.id;
    assert.equal(frame.shotId, reference, `frame ${frame.frame}`);
  }
  assert.equal(samples.shots[1].frameStart, 7);
});
