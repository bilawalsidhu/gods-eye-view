import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createWorldModelLayer } from './index.js';
import { PROVENANCE_CLOSED } from './selection.js';
import { DEFAULT_DISPLAY_ASSUMPTIONS } from './view.js';

const read = (name) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'),
  );
const fixture = read('experiment-002.projection.json');
const revisions = read('experiment-002.revisions.json');
const status = read('experiment-002.status.json');
const provenance = {
  aircraft: read('experiment-002.provenance.aircraft.json'),
  weather: read('experiment-002.provenance.weather.json'),
};
const DLH = 'world.aircraft/track:opensky:icao24:3c4b33';
const NODE = 'world.weather/air_temperature/850hPa/39.000/237.000';
const TOTAL = fixture.points.length + fixture.field_samples.length;
const HEAD_REV = revisions.revisions[0].id;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Everything the layer touches, faked and recorded. No HTTP anywhere. */
function harness(source, { camera = null, ...options } = {}) {
  const sources = [];
  const overlay = [];
  const owners = new Map();
  const store = new Map();
  let selected = null;
  let handler = null;
  let pickResult;
  let cardHit = null;
  const viewer = {
    dataSources: {
      add(value) {
        sources.push(value);
      },
      remove(value) {
        sources.splice(sources.indexOf(value), 1);
      },
    },
    scene: {
      pick() {
        return pickResult;
      },
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
    },
    ...(camera ? { camera } : {}),
  };
  const services = {
    context: {
      registerEntityContext(entity, metadata) {
        entity.__gevContextId = metadata.id;
        store.set(metadata.id, metadata);
      },
      selectEntityContext(entity) {
        selected = entity.__gevContextId;
      },
      clearSelectedEntityContextForLayer() {
        selected = null;
      },
      removeEntityContextsForLayer(layerId) {
        for (const [key, record] of store)
          if (record.layerId === layerId) store.delete(key);
      },
    },
    picking: {
      registerPickOwner(id, predicate) {
        owners.set(id, predicate);
      },
      unregisterPickOwner(id) {
        owners.delete(id);
      },
      resolvePickId(picked) {
        const id = picked?.id;
        if (id && typeof id === 'object') return String(id.id);
        return id ? String(id) : null;
      },
      isOwnedByOtherLayer: () => false,
    },
  };
  const layer = createWorldModelLayer({
    source,
    services,
    overlayHost: {
      setEntries(...args) {
        overlay.push(['set', ...args]);
      },
      setVisible(...args) {
        overlay.push(['visible', ...args]);
      },
      clearSource(...args) {
        overlay.push(['clear', ...args]);
      },
      hitTest: () => cardHit,
    },
    screenSpaceEventHandlerFactory: () => {
      handler = {
        destroyed: false,
        setInputAction(fn) {
          this.fn = fn;
        },
        destroy() {
          this.destroyed = true;
        },
      };
      return handler;
    },
    debounceMs: 0,
    ...options,
  });
  layer.init(viewer);
  layer.enable(viewer);
  return {
    layer,
    viewer,
    sources,
    overlay,
    owners,
    store,
    handler: () => handler,
    selected: () => selected,
    pick(value) {
      pickResult = value;
    },
    /** The painted card a click lands on next; null for none. */
    hitCard(entryId) {
      cardHit = entryId ? { sourceId: 'world-model', entryId } : null;
    },
    cards: () => overlay.filter(([k]) => k === 'set'),
  };
}

/** A fixture ProjectionSource: the chain, the projection (echoing the demand), optional provenance/status. */
function fixtureSource({
  chain = revisions.revisions,
  fail = null,
  projection = fixture,
  optional = true,
} = {}) {
  const calls = { revisions: 0, projections: [], provenance: [], status: 0 };
  const source = {
    chain: [...chain],
    fail,
    calls,
    projection,
    async getRevisions({ head }) {
      calls.revisions++;
      if (source.fail) throw source.fail;
      return { head, revisions: source.chain };
    },
    async getProjection(request) {
      calls.projections.push(request);
      if (source.projectionFail) throw source.projectionFail;
      return { ...source.projection, revision_id: request.revisionId };
    },
  };
  if (optional) {
    source.getProvenance = async ({ ref }) => {
      calls.provenance.push(ref);
      if (ref.startsWith('aircraft.')) return provenance.aircraft;
      if (ref.startsWith('weather.')) return provenance.weather;
      throw Object.assign(new Error(`no product registered as ${ref}`), {
        code: 'http',
        status: 404,
      });
    };
    source.getStatus = async () => {
      calls.status++;
      return status;
    };
  }
  return source;
}

