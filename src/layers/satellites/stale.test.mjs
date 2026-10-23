import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createSatelliteSource } from './source.js';
import { createState } from './state.js';
import { createControls } from './controls.js';
import { createOrbits } from './orbits.js';
import { createLabels } from './labels.js';
import { createTracking } from './tracking.js';
import { createRendering } from './rendering.js';
import { createCatalog } from './catalog.js';
import { createLifecycle } from './lifecycle.js';
import { createInteraction } from './interaction.js';
import { createIngestion } from './ingestion.js';
import { layerFeedState } from '../../data/feedState.js';

const GROUPS = [
  'stations',
  'visual',
  'gps-ops',
  'glo-ops',
  'galileo',
  'geo',
  'starlink',
];

function tle(id, invalid = false) {
  // Owned synthetic catalog IDs over one valid element set; never live requests.
  const motion = invalid ? ' 0.00000000' : '15.48899044';
  return `OWNED ORBIT FIXTURE ${id}\n1 ${id}U 98067A   26289.78971908  .00007803  00000+0  15012-3 0  9995\n2 ${id}  51.6326  58.3278 0006748 271.9059  88.1156 ${motion}590607`;
}

async function fixture(t) {
  const policy = {
    stale: new Set(),
    invalid: new Set(),
    ids: {},
    status: 200,
    hold: false,
  };
  const held = new EventEmitter();
  let heldCount = 0;
  const server = http.createServer((req, res) => {
    const group = req.url.split('/').at(-1);
    if (policy.hold) {
      held.emit('request', ++heldCount);
      return;
    }
    res.writeHead(policy.status, {
      'Content-Type': 'text/plain',
      'X-TLE-Cache': policy.stale.has(group) ? 'STALE-ERROR' : 'MISS',
    });
    res.end(
      tle(
        policy.ids[group] ?? 25545 + GROUPS.indexOf(group),
        policy.invalid.has(group),
      ),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const source = createSatelliteSource({
    fetchImpl: (path, options) =>
      fetch(`http://127.0.0.1:${server.address().port}${path}`, options),
  });
  // Application host services and native EventTargets; actual Cesium collections,
  // input handler, events, SGP4, ingestion and lifecycle run without a WebGL scene.
  const noop = () => {};
  const services = {
    overlays: {
      setOverlayEntries: noop,
      setOverlaySourceVisible: noop,
      clearOverlaySource: noop,
    },
    layerState: { isExplicitLayerStateOrigin: () => false },
    focus: {
      clearFocusTarget: noop,
      publishFocusTargetFromCachedPosition: noop,
      getFocusTarget: () => null,
    },
    context: {
      clearTrackedSubjectContext: noop,
      getContextStore: () => ({ entities: new Map() }),
      refreshTrackedSubjectContext: noop,
      selectTrackedSubjectContext: noop,
    },
    readout: { refreshTrackedReadout: noop },
    render: { holdContinuousRender: noop, releaseContinuousRender: noop },
    picking: { registerPickOwner: noop, unregisterPickOwner: noop },
  };
  const previousDocument = globalThis.document;
  globalThis.document = new EventTarget();
  const state = createState({ services });
  const parts = {};
  const context = { state, services, parts, source };
  for (const [name, factory] of Object.entries({
    controls: createControls,
    orbits: createOrbits,
    labels: createLabels,
    tracking: createTracking,
    rendering: createRendering,
    catalog: createCatalog,
    interaction: createInteraction,
    lifecycle: createLifecycle,
    ingestion: createIngestion,
  })) {
    parts[name] = factory(context);
  }
  const viewer = {
    scene: {
      canvas: new EventTarget(),
      primitives: new Cesium.PrimitiveCollection(),
      preRender: new Cesium.Event(),
    },
    trackedEntityChanged: new Cesium.Event(),
  };
  await parts.lifecycle.methods.init(viewer);
  t.after(async () => {
    if (state._pointCollection) parts.lifecycle.methods.destroy(viewer);
    viewer.scene.primitives.destroy();
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    state,
    parts,
    viewer,
    policy,
    update: (options) => parts.ingestion.methods.update(viewer, options),
    stats: () => parts.controls.methods.getStats(),
    feed: () => layerFeedState(parts.controls.methods.getStats()),
    async waitHeld(count) {
      while (heldCount < count)
        await once(held, 'request', { signal: AbortSignal.timeout(3000) });
    },
  };
}

test('stale core records surface through actual HTTP, ingestion and feed state, then recover', async (t) => {
  const f = await fixture(t);
  await f.update();
  assert.equal(f.feed(), 'nominal');
  assert.equal(f.stats().count, 6);
  f.policy.stale = new Set(GROUPS.slice(0, 6));
  await f.update();
  assert.equal(f.stats().count, 6);
  assert.equal(f.stats().stale, true);
  assert.equal(f.feed(), 'stale');
  f.policy.stale = new Set(['visual']);
  await f.update();
  assert.equal(f.feed(), 'stale');
  f.policy.stale.clear();
  await f.update();
  assert.equal(f.stats().stale, false);
  assert.equal(f.feed(), 'nominal');
});

test('a stale duplicate cannot taint its earlier fresh winning record', async (t) => {
  const f = await fixture(t);
  f.policy.stale.add('visual');
  f.policy.ids.visual = 25545;
  await f.update();
  assert.equal(f.stats().count, 5);
  assert.equal(f.state._catalog.get(25545).group, 'stations');
  assert.equal(f.stats().stale, false);
  assert.equal(f.feed(), 'nominal');
  f.policy.stale = new Set(['stations']);
  await f.update();
  assert.equal(f.stats().count, 5);
  assert.equal(
    f.stats().stale,
    true,
    'a later fresh duplicate does not replace the stale winner',
  );
});

test('invalid stale orbital elements are not admitted as provenance', async (t) => {
  const f = await fixture(t);
  f.policy.stale.add('visual');
  f.policy.invalid.add('visual');
  await f.update();
  assert.equal(f.stats().count, 5);
  assert.equal(f.state._catalog.has(25546), false);
  assert.equal(f.stats().stale, false);
});

test('failed and aborted core refreshes keep provenance of retained records', async (t) => {
  const f = await fixture(t);
  f.policy.stale.add('stations');
  await f.update();
  const priorTime = f.stats().lastUpdate;
  f.policy.status = 503;
  await f.update();
  assert.equal(f.stats().count, 6);
  assert.equal(f.stats().stale, true);
  assert.equal(f.stats().status, 'unavailable');
  assert.equal(f.stats().lastUpdate, priorTime);
  f.policy.hold = true;
  const controller = new AbortController();
  const work = f.update({ signal: controller.signal });
  await f.waitHeld(6);
  controller.abort();
  await assert.rejects(work, { name: 'AbortError' });
  assert.equal(f.stats().count, 6);
  assert.equal(f.stats().stale, true);
  assert.equal(f.stats().lastUpdate, priorTime);
  assert.equal(f.state._activeUpdateControllers.size, 0);
});

test('dense provenance belongs to its admitted records and clears on removal', async (t) => {
  const f = await fixture(t);
  await f.update();
  f.policy.stale.add('starlink');
  f.state._params.catalog = 'dense';
  assert.equal((await f.parts.catalog._loadDenseCatalog()).status, 'ready');
  assert.equal(f.stats().count, 7);
  assert.equal(f.feed(), 'stale');
  f.state._params.catalog = 'core';
  f.parts.catalog._removeDenseCatalog();
  assert.equal(f.stats().count, 6);
  assert.equal(f.feed(), 'nominal');
  f.policy.stale = new Set(['stations']);
  await f.update();
  f.state._params.catalog = 'dense';
  await f.parts.catalog._loadDenseCatalog();
  f.state._params.catalog = 'core';
  f.parts.catalog._removeDenseCatalog();
  assert.equal(
    f.feed(),
    'stale',
    'removing dense data must not clear core provenance',
  );
});

test('cancelling dense replacement preserves admitted stale extras until rebuild', async (t) => {
  const f = await fixture(t);
  await f.update();
  f.policy.stale.add('starlink');
  f.state._params.catalog = 'dense';
  await f.parts.catalog._loadDenseCatalog();
  f.policy.hold = true;
  const controller = new AbortController();
  const work = f.parts.catalog._loadDenseCatalog({ signal: controller.signal });
  await f.waitHeld(1);
  controller.abort();
  assert.equal((await work).status, 'cancelled');
  assert.equal(f.stats().count, 7);
  assert.equal(f.feed(), 'stale');
  f.policy.hold = false;
  f.policy.stale.clear();
  f.state._params.catalog = 'core';
  await f.update();
  assert.equal(f.stats().count, 6);
  assert.equal(f.feed(), 'nominal');
});

test('destroy aborts an in-flight response and initialization starts with new ownership', async (t) => {
  const f = await fixture(t);
  f.policy.stale.add('stations');
  await f.update();
  f.policy.hold = true;
  const work = f.update();
  await f.waitHeld(6);
  const rejected = assert.rejects(work, { name: 'AbortError' });
  f.parts.lifecycle.methods.destroy(f.viewer);
  assert.equal(f.stats().count, 0);
  assert.equal(f.stats().stale, false);
  await f.parts.lifecycle.methods.init(f.viewer);
  await rejected;
  assert.equal(f.stats().stale, false);
  f.policy.hold = false;
  f.policy.stale.clear();
  await f.update();
  assert.equal(f.stats().count, 6);
  assert.equal(f.feed(), 'nominal');
});
