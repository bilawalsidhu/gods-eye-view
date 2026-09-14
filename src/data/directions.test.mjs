import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  DEFAULT_DIRECTIONS_MODE,
  DIRECTIONS_MODES,
  DIRECTIONS_POINTER_OWNER,
  DIRECTIONS_ROUTE_COLOR,
  createDirectionsStepOverlayEntry,
  directionsRequestUrl,
  directionsRowControls,
  directionsStats,
  directionsStepCopy,
  directionsStepList,
  normalizeDirectionsParams,
  normalizeRoutePayload,
  stepAnchorDelayMs,
  stepIndexAtDistance,
  stepMarkerHeightM,
  stepMarkerIndices,
  pointerBlockedMessage,
  POINTER_TOOL_EXITS,
  STEP_ANCHOR_DEADLINE_MS,
  STEP_ANCHOR_RETRY_MS,
  STEP_ANCHOR_SLOW_RETRY_MS,
  STEP_ANCHOR_FAST_ATTEMPTS,
  createApplicationDirectionsLayer,
} from './directions.js';
import { GROUND_FLOOR_LIFT_M } from './groundFloor.js';
import {
  claimPointer,
  isPointerFree,
  pointerOwner,
  releasePointer,
  resetPointerOwnership,
} from './inputOwnership.js';

/** Take the pointer as some other tool, and hand back its release. */
function claimAs(owner) {
  const lease = claimPointer(owner);
  assert.ok(lease, `${owner} should have taken the pointer`);
  return () => releasePointer(lease);
}
import { LAYER_STATE_REGISTRY } from './layerState.js';
import { SPRITE_LAYER_ORDER } from './spriteOrder.js';

/** The instance under test; each ownership fixture builds a fresh one. */
let directionsLayer = createApplicationDirectionsLayer();

const idle = {
  enabled: true,
  mode: 'car',
  armed: null,
  a: null,
  b: null,
  status: 'idle',
  error: null,
  route: null,
  lastUpdate: null,
};
const A = { lat: 60.1699, lon: 24.9384 };
const B = { lat: 60.2055, lon: 24.6559 };
const route = {
  distanceM: 21479,
  durationS: 1478,
  geometry: [
    [24.9384, 60.1699],
    [24.6559, 60.2055],
  ],
  steps: [
    {
      index: 0,
      instruction: 'Head out on Kaivokatu',
      distanceM: 8,
      durationS: 1,
      lat: 60.1699,
      lon: 24.9384,
    },
    {
      index: 1,
      instruction: 'Turn right onto Kansakoulukatu',
      distanceM: 236,
      durationS: 39,
      lat: 60.1683,
      lon: 24.9349,
    },
    {
      index: 2,
      instruction: 'Arrive at your destination',
      distanceM: 0,
      durationS: 0,
      lat: 60.2055,
      lon: 24.6559,
    },
  ],
  mode: 'car',
};

test('layer module declares the manager contract, params, and row controls', () => {
  assert.equal(directionsLayer.id, 'directions');
  assert.equal(directionsLayer.updateInterval, 0);
  for (const method of [
    'init',
    'enable',
    'disable',
    'update',
    'getStats',
    'destroy',
    'setParams',
    'getParams',
    'getRowControls',
    'setRowControlsListener',
    'attachDataManager',
  ]) {
    assert.equal(
      typeof directionsLayer[method],
      'function',
      `${method} is implemented`,
    );
  }
  assert.deepEqual(directionsLayer.getParams(), {
    mode: DEFAULT_DIRECTIONS_MODE,
  });
  const entry = LAYER_STATE_REGISTRY.find((row) => row.id === 'directions');
  assert.ok(entry, 'directions has a share-link token');
  assert.equal(
    LAYER_STATE_REGISTRY.filter((row) => row.token === entry.token).length,
    1,
  );
  assert.ok(SPRITE_LAYER_ORDER.includes('directions'));
});