test('renders one entity per projected item from the injected source, pinned to the chain head', async () => {
  const source = fixtureSource();
  const h = harness(source);
  assert.equal(await h.layer.update(h.viewer), true);
  const stats = h.layer.getStats();
  assert.equal(stats.count, TOTAL);
  assert.equal(stats.revisionId, HEAD_REV);
  assert.equal(stats.headRevisionId, HEAD_REV);
  assert.equal(stats.mode, 'LIVE');
  assert.equal(stats.headAdvanced, false);
  assert.equal(
    stats.source,
    `Dataforge World Model · rev ${HEAD_REV.slice(0, 8)}`,
  );
  assert.equal(stats.error, null);
  assert.equal(stats.stale, false);
  assert.equal(
    stats.spatialScope,
    'all',
    'no camera: no spatial scope is invented',
  );
  assert.match(stats.validAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
  assert.deepEqual(stats.counts, {
    points: 97,
    field_samples: 81,
    annotations: 1,
    assumptions: 6,
    omissions: 1,
  });
  assert.deepEqual(stats.perBinding, [
    { binding: 'world.aircraft', points: 97, samples: 0 },
    { binding: 'world.weather', points: 0, samples: 81 },
  ]);
  const request = source.calls.projections[0];
  assert.equal(request.revisionId, HEAD_REV);
  assert.equal('spatial_scope' in request.query, false);
  // The layer sends its default grants, and they include every grant the
  // retained projection was made under.
  assert.deepEqual(request.projectionSpec.display_assumptions, {
    ...DEFAULT_DISPLAY_ASSUMPTIONS,
  });
  for (const [key, value] of Object.entries(
    fixture.projection_spec.display_assumptions,
  ))
    assert.equal(request.projectionSpec.display_assumptions[key], value, key);
  const entities = h.sources[0].entities.values;
  assert.equal(entities.length, TOTAL);
  const dlh = h.sources[0].entities.getById(DLH);
  const now = Cesium.JulianDate.now();
  const carto = Cesium.Cartographic.fromCartesian(dlh.position.getValue(now));
  assert.ok(Math.abs(Cesium.Math.toDegrees(carto.longitude) + 121.9978) < 1e-9);
  assert.ok(Math.abs(carto.height - 5913.12) < 1e-6);
  const props = dlh.properties.getValue(now);
  assert.equal(
    props.record.semantic_ref.semantic_identity,
    'track:opensky:icao24:3c4b33',
  );
  assert.equal(props.binding, 'world.aircraft');
  const node = h.sources[0].entities.getById(NODE);
  assert.equal(
    node.point.heightReference.getValue(now),
    Cesium.HeightReference.CLAMP_TO_GROUND,
  );
  assert.equal(
    Cesium.Cartographic.fromCartesian(node.position.getValue(now)).height <
      1e-6,
    true,
  );
  assert.equal(h.store.size, TOTAL);
  assert.deepEqual(
    h.store.get(DLH).properties.source_ref,
    fixture.points.find((p) => p.id === DLH).source_ref,
  );
  assert.equal(h.layer.describeSource().transport, 'custom');
  h.layer.destroy(h.viewer);
});

test('live ticks re-project every tick by the newest revision id; a pin freezes and reports headAdvanced', async () => {
  const source = fixtureSource();
  const h = harness(source);
  await h.layer.update(h.viewer);
  await h.layer.update(h.viewer);
  assert.equal(source.calls.revisions, 2);
  assert.equal(
    source.calls.projections.length,
    2,
    'the clock moved, so ages did: live re-projects',
  );
  // pin the revision on screen through the params path (what the chip does)
  const chips = () =>
    Object.fromEntries(h.layer.getRowControls().chips.map((c) => [c.id, c]));
  assert.equal(chips().follow.label, 'LIVE');
  assert.deepEqual(chips().follow.params, {
    follow: 'pinned',
    revisionId: HEAD_REV,
  });
  assert.equal(
    h.layer.setParams(chips().follow.params, { origin: 'user' }),
    true,
  );
  await flush();
  assert.equal(h.layer.getParams().follow, 'pinned');
  assert.equal(h.layer.getParams().revisionId, HEAD_REV);
  assert.match(
    h.layer.getParams().validAt,
    /Z$/,
    'the pinned query time is the one the view was issued with',
  );
  assert.equal(chips().follow.label, `PINNED ${HEAD_REV.slice(0, 8)}`);
  assert.equal(chips()['go-live'], undefined);
  // the world advances; a pinned tick reads the chain but never re-projects
  source.chain = [
    {
      id: 'rev-new',
      parent_id: HEAD_REV,
      created_at: '2026-09-14T00:00:00+00:00',
      bindings: [],
    },
    ...source.chain,
  ];
  const before = source.calls.projections.length;
  await h.layer.update(h.viewer);
  assert.equal(source.calls.projections.length, before);
  const stats = h.layer.getStats();
  assert.equal(stats.mode, 'PINNED');
  assert.equal(stats.headAdvanced, true);
  assert.equal(stats.revisionId, HEAD_REV);
  assert.equal(stats.headRevisionId, 'rev-new');
  assert.equal(chips()['go-live'].label, 'HEAD MOVED');
  assert.deepEqual(chips()['go-live'].params, { follow: 'live' });
  assert.equal(h.layer.setParams({ follow: 'live' }), true);
  await flush();
  await h.layer.update(h.viewer);
  assert.equal(h.layer.getStats().revisionId, 'rev-new');
  assert.equal(h.layer.getStats().headAdvanced, false);
  assert.equal(h.layer.getParams().validAt, null);
  // params are validated as plain data
  assert.equal(h.layer.setParams({ follow: 'sideways' }), false);
  assert.equal(h.layer.setParams({ policy: 'hide' }), false);
  assert.equal(h.layer.setParams({ layers: 'world.weather' }), false);
  h.layer.destroy(h.viewer);
});

test('the policy chip cycles off -> mark -> withhold and the demand travels with the request', async () => {
  const source = fixtureSource();
  const h = harness(source);
  await h.layer.update(h.viewer);
  const chip = () =>
    h.layer.getRowControls().chips.find((c) => c.id === 'policy');
  assert.equal(chip().label, 'AGE OFF');
  assert.equal(chip().active, false);
  assert.equal(h.layer.setParams(chip().params), true);
  assert.equal(h.layer.getParams().policy, 'mark');
  assert.equal(chip().label, 'AGE MARK');
  await h.layer.update(h.viewer);
  assert.deepEqual(
    source.calls.projections.at(-1).projectionSpec.projection_policy,
    {
      temporal_age: { mode: 'mark', threshold_seconds: 30 },
    },
  );
  assert.equal(
    h.layer.setParams({ policy: 'withhold', policyThresholdSeconds: 45 }),
    true,
  );
  assert.equal(chip().label, 'AGE HIDE');
  await h.layer.update(h.viewer);
  assert.deepEqual(
    source.calls.projections.at(-1).projectionSpec.projection_policy,
    {
      temporal_age: { mode: 'withhold', threshold_seconds: 45 },
    },
  );
  assert.equal(h.layer.setParams(chip().params), true);
  assert.equal(h.layer.getParams().policy, 'off');
  // a marked projection dims the stale points and counts them; a withheld omission is counted, never inferred
  source.projection = {
    ...fixture,
    points: fixture.points.map((p, i) => ({
      ...p,
      time: { ...p.time, age_at_query_seconds: 61, stale: i < 10 },
    })),
    assumptions: [
      ...fixture.assumptions,
      {
        kind: 'projection-policy',
        policy: 'temporal_age',
        binding: 'world.aircraft',
        mode: 'mark',
        marked: 10,
        withheld: 0,
      },
    ],
    omissions: [
      ...fixture.omissions,
      { reason: 'temporal-age-withheld', binding: 'world.vessels', count: 4 },
    ],
  };
  await h.layer.update(h.viewer);
  const stats = h.layer.getStats();
  assert.equal(stats.marked, 10);
  assert.equal(stats.withheld, 4);
  assert.equal(stats.policies.length, 1);
  const dim = h.sources[0].entities.getById(DLH);
  assert.equal(dim.point.pixelSize.getValue(Cesium.JulianDate.now()), 5);
  assert.equal(h.layer.getAnalystRecords(1)[0].stale, true);
  h.layer.destroy(h.viewer);
});

test('a failed refresh keeps the geometry, reports stale, and does not reject the lifecycle', async () => {
  const source = fixtureSource();
  const h = harness(source);
  await h.layer.update(h.viewer);
  source.fail = Object.assign(new Error('World model unreachable at /x'), {
    code: 'unreachable',
  });
  assert.equal(await h.layer.update(h.viewer), true);
  let stats = h.layer.getStats();
  assert.equal(stats.count, TOTAL);
  assert.equal(stats.stale, true);
  assert.equal(stats.error, 'World model unreachable at /x');
  assert.equal(stats.errorCode, 'unreachable');
  assert.equal(h.sources[0].entities.values.length, TOTAL);
  source.fail = null;
  source.projectionFail = Object.assign(new Error('boom'), { code: 'http' });
  assert.equal(await h.layer.update(h.viewer), true);
  stats = h.layer.getStats();
  assert.equal(stats.error, 'boom');
  assert.equal(stats.stale, true);
  assert.equal(stats.count, TOTAL);
  h.layer.destroy(h.viewer);

  const empty = harness(
    fixtureSource({
      fail: Object.assign(new Error('head world/main is not set'), {
        code: 'head-missing',
      }),
    }),
  );
  assert.equal(await empty.layer.update(empty.viewer), true);
  assert.equal(empty.layer.getStats().count, 0);
  assert.equal(empty.layer.getStats().stale, false);
  assert.match(empty.layer.getStats().error, /not set/);
  empty.layer.destroy(empty.viewer);
});

test('late responses cannot publish after disable or destroy', async () => {
  for (const action of ['disable', 'destroy']) {
    let resolve;
    let signal;
    const h = harness({
      async getRevisions({ head }) {
        return { head, revisions: revisions.revisions };
      },
      getProjection(request) {
        signal = request.signal;
        return new Promise((done) => {
          resolve = done;
        });
      },
    });
    const pending = h.layer.update(h.viewer);
    await flush();
    h.layer[action](h.viewer);
    assert.equal(signal.aborted, true);
    if (action === 'disable') h.layer.enable(h.viewer);
    resolve({ ...fixture, revision_id: HEAD_REV });
    assert.equal(await pending, false);
    assert.equal(h.layer.getStats().count, 0);
    assert.equal(h.cards().length, 0);
    h.layer.destroy(h.viewer);
  }
});

test('camera changes become debounced demand; disable restores the camera and releases everything', async () => {
  const listeners = { changed: new Set(), moveEnd: new Set() };
  let rect = Cesium.Rectangle.fromDegrees(-122.4194, 37.7749, -121.0001, 38);
  const camera = {
    percentageChanged: 0.5,
    computeViewRectangle: () => rect,
    changed: {
      addEventListener: (fn) => listeners.changed.add(fn),
      removeEventListener: (fn) => listeners.changed.delete(fn),
    },
    moveEnd: {
      addEventListener: (fn) => {
        listeners.moveEnd.add(fn);
        return () => listeners.moveEnd.delete(fn);
      },
    },
  };
  const source = fixtureSource();
  const h = harness(source, { camera });
  assert.equal(camera.percentageChanged, 0.05);
  await h.layer.update(h.viewer);
  assert.deepEqual(
    source.calls.projections[0].query.spatial_scope.bbox,
    [-122.42, 37.77, -121, 38],
  );
  assert.equal(h.layer.getStats().spatialScope, 'viewport');
  rect = Cesium.Rectangle.fromDegrees(-123, 37, -121, 39);
  for (const fn of listeners.changed) fn();
  await flush();
  await flush();
  assert.deepEqual(
    source.calls.projections.at(-1).query.spatial_scope.bbox,
    [-123, 37, -121, 39],
  );
  rect = undefined; // the horizon is in view
  for (const fn of listeners.moveEnd) fn();
  await flush();
  await flush();
  assert.equal('spatial_scope' in source.calls.projections.at(-1).query, false);
  assert.equal(h.layer.getStats().spatialScope, 'all');
  assert.equal(typeof h.owners.get('world-model'), 'function');
  assert.equal(h.owners.get('world-model')(DLH), true);
  assert.equal(h.handler().destroyed, false);
  h.layer.disable(h.viewer);
  assert.equal(camera.percentageChanged, 0.5);
  assert.equal(listeners.changed.size, 0);
  assert.equal(listeners.moveEnd.size, 0);
  assert.equal(h.handler().destroyed, true);
  assert.equal(h.owners.has('world-model'), false);
  assert.equal(h.sources[0].show, false);
  assert.deepEqual(h.overlay.at(-2), ['clear', 'world-model']);
  assert.deepEqual(h.overlay.at(-1), ['visible', 'world-model', false]);
  assert.equal(h.store.size, TOTAL, 'records survive a disable for re-enable');
  h.layer.destroy(h.viewer);
  assert.equal(h.sources.length, 0);
  assert.equal(h.store.size, 0);
  assert.equal(h.layer.getStats().count, 0);
});

test('selection publishes one protected card, then the admitted descriptor and lineage from provenance', async () => {
  const source = fixtureSource();
  const h = harness(source);
  await h.layer.update(h.viewer);
  assert.equal(h.layer.selectById(DLH), true);
  const [kind, sourceId, entries, options] = h.cards().at(-1);
  assert.equal(kind, 'set');
  assert.equal(sourceId, 'world-model');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, DLH);
  assert.equal(entries[0].protected, true);
  assert.equal(entries[0].paintLane, 'selected');
  assert.match(entries[0].title, /DLH455/);
  assert.match(
    entries[0].details.join('\n'),
    /adsb-geometric-as-wgs84-ellipsoid/,
  );
  assert.ok(Number.isFinite(entries[0].position.x));
  assert.equal(options.cohortLimit, 1);
  assert.equal(h.selected(), DLH);
  await flush();
  await flush();
  assert.deepEqual(source.calls.provenance, [
    `aircraft.track_state_set.v1@${fixture.points[0].semantic_ref.product_ref.content_id}`,
  ]);
  // Fetched at once, folded until the card itself is clicked (DWM-209).
  const folded = h.cards().at(-1)[2][0];
  assert.equal(folded.details.at(-1), PROVENANCE_CLOSED);
  assert.equal(folded.interactive, true);
  assert.equal(folded.details.join('\n').includes('descriptor'), false);
  h.hitCard(DLH);
  h.handler().fn({ position: { x: 5, y: 5 } });
  assert.equal(h.layer.getSelectedId(), DLH, 'a click on the card keeps it');
  const inspected = h.cards().at(-1)[2][0].details.join('\n');
  assert.match(inspected, /▾ provenance · click the card to close\nknown /);
  assert.match(
    inspected,
    /descriptor [0-9a-f]{8} · admitted · aircraft\.track_state_set\.v1/,
  );
  assert.match(
    inspected,
    /representation positioned_entities\/v1\n {2}capabilities point,height,temporal_age/,
  );
  assert.match(inspected, /produced by aircraft\.materialize-track-state@1/);
  assert.match(inspected, /connector opensky-replay/);
  // the context store gets only the selection record, never the report
  assert.equal('descriptors' in h.store.get(DLH).properties, false);
  // a refresh of the same selection stays open; the next click folds it
  await h.layer.update(h.viewer);
  assert.match(h.cards().at(-1)[2][0].details.join('\n'), /produced by/);
  h.handler().fn({ position: { x: 5, y: 5 } });
  assert.equal(h.cards().at(-1)[2][0].details.at(-1), PROVENANCE_CLOSED);
  h.hitCard(null);

  // empty-space click clears
  h.pick(undefined);
  h.handler().fn({ position: { x: 1, y: 1 } });
  assert.equal(h.layer.getSelectedId(), null);
  assert.equal(h.selected(), null);
  assert.deepEqual(h.overlay.at(-1), ['clear', 'world-model']);

  // clicking one of our entities selects it; the report for a ref is fetched once
  h.pick({ id: h.sources[0].entities.getById(NODE) });
  h.handler().fn({ position: { x: 2, y: 2 } });
  assert.equal(h.layer.getSelectedId(), NODE);
  assert.equal(
    h.overlay.at(-1)[2][0].title,
    '297.25 K air_temperature @ 850 hPa',
  );
  await flush();
  await flush();
  h.hitCard(NODE);
  h.handler().fn({ position: { x: 3, y: 3 } });
  h.hitCard(null);
  assert.match(
    h.cards().at(-1)[2][0].details.join('\n'),
    /via weather\.field_block\.v1@/,
  );
  h.layer.selectById(DLH);
  assert.equal(
    h.cards().at(-1)[2][0].details.at(-1),
    PROVENANCE_CLOSED,
    'a new selection starts folded',
  );
  await flush();
  assert.equal(
    source.calls.provenance.length,
    2,
    'cached per content-addressed ref',
  );

  // a refresh keeps the selection while the item survives, drops it otherwise
  await h.layer.update(h.viewer);
  assert.equal(h.layer.getSelectedId(), DLH);
  source.projection = { ...fixture, points: [] };
  await h.layer.update(h.viewer);
  assert.equal(h.layer.getSelectedId(), null);
  h.layer.destroy(h.viewer);

  // a source without getProvenance: the card stays as served, no inspection block
  const plain = harness(fixtureSource({ optional: false }));
  await plain.layer.update(plain.viewer);
  plain.layer.selectById(DLH);
  await flush();
  await flush();
  assert.equal(plain.cards().length, 1);
  assert.equal(plain.layer.getStats().facts, null);
  assert.deepEqual(plain.layer.getStats().features, {
    heads: false,
    provenance: false,
    revision: false,
    select: false,
    status: false,
  });
  plain.layer.destroy(plain.viewer);
});

