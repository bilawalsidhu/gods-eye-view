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

test('pointer input, camera holds and the stock clicks go through the one dispatcher', () => {
  // The dispatcher (src/input/dispatcher.js) applies the pointer claim once
  // per event for every subscriber, so a new tool does not have to find and
  // edit each layer. A layer that binds its own handler, writes the camera
  // flag or takes the stock clicks itself steps around that contract.
  const DISPATCHER = 'src/input/dispatcher.js';
  // Each rule names the one other module it belongs in, if any.
  const rules = [
    [
      /new\s+[\w.]*ScreenSpaceEventHandler\(/,
      'binds its own ScreenSpaceEventHandler',
      // The Cesium renderer's input port, the renderer's one handler.
      ['src/render/cesium/input.js'],
    ],
    [
      /\.enableInputs\s*=(?!=)/,
      'writes enableInputs instead of suspendCamera()',
      // The scene's camera-input holds, which own the flag.
      ['src/render/cesium/cameraInput.js'],
    ],
    [
      /(?:screenSpaceEventHandler|stockHandler)\??\.removeInputAction\(/,
      'removes stock clicks instead of suppressStockClicks()',
      // It runs the stock clicks itself.
      ['src/render/cesium/input.js'],
    ],
  ];
  const walk = (dir) =>
    fs
      .readdirSync(path.join(ROOT, dir), { withFileTypes: true })
      .flatMap((entry) => {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(rel);
        return entry.name.endsWith('.js') ? [rel] : [];
      });
  const offenders = [];
  for (const file of walk('src')) {
    if (file === DISPATCHER) continue;
    const source = read(file);
    for (const [pattern, what, allowed] of rules)
      if (!allowed.includes(file) && pattern.test(source))
        offenders.push(`${file} ${what}`);
  }
  assert.deepEqual(offenders, []);
});

test('ambient selection handlers never claim the pointer themselves', () => {
  // Claiming from a selection handler would deadlock every other layer the
  // moment a user clicked anything. Only tools claim.
  for (const file of [
    'src/input/dispatcher.js',
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