test('params: unknown modes are rejected, commands and arm state are normalized', () => {
  assert.deepEqual(normalizeDirectionsParams({ mode: 'FOOT' }), {
    mode: 'foot',
  });
  assert.equal(normalizeDirectionsParams({ mode: 'rocket' }), null);
  assert.deepEqual(normalizeDirectionsParams({ arm: 'a' }), { arm: 'a' });
  assert.deepEqual(normalizeDirectionsParams({ arm: 'zzz' }), { arm: null });
  assert.deepEqual(
    normalizeDirectionsParams({ swap: true, fly: true, clear: true }),
    { swap: true, fly: true, clear: true },
  );
  assert.deepEqual(normalizeDirectionsParams({ swap: 'yes' }), {});
  assert.deepEqual(normalizeDirectionsParams(), {});
  // The live module refuses an unknown mode without touching state.
  assert.equal(directionsLayer.setParams({ mode: 'rocket' }), false);
  assert.deepEqual(directionsLayer.getParams(), {
    mode: DEFAULT_DIRECTIONS_MODE,
  });
});

test('row chips: modes, arming, and command availability follow the state', () => {
  const { chips } = directionsRowControls(idle);
  const ids = chips.map((c) => c.id);
  assert.deepEqual(ids, [
    'mode-car',
    'mode-foot',
    'mode-bike',
    'set-a',
    'set-b',
    'swap',
    'fly',
    'clear',
  ]);
  assert.equal(chips.find((c) => c.id === 'mode-car').active, true);
  assert.equal(chips.find((c) => c.id === 'set-a').label, 'SET A');
  assert.deepEqual(chips.find((c) => c.id === 'set-a').params, { arm: 'a' });
  assert.equal(chips.find((c) => c.id === 'fly').disabled, true);
  assert.equal(chips.find((c) => c.id === 'swap').disabled, true);
  assert.equal(chips.find((c) => c.id === 'clear').disabled, true);

  const armed = directionsRowControls({ ...idle, armed: 'a' }).chips;
  assert.equal(armed.find((c) => c.id === 'set-a').label, 'CLICK MAP');
  assert.deepEqual(
    armed.find((c) => c.id === 'set-a').params,
    { arm: null },
    'clicking again cancels',
  );

  const ready = directionsRowControls({
    ...idle,
    a: A,
    b: B,
    status: 'ready',
    route,
  }).chips;
  assert.equal(ready.find((c) => c.id === 'set-a').label, 'A ✓');
  assert.equal(ready.find((c) => c.id === 'fly').disabled, false);
  assert.equal(ready.find((c) => c.id === 'swap').disabled, false);
  assert.equal(ready.find((c) => c.id === 'clear').disabled, false);

  const routing = directionsRowControls({
    ...idle,
    a: A,
    b: B,
    status: 'routing',
  }).chips;
  assert.equal(routing.find((c) => c.id === 'fly').busy, true);
  for (const mode of Object.keys(DIRECTIONS_MODES))
    assert.ok(ids.includes(`mode-${mode}`));
});

test('stats guide the user, show progress, and summarize a route honestly', () => {
  assert.equal(directionsStats(idle).coverage, 'SET A, then click the globe');
  assert.equal(
    directionsStats({ ...idle, armed: 'b' }).coverage,
    'Click the globe to place B',
  );
  assert.equal(
    directionsStats({ ...idle, a: A }).coverage,
    'SET B, then click the globe',
  );
  const routing = directionsStats({ ...idle, a: A, b: B, status: 'routing' });
  assert.equal(routing.loading, true);
  const ready = directionsStats({
    ...idle,
    a: A,
    b: B,
    status: 'ready',
    route,
    lastUpdate: 5,
  });
  assert.equal(ready.count, 3);
  assert.equal(ready.coverage, '21 km · 25 min · Drive');
  assert.equal(
    ready.loadingLabel,
    '21 km · 25 min · Drive',
    'the summary is the row detail line',
  );
  assert.equal(ready.loading, undefined);
  assert.equal(
    directionsStats(idle).loadingLabel,
    'SET A, then click the globe',
  );
  const failed = directionsStats({
    ...idle,
    a: A,
    b: B,
    status: 'error',
    error: 'No route found between A and B',
  });
  assert.equal(failed.error, 'No route found between A and B');
  assert.equal(failed.count, 0);
  assert.equal(directionsLayer.getStats().count, 0);
});