test('status facts are shown as three separate lines per binding, never a verdict', async () => {
  const h = harness(fixtureSource());
  await h.layer.update(h.viewer);
  // Reported as the panel's generic fact groups: one per binding, three lines.
  const { facts, factsError } = h.layer.getStats();
  assert.equal(factsError, null);
  assert.equal(facts.length, 2);
  const aircraft = facts.find((group) => group.label === 'world.aircraft');
  assert.equal(aircraft.lines.length, 3);
  const [source, processing, productTime] = aircraft.lines;
  assert.match(
    source,
    /^source: opensky-replay idle · checkpoint .* · 1 receipts$/,
  );
  assert.match(
    processing,
    /^processing: opensky\.aircraft@1 (succeeded|unchanged)$/,
  );
  assert.match(
    productTime,
    /^product time: valid instant to 2026-09-10T22:57:25\+00:00 \(\d+[smhd] before now\) · known \d+[smhd] ago · admitted$/,
  );
  for (const group of facts) {
    for (const text of group.lines) {
      assert.doesNotMatch(text, /fresh|healthy|verdict|ok\b/i);
    }
  }
  h.layer.destroy(h.viewer);
});

test('a binding withheld for a grant says so on the card, one line per grant (DWM-208)', async () => {
  const withheld = {
    binding: 'world.aircraft',
    reason: 'height-interpretation-unresolved',
    assumption_required: 'aircraft_height:adsb-geometric-as-wgs84-ellipsoid',
    count: 97,
  };
  const h = harness(
    fixtureSource({
      projection: { ...fixture, omissions: [...fixture.omissions, withheld] },
    }),
  );
  await h.layer.update(h.viewer);
  const aircraft = h.layer
    .getStats()
    .facts.find((group) => group.label === 'world.aircraft');
  assert.equal(aircraft.lines.length, 4, 'after the three status lines');
  assert.equal(
    aircraft.lines[3],
    'withheld 97: needs aircraft_height:adsb-geometric-as-wgs84-ellipsoid',
  );
  assert.ok(
    aircraft.lines[3].length <= 72,
    'a card line the host need not clamp',
  );
  h.layer.destroy(h.viewer);

  // Without status, the withheld binding is still its own fact group.
  const plain = harness(
    fixtureSource({
      optional: false,
      projection: { ...fixture, omissions: [withheld] },
    }),
  );
  await plain.layer.update(plain.viewer);
  assert.deepEqual(plain.layer.getStats().facts, [
    {
      label: 'world.aircraft',
      lines: [
        'withheld 97: needs aircraft_height:adsb-geometric-as-wgs84-ellipsoid',
      ],
    },
  ]);
  plain.layer.destroy(plain.viewer);
});

