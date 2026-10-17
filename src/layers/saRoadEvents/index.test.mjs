import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import {
  SA_ROAD_EVENTS_OVERLAY_SOURCE_ID,
  SA_ROAD_EVENT_DEFAULT_VISIBLE_KINDS,
  createSaRoadEventsLayer,
  normalizeSaRoadEventLines,
  normalizeSaRoadEventPoints,
  saRoadEventKeyFromPick,
} from './index.js';

const fixture = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`../../data/fixtures/${name}`, import.meta.url),
      'utf8',
    ),
  );
const points = normalizeSaRoadEventPoints(
  fixture('trafficsa-points-sample.json'),
).records;
const lines = normalizeSaRoadEventLines(
  fixture('trafficsa-lines.json'),
).records;
const FEED = Date.UTC(2026, 9, 13, 4, 50); // 15:20 ACDT
const snapshot = (overrides = {}) => ({
  points,
  lines,
  fetchedAt: FEED,
  stale: false,
  mirror: false,
  ...overrides,
});
const kindCount = (kind) => points.filter((p) => p.kind === kind).length;
const NEAR = Cesium.Cartesian3.fromDegrees(138.6, -34.9, 2_000_000);
const FAR = Cesium.Cartesian3.fromDegrees(-41.4, 34.9, 2_000_000);
const now = () => Cesium.JulianDate.now();

function harness(results, { pick = () => null } = {}) {
  const queue = [...results];
  const overlay = { entries: new Map(), visible: null };
  const clicks = { handler: null, destroyed: 0 };
  const owners = new Map();
  const preRender = new Set();
  const sources = [];
  const viewer = {
    camera: { positionWC: NEAR },
    scene: {
      pick,
      requestRender() {},
      preRender: {
        addEventListener(fn) {
          preRender.add(fn);
          return () => preRender.delete(fn);
        },
      },
    },
    dataSources: {
      add: (value) => sources.push(value),
      remove: (value) => sources.splice(sources.indexOf(value), 1),
    },
  };
  let fetches = 0;
  const layer = createSaRoadEventsLayer({
    source: {
      async getSnapshot({ signal }) {
        fetches++;
        signal.throwIfAborted();
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (typeof next === 'function') return next(signal);
        if (next instanceof Error) throw next;
        return next;
      },
    },
    overlayHost: {
      setEntries: (id, entries) => overlay.entries.set(id, entries),
      setVisible: (id, visible) => (overlay.visible = visible),
      clearSource: (id) => overlay.entries.delete(id),
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction: (callback) => (clicks.handler = callback),
      destroy() {
        clicks.destroyed++;
        clicks.handler = null;
      },
    }),
    picking: {
      resolvePickId: (picked) => picked?.id ?? null,
      isOwnedByOtherLayer: (layerId, id) => String(id).startsWith('other:'),
      registerPickOwner: (id, predicate) => owners.set(id, predicate),
      unregisterPickOwner: (id) => owners.delete(id),
    },
    pointer: { isPointerFree: () => true },
  });
  layer.init(viewer);
  return {
    layer,
    viewer,
    sources,
    overlay,
    clicks,
    owners,
    preRender,
    fetches: () => fetches,
    entities: () => sources[0].entities.values,
  };
}

test('pick ids resolve only for this layer', () => {
  assert.equal(saRoadEventKeyFromPick('sa-road-event:point:42'), 'point:42');
  assert.equal(saRoadEventKeyFromPick('sa-road-event:line:7:0'), 'line:7');
  assert.equal(saRoadEventKeyFromPick('fire-perimeter:42'), null);
  assert.equal(saRoadEventKeyFromPick('sa-road-event:blob:1'), null);
  assert.equal(saRoadEventKeyFromPick('sa-road-event:point:'), null);
  assert.equal(saRoadEventKeyFromPick(42), null);
});