test('step cards name the maneuver, its leg, and what comes next', () => {
  const copy = directionsStepCopy(route.steps, 1);
  assert.equal(copy.title, 'Turn right onto Kansakoulukatu');
  assert.deepEqual(copy.details, [
    'Step 2 of 3 · then 240 m · 39 s',
    'Then: Arrive at your destination',
  ]);
  const last = directionsStepCopy(route.steps, 2);
  assert.deepEqual(last.details, ['Step 3 of 3']);
  const position = Cesium.Cartesian3.fromDegrees(24.9349, 60.1683, 2);
  const card = createDirectionsStepOverlayEntry(1, position, copy);
  assert.equal(card.accent, DIRECTIONS_ROUTE_COLOR);
  assert.equal(card.id, 'directions-step-1');
  assert.equal(createDirectionsStepOverlayEntry(null, position, copy), null);
});

test('the proxy request carries both endpoints, the profile, and asks for steps', () => {
  const url = directionsRequestUrl('foot', A, B);
  assert.match(
    url,
    /^\/api\/route\?profile=foot&coords=24\.938400%2C60\.169900%3B24\.655900%2C60\.205500&steps=1$/,
  );
});

test('route payloads are validated; a failed route never becomes a straight line', () => {
  const ok = normalizeRoutePayload(
    {
      ok: true,
      distanceM: 21479,
      durationS: 1478,
      geometry: route.geometry,
      steps: route.steps,
    },
    'car',
  );
  assert.equal(ok.distanceM, 21479);
  assert.equal(ok.steps.length, 3);
  assert.equal(ok.mode, 'car');
  assert.equal(
    normalizeRoutePayload({ ok: false, error: 'no route found' }, 'car'),
    null,
  );
  assert.equal(
    normalizeRoutePayload({ ok: true, geometry: [[1, 1]] }, 'car'),
    null,
  );
  assert.equal(
    normalizeRoutePayload(
      {
        ok: true,
        geometry: [
          [999, 1],
          [1, 1],
        ],
      },
      'car',
    ),
    null,
  );
  const noSteps = normalizeRoutePayload(
    { ok: true, geometry: route.geometry },
    'bike',
  );
  assert.deepEqual(noSteps.steps, []);
  assert.equal(normalizeRoutePayload(null, 'car'), null);
});

test('maneuver dots skip departure and arrival and ride the shared ground floor', () => {
  assert.deepEqual(stepMarkerIndices(route.steps), [1]);
  assert.deepEqual(stepMarkerIndices([]), []);
  assert.deepEqual(stepMarkerIndices(null), []);
  assert.deepEqual(
    stepMarkerIndices([{}, {}, {}, {}, {}]),
    [1, 2, 3],
    'every decision between the endpoints gets a dot',
  );
  // Denver: ground is ~1.6 km ellipsoidal. A dot fixed near zero would sit a
  // kilometre and a half under the junction it marks.
  const lift = GROUND_FLOOR_LIFT_M;
  assert.equal(stepMarkerHeightM(1609.3, lift), 1609.3 + lift);
  assert.equal(stepMarkerHeightM(0, lift), lift);
  assert.equal(
    stepMarkerHeightM(null, lift),
    null,
    'a cold cell has no honest height',
  );
  assert.equal(stepMarkerHeightM(undefined, lift), null);
  assert.equal(stepMarkerHeightM(Number.NaN, lift), null);
});

