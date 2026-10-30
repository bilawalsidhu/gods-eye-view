import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShareLinkManager } from '../sharelink.js';
import { createDefaultLayerState } from '../data/layerState.js';
import { HUD_LAYOUTS } from '../hudLayoutPolicy.js';
import { VIEW_MAPS, VIEW_STYLES } from '../view/index.js';
import {
  HAL_EXAMPLE_HASH,
  pick,
  randomLayerState,
  rng,
} from '../testSupport/shareViewFixtures.mjs';
import {
  SHARE_VIEW_PANELS,
  SHARE_VIEW_STYLE_PARAMS,
  decodeShareView,
  encodeShareView,
} from './viewCodec.js';
import { SHARE_VIEW_STYLE_DEFAULTS } from './viewCodec.js';
import {
  LEGACY_SHARE_STATE_KEYS,
  fromLegacyShareState,
  toLegacyShareState,
} from './legacyShareState.js';

const DEG = Math.PI / 180;

function stubViewer(camera = {}) {
  return {
    camera: {
      changed: { addEventListener: () => () => {} },
      positionCartographic: camera.position ?? {
        latitude: 0,
        longitude: 0,
        height: 0,
      },
      heading: camera.heading ?? 0,
      pitch: camera.pitch ?? 0,
      roll: camera.roll ?? 0,
    },
  };
}

/** The long form's own parser, run on `hash`. */
function parseLegacy(hash) {
  const body = hash.startsWith('#') ? hash : `#${hash}`;
  globalThis.window = {
    location: { hash: body, href: `http://localhost/${body}` },
  };
  const manager = new ShareLinkManager(stubViewer());
  const parsed = manager.parseInitialHash();
  manager.destroy();
  return parsed;
}

/**
 * The parsed state as a view: restore bookkeeping removed, and headings and
 * rolls wrapped into [0, 360) — the codec's one normalization of values the
 * long-form generator writes (Cesium can round 359.6° up to `roll=360`).
 */
function comparable(parsed) {
  const out = {};
  for (const key of LEGACY_SHARE_STATE_KEYS) out[key] = parsed[key];
  // A long link without `sp` leaves the style's parameters as they are; the
  // compact form says what they are, the style's own unless changed.
  const ownParams = SHARE_VIEW_STYLE_DEFAULTS[out.style].styleParams;
  out.styleParams = ownParams ? { ...ownParams, ...out.styleParams } : null;
  for (const key of ['heading', 'roll'])
    out[key] = ((out[key] % 360) + 360) % 360;
  return out;
}

/** Legacy hash → parsed state → codec → parsed state, asserting equality. */
function assertLegacyRoundTrip(hash) {
  const parsed = parseLegacy(hash);
  assert.ok(parsed, `long form parses: ${hash}`);
  const state = fromLegacyShareState(parsed);
  const encoded = encodeShareView(state);
  const decoded = decodeShareView(encoded, { nowMs: Date.now() });
  assert.equal(decoded.ok, true, decoded.reason);
  assert.deepEqual(decoded.state, state, 'codec state survives');
  assert.deepEqual(
    toLegacyShareState(decoded.state),
    comparable(parsed),
    'parsed long-form state survives',
  );
  return { parsed, state, encoded };
}

test('the HAL example survives the round trip and shrinks to 39 characters', () => {
  const { parsed, state, encoded } = assertLegacyRoundTrip(HAL_EXAMPLE_HASH);
  assert.equal(HAL_EXAMPLE_HASH.length, 302);
  assert.equal(encoded.length, 39);
  assert.equal(encoded, 'ARCg-SQYrah3ILAJKB4wO1IEAIQAEGIBNMgBC1o');
  assert.equal(parsed.roll, 360);
  assert.equal(state.roll, 0);
  assert.deepEqual(state.layerState.enabledLayerIds, [
    'ais-live-vessels',
    'flights',
    'satellites',
  ]);
  assert.equal(state.layerState.options.flights.models3d, true);
  assert.equal(state.layerState.options.wind.overlay, 'none');
  assert.deepEqual(
    state.panelState.specs.find((spec) => spec.id === 'cctv-panel'),
    { id: 'cctv-panel', collapsed: false, pinned: null },
  );
});

test('a long-form link to the retired Snow style opens as Normal', () => {
  const snow = parseLegacy('v=2&lat=1&lon=2&style=snow&sp=d.90_w.20');
  const normal = parseLegacy('v=2&lat=1&lon=2');
  assert.equal(snow.style, 'normal');
  assert.deepEqual(snow.styleParams, normal.styleParams);
});