test('a disabled layer never fetches; enabled, it renders and reports stats', async () => {
  const h = harness([snapshot()]);
  assert.equal(await h.layer.update(), false);
  assert.equal(h.fetches(), 0);
  h.layer.enable();
  assert.ok(h.owners.has('sa-road-events'));
  assert.equal(await h.layer.update(), true);
  const d = h.layer.getDiagnostics();
  assert.equal(d.points, points.length);
  assert.equal(d.lines, 8);
  assert.equal(d.entities, points.length + 8);
  assert.equal(d.horizonListener, true);
  const stats = h.layer.getStats();
  assert.equal(stats.error, null);
  assert.equal(stats.stale, false);
  assert.ok(Number.isFinite(stats.lastUpdate));
  assert.equal(h.layer.id, 'sa-road-events');
  assert.equal(h.layer.name, 'SA Road Events');
  assert.equal(h.layer.source, 'Traffic SA');
  assert.equal(h.layer.updateInterval, 120000);
});

test('incidents and closures show by default; both roadworks kinds do not', async () => {
  assert.deepEqual(SA_ROAD_EVENT_DEFAULT_VISIBLE_KINDS, [
    'incident',
    'collision',
    'flooding',
    'waterworks',
    'unknown',
  ]);
  const h = harness([snapshot()]);
  h.layer.enable();
  await h.layer.update();
  const shown = kindCount('incident');
  assert.ok(kindCount('works') > 0 && kindCount('works24') > 0);
  assert.equal(h.layer.getDiagnostics().shownPoints, shown);
  assert.equal(h.layer.getStats().count, shown + 8, 'lines are always shown');
  const hidden = h
    .entities()
    .filter((e) => e.id.startsWith('sa-road-event:point:') && !e.show);
  assert.equal(hidden.length, kindCount('works') + kindCount('works24'));
  const { chips, info } = h.layer.getRowControls();
  assert.ok(chips.every((chip) => chip.active === false));
  assert.ok(
    chips[0].label.endsWith(' · ' + kindCount('works24')),
    chips[0].label,
  );
  assert.ok(
    chips[1].label.endsWith(' · ' + kindCount('works')),
    chips[1].label,
  );
  assert.match(
    info,
    new RegExp(kindCount('works24') + kindCount('works') + ' roadworks hidden'),
  );
});

test('an empty-looking default reads as quiet, not as an outage', async () => {
  const h = harness([
    snapshot({
      points: points.filter((p) => p.kind !== 'incident'),
      lines: [],
    }),
  ]);
  h.layer.enable();
  await h.layer.update();
  const { info } = h.layer.getRowControls();
  assert.match(info, /Feed updated 15:20 ACDT/);
  assert.match(info, /No incidents or closures reported right now/);
  assert.match(info, /roadworks hidden/);
  assert.doesNotMatch(info, /unavailable|failed/i);
  assert.equal(h.layer.getStats().error, null);
});

const liveSources = (overrides = {}) => ({
  roadworks: { status: 'live', fetchedAt: FEED, mirror: false },
  incidents: { status: 'live', fetchedAt: FEED, mirror: false },
  closures: { status: 'live', fetchedAt: FEED, mirror: false },
  ...overrides,
});
const unavailable = { status: 'unavailable', fetchedAt: null, mirror: false };
const geohubIncidents = normalizeSaRoadEventPoints(
  fixture('trafficsa-geohub-incidents.json'),
  { source: 'incidents' },
).records;
const geohubClosures = normalizeSaRoadEventLines(
  fixture('trafficsa-geohub-closures.json'),
).records;
const roadworksOnly = points.filter((p) => p.kind.startsWith('works'));