test('the turn-by-turn list is ordered, labelled, and highlights the flown step', () => {
  assert.equal(directionsStepList({ route: null }), null);
  assert.equal(directionsStepList({ route: { steps: [] } }), null);
  const list = directionsStepList({
    route,
    selectedStep: null,
    flightStep: null,
  });
  assert.deepEqual(
    list.items.map((item) => item.ordinal),
    [1, 2, 3],
    'items are in route order',
  );
  assert.deepEqual(
    list.items.map((item) => item.text),
    route.steps.map((step) => step.instruction),
  );
  assert.deepEqual(
    list.items.map((item) => item.lead),
    ['8 m', '240 m', '0 m'],
  );
  assert.deepEqual(
    list.items.map((item) => item.params),
    [{ step: 0 }, { step: 1 }, { step: 2 }],
  );
  assert.equal(
    list.items.some((item) => item.active),
    false,
  );

  const selected = directionsStepList({
    route,
    selectedStep: 2,
    flightStep: null,
  });
  assert.deepEqual(
    selected.items.map((item) => item.active),
    [false, false, true],
  );
  assert.deepEqual(
    selected.items.map((item) => item.current),
    [false, false, false],
  );

  // A running FLY owns the highlight; the clicked step yields to it.
  const flying = directionsStepList({ route, selectedStep: 2, flightStep: 1 });
  assert.deepEqual(
    flying.items.map((item) => item.active),
    [false, true, false],
  );
  assert.deepEqual(
    flying.items.map((item) => item.current),
    [false, true, false],
  );

  const rowList = directionsRowControls({
    ...idle,
    a: A,
    b: B,
    status: 'ready',
    route,
  }).list;
  assert.equal(rowList.items.length, 3);
  assert.equal(rowList.ariaLabel, 'Turn-by-turn directions');
  assert.equal(directionsRowControls(idle).list, null, 'no route, no list');
});

test('the flown step follows distance travelled, never running off either end', () => {
  const steps = [{ distanceM: 100 }, { distanceM: 250 }, { distanceM: 0 }];
  assert.equal(stepIndexAtDistance(steps, 0), 0);
  assert.equal(stepIndexAtDistance(steps, 99), 0);
  assert.equal(stepIndexAtDistance(steps, 100), 1);
  assert.equal(stepIndexAtDistance(steps, 349), 1);
  assert.equal(stepIndexAtDistance(steps, 350), 2, 'the arrival step is last');
  assert.equal(stepIndexAtDistance(steps, 99999), 2);
  assert.equal(stepIndexAtDistance(steps, -5), 0);
  assert.equal(stepIndexAtDistance(steps, Number.NaN), 0);
  assert.equal(stepIndexAtDistance([], 10), null);
  assert.equal(stepIndexAtDistance(null, 10), null);
});

test('the FLY chip reports a flight in progress', () => {
  const flying = directionsRowControls({
    ...idle,
    a: A,
    b: B,
    status: 'ready',
    route,
    flightStep: 1,
  }).chips.find((chip) => chip.id === 'fly');
  assert.equal(flying.label, 'FLYING');
  assert.equal(flying.busy, true);
  assert.equal(flying.active, true);
});

test('a blocked pointer is reported instead of silently doing nothing', () => {
  const blocked = directionsStats({ ...idle, pointerBlocked: true });
  assert.match(blocked.error, /Another map tool is using clicks/);
  assert.equal(blocked.count, 0);
});

test('a step selection can be requested and cleared through params', () => {
  assert.deepEqual(normalizeDirectionsParams({ step: 3 }), { step: 3 });
  assert.deepEqual(normalizeDirectionsParams({ step: 0 }), { step: 0 });
  assert.deepEqual(normalizeDirectionsParams({ step: null }), { step: null });
  assert.deepEqual(normalizeDirectionsParams({ step: -1 }), { step: null });
  assert.deepEqual(normalizeDirectionsParams({ step: 'two' }), { step: null });
});

/**
 * Drive the live layer module with the overlay host stubbed out. No viewer is
 * needed for the arming paths: they are pure state plus the pointer claim.
 */
function ownershipFixture(t) {
  directionsLayer = createApplicationDirectionsLayer();
  directionsLayer._setOverlayHostForTest({
    setEntries() {},
    setVisible() {},
    clearSource() {},
  });
  resetPointerOwnership();
  t.after(() => {
    directionsLayer.setParams({ clear: true });
    directionsLayer._setOverlayHostForTest(null);
    resetPointerOwnership();
  });
}