test('product rows moved to another run keep their own binding, so no item is in two rows (DWM-210)', async () => {
  /** A source that serves only the requested bindings, as the backplane does. */
  function filtering() {
    const source = fixtureSource();
    const all = source.getProjection;
    source.getProjection = async (request) => {
      const wanted = request.query?.requested_layers;
      const projection = await all(request);
      if (!wanted) return projection;
      return {
        ...projection,
        points: projection.points.filter((p) => wanted.includes(p.binding)),
        field_samples: projection.field_samples.filter((s) =>
          wanted.includes(s.binding),
        ),
      };
    };
    return source;
  }
  const rows = ['world.aircraft', 'world.weather'].map((binding) => {
    const source = filtering();
    return {
      binding,
      source,
      h: harness(source, { id: `world-product:${binding}`, layers: [binding] }),
    };
  });
  for (const { h } of rows) {
    // What openRun and a row's run chips send: a head, no layers.
    assert.equal(h.layer.setParams({ head: 'sim/sha256:other' }), true);
    await h.layer.update(h.viewer);
  }
  const held = rows.map(({ binding, source, h }) => {
    assert.deepEqual(h.layer.getParams().layers, [binding]);
    assert.deepEqual(source.calls.projections.at(-1).query.requested_layers, [
      binding,
    ]);
    return new Set(h.sources[0].entities.values.map((e) => e.id));
  });
  assert.ok(held[0].size > 0 && held[1].size > 0, 'both rows draw');
  assert.equal(
    [...held[0]].some((itemId) => held[1].has(itemId)),
    false,
    'no item is held by two rows',
  );

  // The generic layer still opens a whole world: no filter of its own.
  const generic = harness(fixtureSource());
  generic.layer.setParams({ layers: ['world.aircraft'] });
  generic.layer.setParams({ head: 'world/other' });
  assert.equal(generic.layer.getParams().layers, null);
  for (const { h } of rows) h.layer.destroy(h.viewer);
  generic.layer.destroy(generic.viewer);
});

