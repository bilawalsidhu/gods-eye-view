import test from 'node:test';
import assert from 'node:assert/strict';
import { groundSamplingContract } from '../../scripts/qa-cctv-surface.mjs';

test('the globe gate requires zero mesh queries, even when there is no tileset', () => {
  const surface = { globeVisible: true, tilesReady: false, sampleDelta: 0 };
  assert.equal(groundSamplingContract(surface).ok, true);
  assert.equal(
    groundSamplingContract({ ...surface, sampleDelta: 1 }).ok,
    false,
  );
});

test('photoreal sign-off cannot pass on a keyless terrain globe', () => {
  assert.equal(
    groundSamplingContract({
      globeVisible: true,
      tilesReady: true,
      sampleDelta: 2,
      requirePhotoreal: true,
    }).ok,
    false,
  );
});

test('a loaded photoreal surface must actually complete a mesh query', () => {
  const surface = { globeVisible: false, tilesReady: true, sampleDelta: 0 };
  assert.equal(groundSamplingContract(surface).ok, false);
  assert.equal(groundSamplingContract({ ...surface, sampleDelta: 1 }).ok, true);
});

test('unloaded photoreal tiles are unverified and fail required sign-off', () => {
  const surface = { globeVisible: false, tilesReady: false, sampleDelta: 0 };
  assert.equal(groundSamplingContract(surface).ok, null);
  assert.equal(
    groundSamplingContract({ ...surface, requirePhotoreal: true }).ok,
    false,
  );
});