test('placing an endpoint takes the pointer, and every exit path gives it back', (t) => {
  ownershipFixture(t);

  assert.equal(isPointerFree(), true);
  assert.equal(directionsLayer.setParams({ arm: 'a' }), true);
  assert.equal(
    pointerOwner(),
    DIRECTIONS_POINTER_OWNER,
    'arming claims the pointer',
  );
  assert.equal(
    directionsLayer.getRowControls().chips.find((c) => c.id === 'set-a').active,
    true,
  );

  // Re-arming for the other endpoint keeps the same claim; it never stacks.
  directionsLayer.setParams({ arm: 'b' });
  assert.equal(pointerOwner(), DIRECTIONS_POINTER_OWNER);

  // Cancel (clicking the armed chip again).
  directionsLayer.setParams({ arm: null });
  assert.equal(isPointerFree(), true, 'cancelling releases');
  assert.equal(
    directionsLayer.getRowControls().chips.find((c) => c.id === 'set-b').active,
    false,
  );

  // CLEAR while armed.
  directionsLayer.setParams({ arm: 'a' });
  directionsLayer.setParams({ clear: true });
  assert.equal(isPointerFree(), true, 'CLEAR releases');

  // disable() while armed.
  directionsLayer.setParams({ arm: 'a' });
  directionsLayer.disable(null);
  assert.equal(isPointerFree(), true, 'disabling the layer releases');

  // destroy() while armed, on a layer that was never enabled.
  directionsLayer.setParams({ arm: 'b' });
  assert.equal(pointerOwner(), DIRECTIONS_POINTER_OWNER);
  directionsLayer.destroy({ scene: { primitives: { remove() {} } } });
  assert.equal(isPointerFree(), true, 'destroy releases');
});

test('arming is refused, and said so, while another tool holds the pointer', (t) => {
  ownershipFixture(t);

  const releaseDraw = claimAs('draw');
  assert.equal(
    directionsLayer.setParams({ arm: 'a' }),
    true,
    'the write is accepted',
  );
  assert.equal(
    pointerOwner(),
    'draw',
    "the other tool's claim is never stolen",
  );
  const chips = directionsLayer.getRowControls().chips;
  assert.equal(
    chips.find((chip) => chip.id === 'set-a').active,
    false,
    'nothing is armed',
  );
  assert.match(
    directionsLayer.getStats().error,
    /Another map tool is using clicks/,
    'the row says why the click did nothing',
  );

  // Once the other tool lets go, arming works and the complaint clears.
  assert.equal(releaseDraw(), true);
  directionsLayer.setParams({ arm: 'a' });
  assert.equal(pointerOwner(), DIRECTIONS_POINTER_OWNER);
  assert.equal(directionsLayer.getStats().error, null);
});

test('a release names this layer, so it cannot free a successor tool claim', (t) => {
  ownershipFixture(t);

  directionsLayer.setParams({ arm: 'a' });
  assert.equal(pointerOwner(), DIRECTIONS_POINTER_OWNER);
  // A superseding teardown: the layer is disabled, then another tool claims.
  directionsLayer.disable(null);
  const releaseDraw = claimAs('draw');
  // A late second teardown of ours must not free the draw tool's claim.
  directionsLayer.disable(null);
  directionsLayer.setParams({ clear: true });
  assert.equal(pointerOwner(), 'draw');
  releaseDraw();
});