test('a synthetic third binding conforming to the same contracts renders as points with no layer change', async () => {
  const vessels = Array.from({ length: 3 }, (_, i) => ({
    id: `world.vessels/track:ais:mmsi:${i}`,
    binding: 'world.vessels',
    position: { lon: -122 + i * 0.01, lat: 37.5, height_m: 12 + i },
    frame: 'WGS84',
    height: {
      value_m: 12 + i,
      source_field: 'antenna_height_m',
      assumption: 'vessel_height:antenna-above-msl-as-ellipsoid',
      interpretation: 'explicit-grant',
    },
    time: {
      valid_at: '2026-09-10T22:57:25+00:00',
      sampled_at: '2026-09-10T22:57:25+00:00',
      age_at_query_seconds: 2,
      stale: false,
    },
    semantic_ref: {
      product_ref: {
        type_id: 'test.vessels.v1',
        content_id: 'sha256:' + 'a'.repeat(64),
      },
      descriptor_id: 'd-m',
      type_id: 'test.vessels.v1',
      semantic_identity: `track:ais:mmsi:${i}`,
    },
    source_ref: {
      source: { type_id: 'source.ais.nmea.v1', content_id: 'sha256:a' },
      row_index: i,
    },
    properties: { mmsi: String(i), fix_quality: 'gnss', speed_kn: 9.5 },
  }));
  const source = fixtureSource({
    projection: {
      ...fixture,
      points: [...fixture.points, ...vessels],
      counts: { ...fixture.counts, points: 100 },
    },
  });
  const h = harness(source);
  await h.layer.update(h.viewer);
  const stats = h.layer.getStats();
  assert.equal(stats.count, TOTAL + 3);
  assert.deepEqual(stats.perBinding, [
    { binding: 'world.aircraft', points: 97, samples: 0 },
    { binding: 'world.vessels', points: 3, samples: 0 },
    { binding: 'world.weather', points: 0, samples: 81 },
  ]);
  const entity = h.sources[0].entities.getById(
    'world.vessels/track:ais:mmsi:1',
  );
  const now = Cesium.JulianDate.now();
  assert.equal(entity.properties.getValue(now).binding, 'world.vessels');
  assert.ok(
    Math.abs(
      Cesium.Cartographic.fromCartesian(entity.position.getValue(now)).height -
        13,
    ) < 1e-6,
  );
  const aircraftColor = h.sources[0].entities
    .getById(DLH)
    .point.color.getValue(now);
  assert.notDeepEqual(
    entity.point.color.getValue(now),
    aircraftColor,
    'colour is keyed by binding',
  );
  h.layer.selectById('world.vessels/track:ais:mmsi:1');
  const card = h.cards().at(-1)[2][0];
  assert.equal(card.title, 'track:ais:mmsi:1');
  assert.match(
    card.details.join('\n'),
    /world\.vessels · height 13 m from antenna_height_m\ngrant vessel_height:antenna-above-msl-as-ellipsoid/,
  );
  assert.match(card.details.join('\n'), /age at query 2 s · within policy/);
  assert.match(card.details.join('\n'), /mmsi 1 · fix_quality gnss/);
  await flush();
  await flush();
  assert.equal(h.cards().at(-1)[2][0].activate(), true, 'keyboard opens it');
  assert.match(
    h.cards().at(-1)[2][0].details.join('\n'),
    /provenance unavailable: no product registered/,
  );
  h.layer.destroy(h.viewer);
});

