import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  claimPointer,
  isLeaseCurrent,
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

test('the pointer starts free and a claim hands back a lease', () => {
  assert.equal(isPointerFree(), true);
  assert.equal(pointerOwner(), null);

  const lease = claimPointer('draw');
  assert.ok(lease, 'a successful claim returns a lease, not a boolean');
  assert.equal(isPointerFree(), false);
  assert.equal(pointerOwner(), 'draw');
  assert.equal(isPointerOwnedBy('draw'), true);
  assert.equal(isPointerOwnedBy('directions'), false);
  assert.equal(isLeaseCurrent(lease), true);
});

test('a claim is never stolen — not even by the same tool name', () => {
  const first = claimPointer('draw');
  assert.ok(first);

  assert.equal(
    claimPointer('directions'),
    null,
    'another tool must not displace it',
  );
  assert.equal(
    claimPointer('draw'),
    null,
    'a SECOND instance of the same tool is a second owner, not a no-op',
  );
  assert.equal(pointerOwner(), 'draw');
  assert.equal(isLeaseCurrent(first), true);
});

test('a replaced instance cannot free its successor’s claim', () => {
  // The bug this rule exists for. An old Draw instance is torn down while a new
  // one is already running; the old teardown calls releasePointer. Under
  // release-by-name that freed the LIVE claim and every layer started selecting
  // through the new instance's vertices.
  const stale = claimPointer('draw');
  assert.ok(releasePointer(stale), 'the old instance gives the pointer back');

  const live = claimPointer('draw');
  assert.ok(live, 'the replacement takes it');
  assert.notEqual(live.id, stale.id, 'a fresh claim is a fresh lease');

  assert.equal(releasePointer(stale), false, 'the stale lease frees nothing');
  assert.equal(pointerOwner(), 'draw', 'the replacement still holds it');
  assert.equal(isLeaseCurrent(stale), false);
  assert.equal(isLeaseCurrent(live), true);

  assert.equal(releasePointer(live), true);
  assert.equal(isPointerFree(), true);
});

test('release ignores anything that is not the live lease', () => {
  const lease = claimPointer('draw');
  for (const bad of [
    null,
    undefined,
    'draw',
    {},
    { owner: 'draw', id: lease.id + 99 },
  ]) {
    assert.equal(releasePointer(bad), false, JSON.stringify(bad));
    assert.equal(pointerOwner(), 'draw');
  }
  assert.equal(releasePointer(lease), true);
  assert.equal(releasePointer(lease), false, 'releasing twice changes nothing');
});

test('a claim needs a real owner id', () => {
  for (const bad of ['', '   ', null, undefined, 7, {}]) {
    assert.equal(claimPointer(bad), null, JSON.stringify(bad));
    assert.equal(isPointerFree(), true);
  }
  const lease = claimPointer('  draw  ');
  assert.ok(lease, 'ids are trimmed, not rejected for padding');
  assert.equal(pointerOwner(), 'draw');
  assert.equal(releasePointer(lease), true);
});

test('reset reports who was holding it, for teardown', () => {
  assert.equal(resetPointerOwnership(), null);
  const lease = claimPointer('draw');
  assert.equal(resetPointerOwnership(), 'draw');
  assert.equal(isPointerFree(), true);
  assert.equal(isLeaseCurrent(lease), false);
});

test('every scene click handler consults ownership before it picks', () => {
  // This is the whole point of a shared contract: a new tool must not have to
  // find and edit each of these. If a layer grows a click handler it has to
  // appear here too.
  const guarded = [
    ['src/data/trackingGesture.js', 'onClick(click, gesture);'],
    [
      'src/layers/infrastructure/render/display.js',
      'const picked = event.picked;',
    ],
    ['src/data/cctvGizmo.js', 'pickGizmoPart(event)'],
    // ALPR and bikeshare take the engine's click with its pick.
    ['src/layers/shared/selectionKeeper.js', 'const id = pickId(event);'],
    ['src/layers/bikeshare/render/display.js', 'const picked = event.picked;'],
    // FIRMS takes the engine dispatcher's click with its pick.
    ['src/layers/firms/selection.js', 'const picked = click.picked;'],
    ['src/layers/launches/render/display.js', '[ctx.picked, ...ctx.drilled]'],
    [
      'src/layers/radio/interaction.js',
      'const stationId = pickedRadioStationAt(position);',
    ],
    // Satellites take the engine dispatcher's pick too.
    [
      'src/layers/satellites/interaction.js',
      'getRenderer().isTrackedPick(picked',
    ],
    [
      'src/layers/submarineCables/render/display.js',
      'const picked = event.picked;',
    ],
    // Vessels take the engine dispatcher's pick: the guard
    // comes before the click rule reads it.
    ['src/layers/vessels/selection.js', 'resolvePickId(picked)'],
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
    'src/data/trackingGesture.js',
    'src/layers/infrastructure/render/display.js',
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