test('the pointer claim outlives the click that consumed it', async (t) => {
  ownershipFixture(t);
  // Every layer binds its own handler to the same canvas and they all run
  // inside ONE browser event. Releasing the claim the moment the endpoint is
  // placed hands the rest of that same click to every ambient handler
  // registered after this one — which is how placing A on top of a bikeshare
  // station also deselected the station.
  directionsLayer.setParams({ arm: 'a' });
  assert.equal(pointerOwner(), DIRECTIONS_POINTER_OWNER);

  assert.equal(
    directionsLayer.placeEndpoint('a', { lat: 37.7955, lon: -122.3937 }),
    true,
  );
  // Still inside the dispatch: an ambient handler that runs after this one
  // asks the same question the real ones ask, and must be told to stand down.
  assert.equal(
    isPointerFree(),
    false,
    'a later handler in the same click yields',
  );
  assert.equal(pointerOwner(), DIRECTIONS_POINTER_OWNER);
  // A microtask checkpoint runs BETWEEN two DOM listeners, so the release must
  // not be on one.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    isPointerFree(),
    false,
    'a microtask is not the end of the click',
  );

  // The click is over; the pointer goes back.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    isPointerFree(),
    true,
    'the claim is returned once the click ends',
  );

  // A bad placement request changes nothing.
  directionsLayer.setParams({ arm: 'b' });
  assert.equal(directionsLayer.placeEndpoint('c', { lat: 1, lon: 1 }), false);
  assert.equal(
    directionsLayer.placeEndpoint('b', { lat: Number.NaN, lon: 1 }),
    false,
  );
  assert.equal(pointerOwner(), DIRECTIONS_POINTER_OWNER, 'still armed');
});

test('a teardown during the pending release still frees the pointer at once', async (t) => {
  ownershipFixture(t);
  directionsLayer.setParams({ arm: 'a' });
  directionsLayer.placeEndpoint('a', { lat: 37.7955, lon: -122.3937 });
  assert.equal(isPointerFree(), false);
  // Disabling mid-click must not wait for a timer that may never be reached.
  directionsLayer.disable(null);
  assert.equal(isPointerFree(), true);
  // And the pending timer cannot then release someone else's later claim.
  const releaseDraw = claimAs('draw');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(pointerOwner(), 'draw');
  releaseDraw();
});

test('a cold ground cell is re-read for as long as the terrain proxy can take', () => {
  // The proxy behind the shared floor can take tens of seconds on a cold
  // cache. Twelve quick retries covered four seconds of that.
  assert.ok(
    STEP_ANCHOR_DEADLINE_MS >= 60_000,
    `the budget must outlast a slow terrain round trip, is ${STEP_ANCHOR_DEADLINE_MS} ms`,
  );
  assert.equal(stepAnchorDelayMs(0, 0), STEP_ANCHOR_RETRY_MS);
  assert.equal(
    stepAnchorDelayMs(STEP_ANCHOR_FAST_ATTEMPTS - 1, 1000),
    STEP_ANCHOR_RETRY_MS,
  );
  assert.equal(
    stepAnchorDelayMs(STEP_ANCHOR_FAST_ATTEMPTS, 2000),
    STEP_ANCHOR_SLOW_RETRY_MS,
    'the re-reads back off once the quick ones have not settled it',
  );
  // The last wait never overshoots the budget, and past it there is no wait.
  assert.equal(stepAnchorDelayMs(50, STEP_ANCHOR_DEADLINE_MS - 100), 100);
  assert.equal(stepAnchorDelayMs(50, STEP_ANCHOR_DEADLINE_MS), null);
  assert.equal(stepAnchorDelayMs(50, STEP_ANCHOR_DEADLINE_MS + 1), null);
  assert.equal(stepAnchorDelayMs(0, Number.NaN), null);
});

test('a route cut off at the step cap says so instead of ending at a random turn', () => {
  const cut = { ...route, stepsTruncated: true };
  const list = directionsStepList({ route: cut });
  assert.equal(list.items.length, route.steps.length + 1);
  const last = list.items.at(-1);
  assert.match(last.text, /Only the first 3 turns of this route are shown/);
  assert.equal(last.disabled, true, 'the note is not an action');
  assert.equal(last.params, undefined, 'and carries no command');
  assert.match(
    directionsStats({ ...idle, a: A, b: B, status: 'ready', route: cut })
      .coverage,
    /first 3 turns$/,
  );
  // A complete route says nothing extra.
  assert.equal(directionsStepList({ route }).items.length, route.steps.length);
  assert.equal(
    normalizeRoutePayload(
      { ok: true, geometry: route.geometry, steps: route.steps },
      'car',
    ).stepsTruncated,
    false,
  );
  assert.equal(
    normalizeRoutePayload(
      {
        ok: true,
        geometry: route.geometry,
        steps: route.steps,
        stepsTruncated: true,
      },
      'car',
    ).stepsTruncated,
    true,
  );
});

