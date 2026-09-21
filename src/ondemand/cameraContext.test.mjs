/**
 * cameraContext: camera entity resolution, lanes query/parse, traffic
 * snapshot — pure helpers plus resolveCameraEntity with fakes.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLanesQuery,
  parseOverpassRoads,
  summarizeRoads,
  trafficSnapshot,
  cameraEntityFrom,
  resolveCameraEntity,
  frameFromDocument,
  LANES_RADIUS_M,
} from './cameraContext.js';
import {
  buildEntityContext,
  entitySystemPrompt,
  kindForLayer,
  normalizeEntity,
  splitIntersection,
  cardinalFor,
} from './entityContext.js';

const MLK = {
  id: 'atd-mlk-comal',
  name: 'MARTIN LUTHER KING JR BLVD / COMAL ST',
  city: 'Austin',
  provider: 'Austin Transportation (ATD)',
  lat: 30.28108,
  lon: -97.72259,
  headingDeg: 95,
  pitchDeg: -12,
  fovDeg: 62,
  rangeM: 140,
  elevationM: 160,
  mountHeightM: 7,
  feedType: 'image',
  sourceStatus: 'ok',
  sourceLabel: 'ATD',
};

const OVERPASS = {
  elements: [
    {
      type: 'way',
      id: 11,
      center: { lat: 30.2811, lon: -97.7228 },
      tags: {
        highway: 'primary',
        name: 'East Martin Luther King Jr Boulevard',
        lanes: '4',
        'lanes:forward': '2',
        'lanes:backward': '2',
        maxspeed: '35 mph',
        'turn:lanes:forward': 'left|through;right',
      },
    },
    {
      type: 'way',
      id: 12,
      tags: { highway: 'residential', name: 'Comal Street', lanes: '2', oneway: 'no' },
    },
    { type: 'way', id: 13, tags: { highway: 'service' } },
    { type: 'node', id: 99, tags: { highway: 'traffic_signals' } },
  ],
};

describe('cameraContext — pure helpers', () => {
  test('cctv layer maps to the camera kind; intersection names split and title-case', () => {
    assert.equal(kindForLayer('cctv'), 'camera');
    assert.deepEqual(splitIntersection(MLK.name), ['Martin Luther King Jr Blvd', 'Comal St']);
    assert.deepEqual(splitIntersection('MLK JR BLVD & IH 35 SVRD NB'), ['MLK Jr Blvd', 'IH 35 SVRD NB']);
    assert.equal(cardinalFor(95), 'E');
    assert.equal(cardinalFor(-10), 'N');
    assert.equal(cardinalFor(null), null);
  });

  test('buildLanesQuery asks Overpass for tagged ways around the camera', () => {
    const query = buildLanesQuery(MLK.lat, MLK.lon);
    assert.match(query, /^\[out:json\]\[timeout:10\];way\["highway"~"/);
    assert.ok(query.includes(`(around:${LANES_RADIUS_M},30.281080,-97.722590)`));
    assert.ok(query.endsWith('out tags center;'));
  });

  test('parseOverpassRoads keeps lane tags, parses lane counts, named ways first', () => {
    const roads = parseOverpassRoads(OVERPASS);
    assert.equal(roads.length, 3, 'nodes are skipped, every way kept');
    assert.equal(roads[0].name, 'East Martin Luther King Jr Boulevard');
    assert.equal(roads[0].lanes, 4);
    assert.equal(roads[0].lanesForward, 2);
    assert.equal(roads[0].lanesBackward, 2);
    assert.equal(roads[0].turnLanesForward, 'left|through;right');
    assert.equal(roads[0].maxspeed, '35 mph');
    assert.equal(roads[0].centerLat, 30.2811);
    assert.equal(roads[1].name, 'Comal Street');
    assert.equal(roads[1].oneway, 'no');
    assert.equal(roads[2].name, undefined);
    assert.equal(summarizeRoads(roads), '3 ways (2 named) · lanes tagged on 2');
    assert.equal(summarizeRoads(null), 'roads: not loaded');
    assert.deepEqual(parseOverpassRoads({}), []);
  });

  test('trafficSnapshot reads the Street Traffic layer stats (live sample, closures, mode)', () => {
    const dataManager = {
      isEnabled: (id) => id === 'traffic',
      layers: new Map([
        [
          'traffic',
          {
            module: {
              getStats: () => ({
                mode: 'live',
                status: 'ok',
                providerSource: 'TomTom',
                coverage: 'partial',
                flowCoveragePct: 62,
                closedRoads: 1,
                count: 240,
                flowSegment: { ok: true, currentSpeed: 18, freeFlowSpeed: 45, confidence: 0.9, fetchedAt: '2026-09-21T09:00:00Z' },
              }),
            },
          },
        ],
      ]),
    };
    const snapshot = trafficSnapshot(dataManager);
    assert.equal(snapshot.layerEnabled, true);
    assert.equal(snapshot.mode, 'live');
    assert.equal(snapshot.closedRoads, 1);
    assert.equal(snapshot.flowSegment.currentSpeed, 18);
    assert.equal(snapshot.flowSegment.freeFlowSpeed, 45);
    assert.equal(trafficSnapshot({ layers: new Map() }), null);
  });

  test('frameFromDocument reads the panel <img> proxy URL and load time', () => {
    const now = Date.now();
    const document = {
      getElementById: (id) =>
        id === 'cctv-frame'
          ? {
              dataset: { currentSrc: '/api/cctv/frame/atd-mlk-comal?ts=1', cameraId: 'atd-mlk-comal', loadedAt: String(now - 4000), error: '', loading: '' },
              classList: { contains: (c) => c === 'active' },
              getAttribute: () => null,
            }
          : null,
    };
    const frame = frameFromDocument(document, 'atd-mlk-comal');
    assert.equal(frame.url, '/api/cctv/frame/atd-mlk-comal?ts=1');
    assert.ok(frame.ageSec >= 3 && frame.ageSec <= 6);
    assert.equal(frame.status, 'shown');
    assert.equal(frameFromDocument(document, 'other-camera'), null, 'a stale frame of another camera is never attached');
  });
});

describe('cameraContext — entity + context', () => {
  test('cameraEntityFrom + normalizeEntity carry id, streets, pose, frame, roads, traffic', () => {
    const roads = parseOverpassRoads(OVERPASS);
    const entity = cameraEntityFrom(MLK, {
      frame: { url: '/api/cctv/frame/atd-mlk-comal', capturedAtUtc: '2026-09-21T10:00:10.000Z', ageSec: 3, status: 'shown' },
      roads,
      traffic: { layerEnabled: true, mode: 'live', closedRoads: 0, flowSegment: null },
    });
    const normalized = normalizeEntity('camera', entity);
    assert.equal(normalized.kind, 'camera');
    assert.equal(normalized.cameraId, 'atd-mlk-comal');
    assert.deepEqual(normalized.streets, ['Martin Luther King Jr Blvd', 'Comal St']);
    assert.equal(normalized.headingDeg, 95);
    assert.equal(normalized.headingCardinal, 'E');
    assert.equal(normalized.fovDeg, 62);
    assert.equal(normalized.frame.url, '/api/cctv/frame/atd-mlk-comal');
    assert.equal(normalized.frame.capturedAtUtc, '2026-09-21T10:00:10.000Z');
    assert.equal(normalized.observedAtUtc, '2026-09-21T10:00:10.000Z');
    assert.equal(normalized.roads.length, 3);
    assert.equal(normalized.roads[0].lanes, 4);
    assert.equal(normalized.traffic.mode, 'live');

    const context = buildEntityContext({ entity, kind: 'camera' });
    assert.equal(context.entity.kind, 'camera');
    assert.match(context.scene.coordinates.mgrs, /^14R PU \d{4} \d{4}$/);
    const prompt = entitySystemPrompt(context);
    assert.ok(prompt.includes('selected a live street camera: MARTIN LUTHER KING JR BLVD / COMAL ST'));
    assert.ok(prompt.includes('intersection of Martin Luther King Jr Blvd and Comal St, looking E (95°)'));
    assert.ok(prompt.includes('`entity.roads` lists the OpenStreetMap ways'));
    assert.ok(prompt.includes('web search agent attached to this session'));
    assert.ok(prompt.includes('"lanesForward":2'));
  });

  test('resolveCameraEntity: active camera + lanes via /api/overpass + traffic; Overpass failure leaves roads null', async () => {
    const posted = [];
    const dataManager = {
      isEnabled: () => false,
      layers: new Map([
        ['cctv', { module: { getUIState: () => ({ enabled: true, activeCameraId: MLK.id, activeCamera: MLK, cameras: [MLK] }) } }],
        ['traffic', { module: { getStats: () => ({ mode: 'sim', count: 12 }) } }],
      ]),
    };
    const fetchOk = async (url, init) => {
      posted.push({ url, body: init.body });
      return new Response(JSON.stringify(OVERPASS), { status: 200 });
    };
    const resolved = await resolveCameraEntity({ dataManager, document: { getElementById: () => null }, fetch: fetchOk });
    assert.equal(resolved.kind, 'camera');
    assert.equal(resolved.layerId, 'cctv');
    assert.equal(resolved.entity.id, MLK.id);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].url, '/api/overpass');
    assert.ok(decodeURIComponent(posted[0].body).includes('(around:60,30.281080,-97.722590)'));
    assert.equal(resolved.entity.roads.length, 3);
    assert.equal(resolved.entity.traffic.mode, 'sim');
    assert.equal(resolved.entity.traffic.layerEnabled, false);
    assert.equal(resolved.entity.frame, null);

    const failing = await resolveCameraEntity({ dataManager, document: null, fetch: async () => { throw new Error('offline'); } });
    assert.equal(failing.entity.roads, null, 'a failed lanes lookup never blocks the chat');

    const none = await resolveCameraEntity({ dataManager: { layers: new Map() }, document: null, fetch: fetchOk });
    assert.equal(none, null);
  });
});