test('collision, flooding and waterworks are shown by default and get their own legend rows', async () => {
  for (const kind of ['collision', 'flooding', 'waterworks'])
    assert.ok(SA_ROAD_EVENT_DEFAULT_VISIBLE_KINDS.includes(kind), kind);
  const h = harness([
    snapshot({
      points: [...roadworksOnly, ...geohubIncidents],
      lines: geohubClosures,
    }),
  ]);
  h.layer.enable();
  await h.layer.update();
  assert.equal(
    h.layer.getDiagnostics().shownPoints,
    geohubIncidents.length,
    'every incident-class kind is on, both roadworks kinds are off',
  );
  const { legend } = h.layer.getRowControls();
  const count = (label) => legend.find((row) => row.label === label)?.count;
  assert.equal(count('Collision'), 1);
  assert.equal(count('Flooding'), 1);
  assert.equal(count('Emergency waterworks'), 1);
  assert.equal(
    count('Incident'),
    geohubIncidents.filter((p) => p.kind === 'incident').length,
  );
  assert.equal(count('Road closure'), 4);
  assert.equal(count('Detour'), 2);
  assert.equal(legend[0].label, 'Incident', 'the blurb stays on the first row');
  assert.ok(legend[0].blurb);
  assert.equal(
    new Set(legend.map((row) => row.color)).size,
    legend.filter((row) => row.label !== 'Road closure').length,
    'incident-class kinds are told apart by colour (a closure shares incident red)',
  );
  const colors = h
    .entities()
    .filter((e) => e.id.startsWith('sa-road-event:point:inc-'))
    .map((e) => e.point.color.getValue(now()).toCssHexString());
  assert.ok(new Set(colors).size >= 4);
  assert.equal(
    h.layer.getAnalystRecords().filter((r) => r.kind === 'collision').length,
    1,
  );
});

test('an incident/closure outage is stated, never read as a quiet network', async () => {
  const h = harness([
    snapshot({
      points: roadworksOnly,
      lines: [],
      sources: liveSources({ incidents: unavailable, closures: unavailable }),
    }),
  ]);
  h.layer.enable();
  await h.layer.update();
  const { info } = h.layer.getRowControls();
  assert.match(info, /Incidents and closures unavailable/);
  assert.doesNotMatch(info, /No incidents or closures reported/);
  assert.match(info, /roadworks hidden/, 'roadworks still show');
  assert.equal(h.layer.getStats().error, null, 'the layer itself is up');

  const incidentsOnly = harness([
    snapshot({
      points: roadworksOnly,
      lines: geohubClosures,
      sources: liveSources({ incidents: unavailable }),
    }),
  ]);
  incidentsOnly.layer.enable();
  await incidentsOnly.layer.update();
  const only = incidentsOnly.layer.getRowControls().info;
  assert.match(only, /Incidents unavailable/);
  assert.doesNotMatch(only, /Closures/);

  const closuresOnly = harness([
    snapshot({
      points: [...roadworksOnly, ...geohubIncidents],
      lines: [],
      sources: liveSources({ closures: unavailable }),
    }),
  ]);
  closuresOnly.layer.enable();
  await closuresOnly.layer.update();
  assert.match(
    closuresOnly.layer.getRowControls().info,
    /Closures and detours unavailable/,
  );

  const noRoadworks = harness([
    snapshot({
      points: geohubIncidents,
      lines: geohubClosures,
      sources: liveSources({ roadworks: unavailable }),
    }),
  ]);
  noRoadworks.layer.enable();
  await noRoadworks.layer.update();
  const roadworksInfo = noRoadworks.layer.getRowControls().info;
  assert.match(roadworksInfo, /Roadworks unavailable/);
  assert.doesNotMatch(roadworksInfo, /roadworks hidden/);
});

test('only the roadworks group is described as coming from the mirror', async () => {
  const h = harness([
    snapshot({
      mirror: true,
      sources: liveSources({
        roadworks: { status: 'live', fetchedAt: FEED, mirror: true },
      }),
    }),
  ]);
  h.layer.enable();
  await h.layer.update();
  assert.match(
    h.layer.getRowControls().info,
    /Roadworks served from the Traffic SA mirror service/,
  );
});

test('markers are ground-clamped, kind-coloured and never depth-tested away', async () => {
  const h = harness([snapshot()]);
  h.layer.enable();
  await h.layer.update();
  const entityFor = (kind) => {
    const record = points.find((p) => p.kind === kind);
    return h
      .entities()
      .find((e) => e.id === `sa-road-event:point:${record.id}`);
  };
  const graphic = entityFor('incident').point;
  assert.equal(
    graphic.heightReference.getValue(now()),
    Cesium.HeightReference.CLAMP_TO_GROUND,
  );
  assert.equal(
    graphic.disableDepthTestDistance.getValue(now()),
    Number.POSITIVE_INFINITY,
  );
  assert.equal(graphic.color.getValue(now()).toCssHexString(), '#ff3b30');
  const amber = entityFor('works24').point.color.getValue(now());
  assert.equal(amber.toCssHexString(), '#ffab00');
});