test('re-arming reuses the lease this layer already holds', (t) => {
  ownershipFixture(t);
  // A claim never stacks, not even under the same name — two live instances of
  // one tool are two owners. So arming B after arming A must not ask for a
  // second claim it cannot get.
  assert.equal(directionsLayer.setParams({ arm: 'a' }), true);
  assert.equal(pointerOwner(), DIRECTIONS_POINTER_OWNER);
  assert.equal(directionsLayer.setParams({ arm: 'b' }), true);
  assert.equal(
    pointerOwner(),
    DIRECTIONS_POINTER_OWNER,
    'the layer still holds the pointer after re-arming',
  );
  const chips = directionsLayer.getRowControls().chips;
  assert.equal(chips.find((chip) => chip.id === 'set-b').active, true);
  assert.equal(
    directionsLayer.getStats().error,
    null,
    'and nothing is refused',
  );
});

test('a stale lease cannot free the claim a later arming holds', async (t) => {
  ownershipFixture(t);
  directionsLayer.setParams({ arm: 'a' });
  directionsLayer.placeEndpoint('a', { lat: 37.7955, lon: -122.3937 });
  // The release for that click is pending. Arming again before it fires must
  // keep the pointer, not lose it to the timer a moment later.
  directionsLayer.setParams({ arm: 'b' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    pointerOwner(),
    DIRECTIONS_POINTER_OWNER,
    'the pending release must not disarm the new arming',
  );
});

test('a refused arming names the tool holding the pointer and how to leave it', () => {
  // Owner field test: he pressed SET A while Draw was open, nothing happened,
  // and he concluded Directions was broken. Silence was the bug.
  assert.equal(
    pointerBlockedMessage('draw', 'a'),
    'Draw is active — press Escape twice to leave Draw, then set A',
  );
  assert.equal(
    pointerBlockedMessage('draw', 'b'),
    'Draw is active — press Escape twice to leave Draw, then set B',
  );
  // A tool nobody has written an exit for still gets a usable sentence.
  assert.equal(
    pointerBlockedMessage('measure', 'a'),
    'measure is active — turn measure off, then set A',
  );
  // Nothing to say when nothing is in the way, or when we are the holder.
  assert.equal(pointerBlockedMessage(null, 'a'), null);
  assert.equal(pointerBlockedMessage('', 'a'), null);
  assert.equal(pointerBlockedMessage('   ', 'a'), null);
  assert.equal(pointerBlockedMessage(DIRECTIONS_POINTER_OWNER, 'a'), null);
  // Every exit the table knows names its tool and says how to leave it.
  for (const [id, exit] of Object.entries(POINTER_TOOL_EXITS)) {
    assert.match(
      pointerBlockedMessage(id, 'a'),
      new RegExp(`^${exit.name} is active — `),
    );
    assert.match(pointerBlockedMessage(id, 'a'), /, then set A$/);
  }
});

test('the refusal reaches the app toast, and a successful arming says nothing', (t) => {
  ownershipFixture(t);
  const toasts = [];
  directionsLayer.attachShellServices({
    showToast: (text) => toasts.push(text),
  });
  t.after(() => directionsLayer.attachShellServices(null));

  const releaseDraw = claimAs('draw');
  directionsLayer.setParams({ arm: 'a' });
  assert.deepEqual(toasts, [
    'Draw is active — press Escape twice to leave Draw, then set A',
  ]);
  // The row status the operator can also read is still set.
  assert.match(
    directionsLayer.getStats().error,
    /Another map tool is using clicks/,
  );

  // Once Draw lets go, arming works and says nothing at all.
  releaseDraw();
  directionsLayer.setParams({ arm: 'a' });
  assert.equal(toasts.length, 1, 'a successful arming is silent');
  assert.equal(pointerOwner(), DIRECTIONS_POINTER_OWNER);
});