test('links from earlier long-form versions keep their historical meaning', () => {
  for (const hash of [
    'lat=10&lon=20',
    'lat=37.7749&lon=-122.4194&alt=800&heading=0&pitch=-35&style=nvg&bloom=1&bi=84&sharpen=0&si=65&hud=tactical&hv=1&dm=BALANCED&dd=50&da=elastic&kf=16&ko=0&cr=0&map=photoreal',
    'v=2&lat=1&lon=2&l=f&lo=f.m.a',
    'v=2&lat=1&lon=2&l=',
    'v=2&lat=1&lon=2&l=k.r&lo=r.f.g-jazz_r.v.35',
    'v=2&lat=1&lon=2&ui=v.c.0',
    'v=2&lat=1&lon=2&style=crt&sp=p.500_d.25_i.100',
    'v=2&lat=1&lon=2&sce=0&scf=999&dm=GOD&dd=10&at=1767225600',
  ]) {
    assertLegacyRoundTrip(hash);
  }
  // A pre-v2 link's omitted settings are written explicitly, so the compact
  // form keeps the fallbacks the long form gives them (ko=5, kf=16, scf=35).
  const old = fromLegacyShareState(parseLegacy('lat=10&lon=20'));
  assert.deepEqual(
    [old.detectionOutsideOpacityPct, old.detectionFadePct, old.scopeFeatherPct],
    [5, 16, 35],
  );
  assert.deepEqual(
    [old.bloomIntensity, old.bloomVersion],
    [50, 1],
    'legacy bloom scale',
  );
  // `l=f` without `e` is a v2 link with 3D models OFF; the codec writes that.
  const off = fromLegacyShareState(parseLegacy('v=2&lat=1&lon=2&l=f'));
  assert.equal(off.layerState.options.flights.models3d, false);
});

test('a tracking selection becomes a thing view and back', () => {
  const flights = assertLegacyRoundTrip('v=2&lat=1&lon=2&l=f&lo=f.t.a1b2c3');
  assert.deepEqual(flights.state.view.entity, {
    kind: 'aircraft',
    id: 'a1b2c3',
  });
  assert.equal(
    flights.state.layerState.options.flights.selectedFlightsTrackingId,
    null,
  );
  const military = assertLegacyRoundTrip('v=2&lat=1&lon=2&l=m&lo=f.u.~ae1234');
  assert.deepEqual(military.state.view.entity, {
    kind: 'military_aircraft',
    id: '~ae1234',
  });
  const satellite = assertLegacyRoundTrip('v=2&lat=1&lon=2&l=s&lo=s.t.25544');
  assert.deepEqual(satellite.state.view.entity, {
    kind: 'satellite',
    id: '25544',
  });
  assert.equal(
    toLegacyShareState(satellite.state).layerState.options.satellites
      .selectedSatTrackingId,
    25544,
  );
});

test('thing views the long form cannot express convert without one', () => {
  const layerState = createDefaultLayerState();
  layerState.enabledLayerIds = ['ais-live-vessels'];
  const vessel = toLegacyShareState({
    lat: 1,
    lon: 2,
    layerState,
    view: { kind: 'thing', entity: { kind: 'vessel', id: '366999712' } },
  });
  assert.deepEqual(vessel.layerState, layerState);
});

test('a thing view turns its layer on, with or without a layer set', () => {
  for (const layerState of [createDefaultLayerState(), null]) {
    const legacy = toLegacyShareState({
      layerState,
      view: { kind: 'thing', entity: { kind: 'aircraft', id: 'a1b2c3' } },
    });
    assert.deepEqual(legacy.layerState.enabledLayerIds, ['flights']);
    assert.equal(
      legacy.layerState.options.flights.selectedFlightsTrackingId,
      'a1b2c3',
    );
    assert.equal(legacy.layerStateInvalid, false);
  }
  const vessel = toLegacyShareState({
    view: { kind: 'thing', entity: { kind: 'vessel', id: '366999712' } },
  });
  assert.deepEqual(vessel.layerState.enabledLayerIds, ['ais-live-vessels']);
  // A place view without a layer set leaves the recipient's layers alone.
  assert.equal(toLegacyShareState({ lat: 1, lon: 2 }).layerState, null);
});

