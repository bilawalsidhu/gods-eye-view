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
  subscribePointerOwnership,
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
  assert.equal(
    releasePointer(null),
    false,
    'null cannot release a free pointer',
  );
});

test('only the exact opaque lease object is current and can release', () => {
  const lease = claimPointer('draw');
  const forgedCopy = { ...lease };

  assert.equal(isLeaseCurrent(forgedCopy), false);
  assert.equal(releasePointer(forgedCopy), false);
  assert.equal(isLeaseCurrent(lease), true);
  assert.equal(releasePointer(lease), true);
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

test('throwing subscribers are isolated from ownership APIs and later subscribers', () => {
  const calls = [];
  const originalError = console.error;
  console.error = () => {};
  const unsubscribeThrowing = subscribePointerOwnership(() => {
    calls.push('throwing');
    throw new Error('subscriber failed');
  });
  const unsubscribeLater = subscribePointerOwnership(() =>
    calls.push(pointerOwner()),
  );

  try {
    let lease;
    assert.doesNotThrow(() => {
      lease = claimPointer('draw');
    });
    assert.equal(isLeaseCurrent(lease), true);
    assert.doesNotThrow(() => assert.equal(releasePointer(lease), true));
    const resetLease = claimPointer('directions');
    assert.doesNotThrow(() =>
      assert.equal(resetPointerOwnership(), 'directions'),
    );
    assert.equal(isLeaseCurrent(resetLease), false);
    assert.deepEqual(calls, [
      'throwing',
      'draw',
      'throwing',
      null,
      'throwing',
      'directions',
      'throwing',
      null,
    ]);
  } finally {
    unsubscribeThrowing();
    unsubscribeLater();
    console.error = originalError;
  }
});

test('an ownership observer cannot reentrantly claim or release', () => {
  const lease = claimPointer('first');
  let successor;
  let released;
  let calls = 0;
  const unsubscribe = subscribePointerOwnership(() => {
    calls += 1;
    if (calls !== 1) return;
    successor = claimPointer('successor');
    released = releasePointer(successor);
  });

  try {
    assert.equal(releasePointer(lease), true);
    assert.equal(successor, null, 'observers cannot claim during notification');
    assert.equal(
      released,
      false,
      'observers cannot release during notification',
    );
    assert.equal(isPointerFree(), true);
    assert.equal(
      calls,
      1,
      'reentrant mutation cannot queue another publication',
    );
  } finally {
    unsubscribe();
  }
});

test('an ownership observer cannot reentrantly reset', () => {
  let resetResult;
  let calls = 0;
  const unsubscribe = subscribePointerOwnership(() => {
    calls += 1;
    resetResult = resetPointerOwnership();
  });

  try {
    const lease = claimPointer('first');
    assert.ok(lease, 'the outer claim succeeds');
    assert.equal(
      resetResult,
      null,
      'an observer reports its reset no-op truthfully',
    );
    assert.equal(isLeaseCurrent(lease), true);
    assert.equal(
      calls,
      1,
      'a continuous reset observer cannot publish forever',
    );
  } finally {
    unsubscribe();
  }
});

test('unsubscribe is immediate and idempotent during publication', () => {
  const calls = [];
  let unsubscribeLater;
  const unsubscribeFirst = subscribePointerOwnership(() => {
    calls.push('first');
    unsubscribeLater();
    unsubscribeLater();
  });
  unsubscribeLater = subscribePointerOwnership(() => calls.push('later'));

  try {
    const lease = claimPointer('draw');
    assert.deepEqual(calls, ['first']);
    assert.equal(releasePointer(lease), true);
    assert.deepEqual(calls, ['first', 'first']);
  } finally {
    unsubscribeFirst();
    unsubscribeLater();
  }
});

test('every scene click handler consults ownership before it picks', () => {
  // This is the whole point of a shared contract: a new tool must not have to
  // find and edit each of these. If a layer grows a click handler it has to
  // appear here too.
  const guarded = [
    ['src/data/trackingClickGesture.js', 'onClick(click, gesture);'],
    ['src/data/localGeojsonCore.js', 'viewer.scene.pick(click.position)'],
    ['src/data/cctvGizmo.js', 'pickGizmoPart(event.position)'],
    ['src/layers/alpr/presentation.js', 'viewer.scene.pick(click.position)'],
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
    [
      'src/layers/vessels/selection.js',
      'pickContact(viewer.scene, click.position)',
    ],
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
