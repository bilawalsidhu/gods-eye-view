import test from 'node:test';
import assert from 'node:assert/strict';
import { createScenePackRegistry } from './registry.js';
import {
  effectiveShotHoldSec,
  shotRuntimeDurationSec,
  layerStatesForShot,
  visualStateForShot,
} from '../shotPresentation.js';

test('registered pack rules apply to another source without editing the Director or saved shots', () => {
  const recipe = {
    id: 'sample',
    runtimeHoldSecByBeat: { arrival: 6 },
    runtimeControlsByBeat: {
      arrival: { minimumHoldSec: 8, deferEvidenceUntilCameraSettled: true },
    },
  };
  let cancelled = 0;
  const packs = createScenePackRegistry({
    recipes: [recipe],
    adapters: [
      {
        resolveVisual: (_, visual) => ({ ...visual, mapStack: 'osm' }),
        cancelMotion: (getModule) => getModule('sample').cancelSceneMotion(),
      },
    ],
  });
  const shot = {
    id: 'a',
    sourcePackId: 'sample',
    durationSec: 2,
    holdSec: 1,
    visual: { style: 'normal' },
    layers: {
      sample: {
        enabled: true,
        params: { presentation: 'scene-beat', beatId: 'arrival' },
      },
    },
  };
  const scene = { id: 'scene', shots: [shot], releaseLayerIds: ['other'] };
  const before = structuredClone(shot);
  assert.equal(shotRuntimeDurationSec(scene, shot, packs), 10);
  assert.equal(effectiveShotHoldSec(scene, shot, packs), 8);
  const states = layerStatesForShot(scene, shot, packs, {
    cameraSettled: true,
  });
  assert.equal(states.sample.params.sceneControls.cameraSettled, true);
  assert.equal(states.sample.params.sceneContext.holdSec, 8);
  assert.equal(states.other.enabled, false);
  assert.equal(visualStateForShot(shot, packs, () => true).mapStack, 'osm');
  packs.cancelMotion(() => ({ cancelSceneMotion: () => cancelled++ }));
  assert.equal(cancelled, 1);
  assert.deepEqual(shot, before);
});