test('analyst records are JSON-safe and only exist while shown', async () => {
  const h = harness(fixtureSource());
  await h.layer.update(h.viewer);
  const records = h.layer.getAnalystRecords(2);
  assert.equal(records.length, 2);
  assert.equal(records[0].semantic_identity, 'track:opensky:icao24:3c4b33');
  assert.equal(records[0].binding, 'world.aircraft');
  assert.equal(typeof JSON.stringify(records), 'string');
  h.layer.disable(h.viewer);
  assert.deepEqual(h.layer.getAnalystRecords(), []);
  h.layer.destroy(h.viewer);
});

test('a simulated run is a chip: entering it asks for its head, modality and first epoch; its chip leaves it', async () => {
  const simHeads = JSON.parse(
    readFileSync(
      new URL('./fixtures/simulated-run.heads.json', import.meta.url),
    ),
  );
  const simStatus = JSON.parse(
    readFileSync(
      new URL('./fixtures/simulated-run.status.json', import.meta.url),
    ),
  );
  const [runHead] = Object.keys(simHeads).filter((head) =>
    head.startsWith('sim/'),
  );
  const source = fixtureSource();
  source.getHeads = async () => simHeads;
  source.getStatus = async ({ head } = {}) =>
    head === runHead ? simStatus : status;
  const h = harness(source);
  const chips = () =>
    Object.fromEntries(h.layer.getRowControls().chips.map((c) => [c.id, c]));
  await h.layer.update(h.viewer);
  assert.equal(chips()['sim-view'].label, 'SIM RUNS 1');
  assert.equal(h.layer.setParams(chips()['sim-view'].params), true);
  await flush();
  const run = simStatus.bindings.find((b) => b.modality === 'simulated');
  assert.equal(h.layer.getParams().head, runHead);
  assert.deepEqual(h.layer.getParams().modalities, ['simulated']);
  assert.equal(
    Date.parse(h.layer.getParams().validAt),
    Date.parse(run.valid.earliest),
  );
  assert.ok(
    chips()['sim-leave'] && chips()['sim-forward'] && chips()['sim-back'],
  );
  assert.equal(h.layer.setParams(chips()['sim-forward'].params), true);
  await flush();
  assert.equal(
    Date.parse(h.layer.getParams().validAt) - Date.parse(run.valid.earliest),
    60_000,
  );
  assert.equal(h.layer.setParams(chips()['sim-leave'].params), true);
  await flush();
  assert.equal(h.layer.getParams().head, 'world/main');
  assert.equal(h.layer.getParams().modalities, null);
  assert.equal(h.layer.getParams().validAt, null);
});