test('closure lines are ground-clamped, width 4, drawn on terrain and 3D tiles', async () => {
  const h = harness([snapshot()]);
  h.layer.enable();
  await h.layer.update();
  const polylines = h.entities().filter((e) => e.polyline);
  assert.equal(polylines.length, 8);
  for (const entity of polylines) {
    const line = entity.polyline;
    assert.equal(line.clampToGround.getValue(now()), true);
    assert.equal(line.width.getValue(now()), 4);
    assert.equal(
      line.classificationType.getValue(now()),
      Cesium.ClassificationType.BOTH,
    );
    assert.match(
      line.material.getValue(now()).color.toCssHexString(),
      /^#ff3b30/,
    );
  }
  assert.match(polylines[0].id, /^sa-road-event:line:\d+:0$/);
});

test('a detour line takes a distinct dashed material', async () => {
  const detour = { ...lines[0], id: '9001', kind: 'detour' };
  const h = harness([snapshot({ lines: [lines[1], detour] })]);
  h.layer.enable();
  await h.layer.update();
  const [closure, dashed] = h.entities().filter((e) => e.polyline);
  const closureColor = closure.polyline.material
    .getValue(now())
    .color.toCssHexString();
  const detourMaterial = dashed.polyline.material.getValue(now());
  assert.notEqual(closureColor, detourMaterial.color.toCssHexString());
  assert.ok(detourMaterial.dashLength > 0, 'detours are dashed');
});

test('row chips switch the roadworks kinds without refetching', async () => {
  const h = harness([snapshot()]);
  h.layer.enable();
  await h.layer.update();
  let repaints = 0;
  h.layer.setRowControlsListener(() => repaints++);
  const chip = (id) =>
    h.layer.getRowControls().chips.find((entry) => entry.id === id);
  assert.equal(chip('works24').active, false);
  assert.equal(chip('works').active, false);
  const fetches = h.fetches();
  chip('works').onClick();
  assert.equal(chip('works').active, true);
  assert.equal(repaints, 1);
  assert.equal(
    h.layer.getDiagnostics().shownPoints,
    kindCount('incident') + kindCount('works'),
  );
  chip('works24').onClick();
  assert.equal(chip('works24').active, true);
  assert.equal(h.layer.getDiagnostics().shownPoints, points.length);
  chip('works24').onClick();
  assert.equal(chip('works24').active, false);
  chip('works').onClick();
  chip('works').onClick();
  assert.equal(h.fetches(), fetches, 'toggling is local');
  h.layer.setRowControlsListener(null);
  chip('works').onClick();
});