/** A long-form link written by the real generator from random live state. */
function generatedLegacyHash(random) {
  const int = (min, max) => min + Math.floor(random() * (max - min + 1));
  globalThis.window = { location: { hash: '', href: 'http://localhost/' } };
  const manager = new ShareLinkManager(
    stubViewer({
      position: {
        latitude: (int(-899999, 899999) / 1e4) * DEG,
        longitude: (int(-1799999, 1799999) / 1e4) * DEG,
        height: pick(random, [int(-50, 3000), int(0, 30_000_000)]),
      },
      heading: int(0, 359) * DEG + (random() < 0.1 ? 0.99 * DEG : 0),
      pitch: int(-90, 0) * DEG,
      roll: pick(random, [0, 359.7 * DEG, int(0, 359) * DEG]),
    }),
  );
  const style = pick(random, VIEW_STYLES);
  manager.onStyleChange(style);
  const density = pick(random, [0, 25, 50, 75, 100]);
  manager.onToggleChange(random() < 0.5, random() < 0.5, {
    bloomIntensity: int(0, 100),
    bloomVersion: pick(random, [1, 2]),
    sharpenIntensity: int(0, 100),
    hudVariant: pick(random, HUD_LAYOUTS),
    hudVisible: random() < 0.5,
    detectionMode: pick(random, ['OFF', 'SPARSE', 'BALANCED', 'DENSE']),
    detectionDensity: density,
    detectionAllocation: pick(random, ['ELASTIC', 'WEIGHTED']),
    detectionFadePct: int(0, 40),
    detectionOutsideOpacityPct: int(0, 100),
    celestialRingEnabled: random() < 0.5,
    scopeEnabled: random() < 0.5,
    scopeFeatherPct: int(0, 200),
    scopeTerminusPct: random() < 0.3 ? int(94, 100) : null,
    mapStack: pick(random, VIEW_MAPS),
  });
  if (random() < 0.8) {
    const layerState = randomLayerState(random);
    manager.setLayerStateProvider(() => layerState);
  }
  if (random() < 0.8) {
    const panelState = {
      specs: SHARE_VIEW_PANELS.filter(() => random() < 0.9).map((panel) => ({
        id: panel.id,
        collapsed: random() < 0.7,
        ...(panel.pinnable ? { pinned: random() < 0.3 } : {}),
      })),
    };
    manager.setPanelStateProvider(() => panelState);
  }
  const specs = SHARE_VIEW_STYLE_PARAMS[style];
  if (specs && random() < 0.7) {
    const values = Object.fromEntries(
      specs.map((spec) => [
        spec.key,
        spec.min + (spec.max - spec.min) * random(),
      ]),
    );
    manager.setStyleParamStateProvider(() => values);
  }
  const params = manager._buildHashParams();
  if (random() < 0.7)
    params.set('at', String(int(1_600_000_000, Math.floor(Date.now() / 1000))));
  manager.destroy();
  return params.toString();
}

test('links written by the long-form generator survive the compact form', () => {
  const random = rng(0xc0dec);
  let totalLegacy = 0;
  let totalCompact = 0;
  for (let i = 0; i < 400; i += 1) {
    const hash = generatedLegacyHash(random);
    const { encoded } = assertLegacyRoundTrip(hash);
    totalLegacy += hash.length;
    totalCompact += encoded.length;
  }
  // Even random states, far from defaults, are under half the length.
  assert.ok(
    totalCompact * 2 < totalLegacy,
    `${totalCompact} vs ${totalLegacy}`,
  );
});

test('the converter ignores non-objects and restore bookkeeping', () => {
  // A malformed v2 layer list is reported by the long-form parser; the view
  // itself simply has no layer set.
  const invalid = parseLegacy('v=2&lat=1&lon=2&l=f.unknown');
  assert.equal(invalid.layerStateInvalid, true);
  assert.equal(fromLegacyShareState(invalid).layerState, null);
  assert.equal(fromLegacyShareState(null), null);
  const parsed = parseLegacy(HAL_EXAMPLE_HASH);
  assert.ok(parsed.restoreAuthority);
  const state = fromLegacyShareState(parsed);
  assert.equal(Object.hasOwn(state, 'restoreAuthority'), false);
  assert.equal(Object.hasOwn(state, 'layerStateInvalid'), false);
});

test('the converter knows every key of the long form’s parsed state', () => {
  // A key the converter does not list would silently drop out of share codes.
  globalThis.window = { location: { hash: '', href: 'http://localhost/' } };
  const manager = new ShareLinkManager(stubViewer({}));
  const parsed = manager._parseShareHash('v=2&lat=1&lon=2');
  assert.deepEqual(
    Object.keys(parsed).sort(),
    [...LEGACY_SHARE_STATE_KEYS].sort(),
  );
  manager.destroy();
});