test('a product layer is one binding: it asks only for it, reports only it, has no chips, and owns its own cards', async () => {
  const source = fixtureSource();
  const h = harness(source, {
    id: 'world-product:world.weather',
    layers: ['world.weather'],
  });
  await h.layer.update(h.viewer);
  await flush();
  const asked = source.calls.projections.at(-1);
  assert.deepEqual(asked.query.requested_layers, ['world.weather']);
  const { facts } = h.layer.getStats();
  assert.deepEqual(
    facts.map((group) => group.label),
    ['world.weather'],
    'the other binding in the status is not this row',
  );
  assert.deepEqual(h.layer.getRowControls().chips, []);
  const overlaySources = new Set(h.overlay.map(([, sourceId]) => sourceId));
  assert.deepEqual([...overlaySources], ['world-product:world.weather']);
});

test('a simulated product layer opens on its run: one chip per run holding it, two steps, nothing to leave to', async () => {
  const simHeads = JSON.parse(
    readFileSync(
      new URL('./fixtures/simulated-run.heads.json', import.meta.url),
    ),
  );
  const simStatus = JSON.parse(
    readFileSync(
      new URL('./fixtures/simulated-run.status.json', import.meta.url),
    ),
  );
  const [runHead] = Object.keys(simHeads).filter((head) =>
    head.startsWith('sim/'),
  );
  const run = simStatus.bindings.find((b) => b.modality === 'simulated');
  const source = fixtureSource();
  source.getHeads = async () => simHeads;
  source.getStatus = async ({ head } = {}) =>
    head === runHead ? simStatus : status;
  const h = harness(source, {
    id: `world-product:${run.binding}`,
    layers: [run.binding],
    modalities: ['simulated'],
    head: runHead,
    validAt: run.valid.earliest,
    simulatedBinding: run.binding,
  });
  await h.layer.update(h.viewer);
  const params = h.layer.getParams();
  assert.equal(params.head, runHead);
  assert.deepEqual(params.modalities, ['simulated']);
  const ids = h.layer.getRowControls().chips.map((chip) => chip.id);
  assert.deepEqual(ids, [`run-${runHead}`, 'sim-back', 'sim-forward']);
  assert.ok(!ids.includes('sim-leave') && !ids.includes('sim-view'));
  const forward = h.layer
    .getRowControls()
    .chips.find((chip) => chip.id === 'sim-forward');
  assert.equal(h.layer.setParams(forward.params), true);
  assert.equal(
    Date.parse(h.layer.getParams().validAt) - Date.parse(run.valid.earliest),
    60_000,
  );
});
