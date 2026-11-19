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
  bridgePointer,
} from './inputOwnership.js';
import { createInputRouter } from '../render/input/router.js';

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

test('the newest claim takes over and the holder it replaces is told, once', () => {
  const told = [];
  const first = claimPointer('draw', { onLost: () => told.push('draw') });
  const second = claimPointer('directions', {
    onLost: () => told.push('directions'),
  });
  assert.ok(second, 'a second claim is not refused');
  assert.deepEqual(told, ['draw']);
  assert.equal(pointerOwner(), 'directions');
  assert.equal(isLeaseCurrent(first), false);
  assert.equal(isLeaseCurrent(second), true);
  assert.equal(
    releasePointer(first),
    false,
    'the old late release frees nothing',
  );
  assert.equal(pointerOwner(), 'directions');
  assert.deepEqual(told, ['draw'], 'told once');
  assert.equal(releasePointer(second), true);
  assert.deepEqual(told, ['draw'], 'a holder that lets go is not told');
});

test('a second instance of the same tool takes over from the first', () => {
  // An old instance mid-teardown and its replacement already running are two
  // owners: the replacement wins, and the old one is told to turn off.
  let lost = 0;
  const old = claimPointer('draw', { onLost: () => (lost += 1) });
  const live = claimPointer('draw');
  assert.notEqual(live.id, old.id);
  assert.equal(lost, 1);
  assert.equal(isLeaseCurrent(live), true);
});

test('the holder is told after the new claim holds the pointer; its error stays its own', (t) => {
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  let seen = null;
  const first = claimPointer('draw', {
    onLost: () => {
      seen = { owner: pointerOwner(), current: isLeaseCurrent(first) };
      throw new Error('onLost');
    },
  });
  const second = claimPointer('directions');
  assert.deepEqual(seen, { owner: 'directions', current: false });
  assert.equal(isLeaseCurrent(second), true);
  assert.equal(errors.length, 1);
});

test('reset tells no one', () => {
  let lost = 0;
  claimPointer('draw', { onLost: () => (lost += 1) });
  resetPointerOwnership();
  claimPointer('directions');
  assert.equal(lost, 0);
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
      // The scene's camera-input holds, which own the flag; the Context
      // card's previews turn it off in their own small scenes, which take
      // no input at all.
      ['src/render/cesium/cameraInput.js', 'src/render/cesium/cardPreviews.js'],
    ],
    [
      /(?:screenSpaceEventHandler|stockHandler)\??\.removeInputAction\(/,
      'removes stock clicks instead of suppressStockClicks()',
      // It runs the stock clicks itself; the viewer's factory drops the
      // stock double-click before any input port exists.
      ['src/render/cesium/input.js', 'src/render/cesium/applicationViewer.js'],
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

/** A renderer's input port, as the contract's router keeps it. */
const portOf = () =>
  createInputRouter({
    report: (error) => {
      throw error;
    },
    suspendCamera: () => () => {},
  }).port;

test('a bridged port holds a lease for as long as a tool holds the pointer', () => {
  const port = portOf();
  const bridge = bridgePointer(port);
  assert.equal(bridge.lease(), null);
  const lease = claimPointer('draw');
  assert.equal(port.isPointerFree(), false, 'the port is taken too');
  assert.equal(bridge.lease().owner, 'draw');
  assert.equal(bridge.lease().current, true);
  const next = claimPointer('directions');
  assert.equal(bridge.lease().owner, 'directions');
  releasePointer(lease);
  assert.equal(port.isPointerFree(), false, 'a stale release frees nothing');
  releasePointer(next);
  assert.equal(port.isPointerFree(), true);
  assert.equal(bridge.lease(), null);
  bridge.off();
});

test('a claim made on the port takes over from the page’s tool, and back', () => {
  const port = portOf();
  const bridge = bridgePointer(port);
  const told = [];
  const page = claimPointer('draw', { onLost: () => told.push('draw') });
  const other = port.claimPointer('other', {
    onLost: () => told.push('other'),
  });
  assert.deepEqual(told, ['draw'], 'the page’s tool is told');
  assert.equal(isLeaseCurrent(page), false);
  assert.equal(
    isPointerFree(),
    false,
    'the port’s own claim holds the pointer',
  );
  assert.equal(bridge.lease(), null);
  claimPointer('directions');
  assert.deepEqual(told, ['draw', 'other'], 'a newer page claim takes it back');
  assert.equal(other.current, false);
  assert.equal(bridge.lease().owner, 'directions');
  bridge.off();
});

test('a port bridged while a tool holds the pointer takes its lease at once; off gives it back', () => {
  const lease = claimPointer('draw');
  const port = portOf();
  const bridge = bridgePointer(port);
  assert.equal(port.isPointerFree(), false);
  bridge.off();
  assert.equal(port.isPointerFree(), true);
  assert.equal(isLeaseCurrent(lease), true, 'the page claim stands');
  assert.equal(isPointerFree(), false);
});
