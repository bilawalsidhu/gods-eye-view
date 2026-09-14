import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  claimPointer,
  isPointerFree,
  isPointerOwnedBy,
  pointerOwner,
  releasePointer,
  resetPointerOwnership,
} from './inputOwnership.js';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test.beforeEach(() => resetPointerOwnership());

test('the pointer starts free and a claim takes it', () => {
  assert.equal(isPointerFree(), true);
  assert.equal(pointerOwner(), null);
  assert.equal(claimPointer('draw'), true);
  assert.equal(isPointerFree(), false);
  assert.equal(pointerOwner(), 'draw');
  assert.equal(isPointerOwnedBy('draw'), true);
  assert.equal(isPointerOwnedBy('directions'), false);
});

test('a claim is never stolen, and re-claiming as the holder is a no-op', () => {
  assert.equal(claimPointer('draw'), true);
  assert.equal(
    claimPointer('directions'),
    false,
    'a second tool must not displace the first',
  );
  assert.equal(pointerOwner(), 'draw');
  assert.equal(claimPointer('draw'), true, 'the holder may claim again');
  assert.equal(pointerOwner(), 'draw');
});

test('only the holder can release, so a late teardown cannot free a successor', () => {
  claimPointer('draw');
  assert.equal(
    releasePointer('directions'),
    false,
    'a stranger cannot release it',
  );
  assert.equal(pointerOwner(), 'draw');
  assert.equal(releasePointer('draw'), true);
  assert.equal(isPointerFree(), true);
  assert.equal(
    releasePointer('draw'),
    false,
    'releasing a free pointer changes nothing',
  );

  // The case this rule exists for: an old tool's teardown running after a new
  // tool has already taken the pointer.
  claimPointer('directions');
  assert.equal(releasePointer('draw'), false);
  assert.equal(pointerOwner(), 'directions');
});

test('a claim needs a real owner id', () => {
  for (const bad of ['', '   ', null, undefined, 7, {}]) {
    assert.equal(claimPointer(bad), false, JSON.stringify(bad));
    assert.equal(isPointerFree(), true);
  }
  assert.equal(
    claimPointer('  draw  '),
    true,
    'ids are trimmed, not rejected for padding',
  );
  assert.equal(pointerOwner(), 'draw');
  assert.equal(releasePointer('draw'), true);
});

test('reset reports who was holding it, for teardown', () => {
  assert.equal(resetPointerOwnership(), null);
  claimPointer('draw');
  assert.equal(resetPointerOwnership(), 'draw');
  assert.equal(isPointerFree(), true);
});

test('every scene click handler consults ownership before it picks', () => {
  // This is the whole point of a shared contract: a new tool must not have to
  // find and edit each of these. If a layer grows a click handler it has to
  // appear here too.
  const guarded = [
    ['src/data/trackingClickGesture.js', 'onClick(click, gesture);'],
    ['src/data/localGeojsonCore.js', 'viewer.scene.pick(click.position)'],
    ['src/data/cctvGizmo.js', 'pickGizmoPart(event.position)'],
    ['src/layers/bikeshare/selection.js', 'viewer.scene.pick(click.position)'],
    ['src/layers/firms/selection.js', 'scene.pick(click.position)'],
    [
      'src/layers/installations/selection.js',
      'viewer.scene.pick(click.position)',
    ],
    ['src/layers/launches/lifecycle.js', 'drillPick(movement.position'],
    ['src/layers/radio/interaction.js', 'pickedRadioStationAt(click.position)'],
    [
      'src/layers/satellites/interaction.js',
      'viewer.scene.pick(click.position)',
    ],
    [
      'src/layers/submarineCables/interaction.js',
      'viewer.scene.pick(click.position)',
    ],
    ['src/layers/vessels/selection.js', 'viewer.scene.pick(click.position)'],
  ];
  for (const [file, firstPick] of guarded) {
    const source = read(file);
    assert.match(
      source,
      /import \{ isPointerFree \} from '[^']*inputOwnership\.js';/,
      `${file} must consult the shared pointer claim`,
    );
    const guardAt = source.indexOf('if (!isPointerFree()) return;');
    const pickAt = source.indexOf(firstPick);
    assert.ok(guardAt >= 0, `${file} is missing the guard`);
    assert.ok(
      pickAt >= 0,
      `${file}: could not find its pick call (${firstPick})`,
    );
    assert.ok(
      guardAt < pickAt,
      `${file} must yield before it picks, not after`,
    );
  }
});

test('ambient selection handlers never claim the pointer themselves', () => {
  // Claiming from a selection handler would deadlock every other layer the
  // moment a user clicked anything. Only tools claim.
  for (const file of [
    'src/data/trackingClickGesture.js',
    'src/data/localGeojsonCore.js',
    'src/data/cctvGizmo.js',
    'src/layers/vessels/selection.js',
    'src/layers/satellites/interaction.js',
  ]) {
    assert.doesNotMatch(
      read(file),
      /claimPointer\(/,
      `${file} must not claim the pointer`,
    );
  }
});