test('the legend counts every loaded kind and the row states the feed time', async () => {
  const h = harness([snapshot({ stale: true, mirror: true })]);
  assert.match(h.layer.getRowControls().info, /^Waiting for Traffic SA/);
  h.layer.enable();
  await h.layer.update();
  const { legend, info, infoTitle } = h.layer.getRowControls();
  const count = (label) => legend.find((row) => row.label === label)?.count;
  assert.equal(count('Incident'), kindCount('incident'));
  assert.equal(count('24 h roadworks'), kindCount('works24'));
  assert.equal(
    count('Roadworks'),
    kindCount('works'),
    'hidden kinds still count',
  );
  assert.equal(count('Road closure'), 8);
  assert.equal(count('Detour'), 0);
  assert.equal(count('Other'), undefined, 'no unknown kind, no legend row');
  assert.ok(legend[0].blurb);
  assert.ok(legend.every((row) => /^#[0-9a-f]{6}$/.test(row.color)));
  assert.match(info, /Feed updated 15:20 ACDT · STALE/);
  assert.match(info, /mirror service/);
  assert.match(infoTitle, /CC BY 4\.0/);
});

test('a failed or malformed refresh keeps the previous entities and says so', async () => {
  const bad = snapshot({
    points: [{ ...points[0], lon: 0 }, ...points.slice(1)],
  });
  const h = harness([
    snapshot(),
    new Error('Traffic SA HTTP 502'),
    bad,
    { points: 'x' },
    snapshot({ fetchedAt: FEED + 120000 }),
  ]);
  h.layer.enable();
  assert.equal(await h.layer.update(), true);
  const before = [...h.entities()];
  const shown = h.layer.getStats().count;

  assert.equal(await h.layer.update(), false);
  assert.equal(h.layer.getStats().error, 'Traffic SA HTTP 502');
  assert.match(
    h.layer.getRowControls().info,
    /Feed updated 15:20 ACDT.*Last refresh failed; showing the previous data/,
  );
  assert.deepEqual([...h.entities()], before, 'entities are untouched');

  for (let i = 0; i < 2; i++) {
    assert.equal(await h.layer.update(), false);
    assert.match(h.layer.getStats().error, /Malformed Traffic SA snapshot/);
    assert.deepEqual([...h.entities()], before);
    assert.equal(h.layer.getStats().count, shown);
  }

  assert.equal(await h.layer.update(), true);
  assert.equal(h.layer.getStats().error, null);
  const recovered = h.layer.getRowControls().info;
  assert.match(recovered, /Feed updated 15:22 ACDT/);
  assert.doesNotMatch(recovered, /failed/);
});

test('an unchanged snapshot keeps entity identity but still advances the feed time', async () => {
  const h = harness([snapshot(), snapshot({ fetchedAt: FEED + 120000 })]);
  h.layer.enable();
  await h.layer.update();
  const before = [...h.entities()];
  await h.layer.update();
  const after = h.entities();
  assert.equal(after.length, before.length);
  assert.ok(before.every((entity, i) => entity === after[i]));
  assert.match(h.layer.getRowControls().info, /15:22 ACDT/);
});

test('changed data replaces entities in one step', async () => {
  const h = harness([snapshot(), snapshot({ points: points.slice(0, 2) })]);
  h.layer.enable();
  await h.layer.update();
  await h.layer.update();
  assert.equal(h.layer.getDiagnostics().points, 2);
  assert.equal(h.entities().length, 2 + 8);
});

test('late refresh cannot publish after disable or destroy', async () => {
  for (const action of ['disable', 'destroy']) {
    let resolve, signal;
    const h = harness([
      (s) => {
        signal = s;
        return new Promise((done) => (resolve = done));
      },
    ]);
    h.layer.enable();
    const pending = h.layer.update();
    h.layer[action]();
    assert.equal(signal.aborted, true);
    resolve(snapshot());
    assert.equal(await pending, false);
    assert.equal(h.layer.getStats().count, 0);
    h.layer.destroy();
  }
});

function pickable() {
  const state = { next: null };
  return { state, pick: () => state.next };
}
const click = (h) => h.clicks.handler({ position: { x: 10, y: 10 } });
const cardOf = (h) => h.overlay.entries.get(SA_ROAD_EVENTS_OVERLAY_SOURCE_ID);

test('clicking a point or a line publishes its card; empty space clears it', async () => {
  const p = pickable();
  const h = harness([snapshot()], { pick: p.pick });
  h.layer.enable();
  await h.layer.update();
  assert.equal(h.overlay.visible, true);

  const incident = points.find((r) => r.kind === 'incident');
  p.state.next = { id: `sa-road-event:point:${incident.id}` };
  click(h);
  const [card] = cardOf(h);
  assert.equal(card.title, 'INCIDENT · Birdsville Track');
  assert.equal(card.details.at(-1), 'Feed updated 15:20 ACDT');
  assert.equal(card.interactive, false);
  assert.ok(card.position, 'anchored in the world');
  assert.equal(h.layer.getDiagnostics().selectedKey, `point:${incident.id}`);

  p.state.next = { id: `sa-road-event:line:${lines[0].id}:0` };
  click(h);
  assert.equal(cardOf(h)[0].title, 'ROAD CLOSURE · MORGAN VALE ROAD');

  p.state.next = { id: 'other:thing' };
  click(h);
  assert.equal(
    cardOf(h).length,
    1,
    'a sibling layer pick leaves the card alone',
  );

  p.state.next = null;
  click(h);
  assert.deepEqual(cardOf(h), []);
  assert.equal(h.layer.getDiagnostics().selectedKey, null);
});

test('the open card follows the feed and goes away when its event does', async () => {
  const p = pickable();
  const incident = points.find((r) => r.kind === 'incident');
  const h = harness(
    [
      snapshot(),
      snapshot({ fetchedAt: FEED + 120000, stale: true }),
      snapshot({ points: points.filter((r) => r !== incident) }),
    ],
    { pick: p.pick },
  );
  h.layer.enable();
  await h.layer.update();
  p.state.next = { id: `sa-road-event:point:${incident.id}` };
  click(h);
  await h.layer.update();
  assert.match(cardOf(h)[0].details.at(-1), /^Feed updated 15:22 ACDT · STALE/);
  await h.layer.update();
  assert.deepEqual(cardOf(h), [], 'a vanished event drops its card');
});

test('hiding a kind drops the card of a selected event of that kind', async () => {
  const p = pickable();
  const h = harness([snapshot()], { pick: p.pick });
  h.layer.enable();
  await h.layer.update();
  const works = points.find((r) => r.kind === 'works24');
  h.layer
    .getRowControls()
    .chips.find((c) => c.id === 'works24')
    .onClick();
  p.state.next = { id: `sa-road-event:point:${works.id}` };
  click(h);
  assert.equal(cardOf(h).length, 1);
  h.layer
    .getRowControls()
    .chips.find((c) => c.id === 'works24')
    .onClick();
  assert.deepEqual(cardOf(h), []);
});

test('disable removes the click handler, pick ownership and any card', async () => {
  const p = pickable();
  const h = harness([snapshot()], { pick: p.pick });
  h.layer.enable();
  await h.layer.update();
  p.state.next = { id: `sa-road-event:line:${lines[0].id}:0` };
  click(h);
  h.layer.disable();
  assert.equal(h.clicks.destroyed, 1);
  assert.equal(h.clicks.handler, null);
  assert.equal(h.owners.size, 0);
  assert.equal(h.overlay.entries.has(SA_ROAD_EVENTS_OVERLAY_SOURCE_ID), false);
  assert.equal(h.overlay.visible, false);
  assert.equal(h.preRender.size, 0);
  assert.equal(h.sources[0].show, false);
  h.layer.enable();
  assert.equal(h.owners.size, 1);
  assert.equal(h.sources[0].show, true);
});

test('markers on the far side of the globe are culled, then return', async () => {
  const h = harness([snapshot()]);
  h.layer.enable();
  await h.layer.update();
  const shown = h.layer.getDiagnostics().shownPoints;
  assert.ok(shown > 0);
  const [cull] = [...h.preRender];
  h.viewer.camera.positionWC = FAR;
  cull();
  assert.equal(h.layer.getDiagnostics().shownPoints, 0);
  h.viewer.camera.positionWC = NEAR;
  cull();
  assert.equal(h.layer.getDiagnostics().shownPoints, shown);
});

test('analyst records are the visible events without geometry', async () => {
  const h = harness([snapshot()]);
  assert.deepEqual(h.layer.getAnalystRecords(), []);
  h.layer.enable();
  await h.layer.update();
  const rows = h.layer.getAnalystRecords();
  assert.equal(rows.length, 8 + kindCount('incident'));
  for (const row of rows) {
    assert.ok(Number.isFinite(row.lat) && Number.isFinite(row.lon));
    assert.equal(row.lines, undefined);
    assert.equal(row.anchor, undefined);
  }
  const incident = rows.find((r) => r.kind === 'incident');
  assert.equal(
    incident.id,
    `point:${points.find((r) => r.kind === 'incident').id}`,
  );
  assert.equal(incident.description, 'Ferry Closed');
  assert.equal(h.layer.getAnalystRecords(3).length, 3);
  assert.equal(h.layer.getAnalystRecords(0).length, 1);
});

test('destroy releases everything and restores the default filter', async () => {
  const h = harness([snapshot()]);
  h.layer.enable();
  await h.layer.update();
  h.layer
    .getRowControls()
    .chips.find((c) => c.id === 'works')
    .onClick();
  h.layer.destroy();
  assert.equal(h.sources.length, 0);
  assert.equal(h.layer.getStats().count, 0);
  assert.equal(h.preRender.size, 0);
  assert.equal(
    h.layer.getRowControls().chips.find((c) => c.id === 'works').active,
    false,
  );
  assert.throws(() => createSaRoadEventsLayer({}), /snapshot source/);
});
