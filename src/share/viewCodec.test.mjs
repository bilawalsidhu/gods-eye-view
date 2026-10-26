import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYER_STATE_REGISTRY,
  LAYER_STATE_TOKEN_RESERVATIONS,
  REGISTERED_LAYER_IDS,
  createDefaultLayerState,
  optionSpecs,
} from '../data/layerState.js';
import { VIEW_FOLLOW_KINDS, VIEW_MAPS, VIEW_STYLES } from '../view/index.js';
import { HUD_LAYOUTS } from '../hudLayoutPolicy.js';
import { ALLOCATION_STRATEGIES } from '../data/detectionPolicy.js';
import { BLOOM_INTENSITY_DEFAULT, BLOOM_SCALE_VERSION } from '../bloom.js';
import {
  pick,
  randomLayerState,
  rng,
} from '../testSupport/shareViewFixtures.mjs';
import {
  SCOPE_TERMINUS_MAX_PCT,
  SCOPE_TERMINUS_MIN_PCT,
} from '../scopeMask.js';
import {
  decodePanelStateParams,
  decodeStyleParamState,
  encodeStyleParamState,
} from '../sharelink.js';
import {
  WIRE_FIXED32,
  WIRE_FIXED64,
  WireWriter,
  decodeBase64Url,
  encodeBase64Url,
} from './wire.js';
import {
  MAX_SHARE_VIEW_CHARS,
  SHARE_VIEW_ENTITY_KINDS,
  SHARE_VIEW_ENUMS,
  SHARE_VIEW_EPOCH_S,
  SHARE_VIEW_FIELDS,
  SHARE_VIEW_FLAGS,
  SHARE_VIEW_LAYER_OPTION_ABSENT,
  SHARE_VIEW_PANELS,
  SHARE_VIEW_STYLE_PARAMS,
  createDefaultShareViewState,
  decodeShareView,
  encodeShareView,
  isShareViewHash,
  layerTokenFromNumber,
  layerTokenNumber,
  normalizeShareViewState,
} from './viewCodec.js';

const NOW_MS = Date.UTC(2026, 9, 26, 12, 0, 0);
const decode = (hash) => decodeShareView(hash, { nowMs: NOW_MS });
const payloadBytes = (hash) => decodeBase64Url(hash.slice(2));
const hashOf = (bytes) => `s=${encodeBase64Url(bytes)}`;

/** Decode and require success, returning the result. */
function decodeOk(hash) {
  const result = decode(hash);
  assert.equal(result.ok, true, `decode failed: ${result.reason}`);
  return result;
}

function assertRoundTrip(state) {
  const hash = encodeShareView(state);
  const result = decodeOk(hash);
  assert.deepEqual(result.state, normalizeShareViewState(state));
  assert.equal(result.unknownFields, undefined);
  assert.equal(result.fallback, undefined);
  assert.equal(encodeShareView(result.state), hash, 'encoding is canonical');
  return hash;
}

function randomState(random) {
  const int = (min, max) => min + Math.floor(random() * (max - min + 1));
  const maybe = (p, value) => (random() < p ? value : undefined);
  const style = pick(random, VIEW_STYLES);
  const params = SHARE_VIEW_STYLE_PARAMS[style];
  const lat = int(-900000, 900000) / 1e4;
  const lon = int(-1800000, 1800000) / 1e4;
  const state = {
    lat,
    lon,
    alt: pick(random, [800, int(-400, 50000), int(0, 40_000_000)]),
    heading: int(0, 359),
    pitch: int(-90, 90),
    roll: pick(random, [0, int(0, 359)]),
    style,
    styleParams:
      params && random() < 0.6
        ? Object.fromEntries(
            params
              .filter(() => random() < 0.7)
              .map((s) => [s.key, int(s.min * 100, s.max * 100) / 100]),
          )
        : null,
    bloomIntensity: maybe(0.5, int(0, 100)),
    bloomVersion: maybe(0.3, pick(random, [1, 2])),
    sharpenIntensity: maybe(0.5, int(0, 100)),
    hudVariant: maybe(0.5, pick(random, [...HUD_LAYOUTS, 'future-hud'])),
    detectionMode: maybe(0.6, pick(random, SHARE_VIEW_ENUMS.detectionMode)),
    detectionDensity: maybe(0.6, pick(random, [0, 25, 50, 75, 100])),
    detectionAllocation: maybe(0.4, pick(random, ALLOCATION_STRATEGIES)),
    detectionFadePct: maybe(0.5, int(0, 40)),
    detectionOutsideOpacityPct: maybe(0.5, int(0, 100)),
    scopeFeatherPct: maybe(0.5, int(0, 200)),
    scopeTerminusPct: maybe(
      0.3,
      int(SCOPE_TERMINUS_MIN_PCT, SCOPE_TERMINUS_MAX_PCT),
    ),
    mapStack: maybe(0.5, pick(random, [...VIEW_MAPS, 'future-map'])),
    layerState: random() < 0.7 ? randomLayerState(random) : null,
    panelState:
      random() < 0.6
        ? {
            specs: SHARE_VIEW_PANELS.filter(() => random() < 0.8).map(
              (panel) => ({
                id: panel.id,
                collapsed: random() < 0.5,
                pinned: panel.pinnable
                  ? pick(random, [true, false, null])
                  : null,
              }),
            ),
          }
        : null,
    sharedAtMs: maybe(0.7, int(1, 2_100_000_000) * 1000),
  };
  for (const flag of SHARE_VIEW_FLAGS)
    if (random() < 0.5) state[flag.key] = random() < 0.5;
  if (random() < 0.4) {
    const entity = pick(random, SHARE_VIEW_ENTITY_KINDS);
    const id =
      entity.kind === 'satellite'
        ? String(int(1, 99999))
        : entity.kind === 'vessel'
          ? pick(random, [
              String(int(100000000, 999999999)),
              '002442000',
              'tmp-7',
            ])
          : pick(random, [
              int(0, 0xffffff).toString(16).padStart(6, '0'),
              '~abc123',
              'adsb_x-1',
            ]);
    state.view = {
      kind: 'thing',
      entity: { kind: entity.kind, id },
      offset:
        random() < 0.6
          ? { range: int(0, 200000), heading: int(0, 359), pitch: int(-90, 90) }
          : null,
      lastKnown:
        random() < 0.6
          ? {
              lat: Math.max(-90, Math.min(90, lat + int(-5000, 5000) / 1e4)),
              lon: Math.max(-180, Math.min(180, lon + int(-5000, 5000) / 1e4)),
              alt: int(-100, 500000),
              observedAtMs: maybe(0.8, int(1, 2_100_000_000) * 1000),
            }
          : null,
    };
  }
  return state;
}

test('an all-default view is the version byte alone', () => {
  const hash = encodeShareView(createDefaultShareViewState());
  assert.equal(hash, 's=AQ');
  assert.deepEqual(decodeOk(hash).state, normalizeShareViewState({}));
  assert.deepEqual(normalizeShareViewState({}), createDefaultShareViewState());
});

test('each setting costs bytes only when it differs from its default', () => {
  const base = payloadBytes(encodeShareView({})).length;
  const changes = {
    lat: 10,
    lon: 10,
    alt: 900,
    heading: 1,
    pitch: -36,
    roll: 1,
    sharedAtMs: NOW_MS,
    style: 'noir',
    mapStack: 'osm',
    hudVariant: 'cyber',
    bloomIntensity: 1,
    bloomVersion: 1,
    sharpenIntensity: 50,
    detectionMode: 'DENSE',
    detectionDensity: 75,
    detectionAllocation: 'WEIGHTED',
    detectionFadePct: 8,
    detectionOutsideOpacityPct: 2,
    scopeFeatherPct: 99,
    scopeTerminusPct: 95,
  };
  const defaults = createDefaultShareViewState();
  for (const [key, value] of Object.entries(changes)) {
    assert.equal(
      payloadBytes(encodeShareView({ [key]: defaults[key] })).length,
      base,
      `${key} at its default is omitted`,
    );
    const changed = { [key]: value };
    if (key === 'detectionMode') changed.detectionDensity = 75;
    assert.ok(
      payloadBytes(assertRoundTrip(changed)).length > base,
      `${key} is encoded`,
    );
  }
  for (const flag of SHARE_VIEW_FLAGS) {
    assert.equal(
      payloadBytes(encodeShareView({ [flag.key]: flag.default })).length,
      base,
    );
    assert.equal(
      payloadBytes(assertRoundTrip({ [flag.key]: !flag.default })).length,
      base + 2,
    );
  }
  // All five booleans flipped still cost one field.
  const flipped = Object.fromEntries(
    SHARE_VIEW_FLAGS.map((f) => [f.key, !f.default]),
  );
  assert.equal(payloadBytes(assertRoundTrip(flipped)).length, base + 2);
});

test('every registered field round-trips at once', () => {
  const layerState = createDefaultLayerState();
  layerState.enabledLayerIds = [
    'flights',
    'satellites',
    'radio',
    'recent-imagery',
    'street-level',
  ];
  Object.assign(layerState.options.flights, {
    models3d: true,
    models3dMode: 'all',
  });
  Object.assign(layerState.options.radio, {
    filter: 'genre:jazz & blues',
    volume: 0.35,
  });
  Object.assign(layerState.options['recent-imagery'], {
    west: -12345678,
    east: 12345678,
    south: -8505110,
    north: 8505110,
    a: 'S30:2026-09-18',
    b: 'VIIRS:2025-01-02',
    mode: 2,
    split: 37,
    viirs: true,
  });
  Object.assign(layerState.options['street-level'], {
    mapillary: false,
    providerSwitches: 'abc-1*def-0',
    sinceDays: 365,
  });
  const state = {
    view: {
      kind: 'thing',
      entity: { kind: 'aircraft', id: 'a1b2c3' },
      offset: { range: 1500, heading: 300, pitch: -20 },
      lastKnown: {
        lat: -33.8601,
        lon: 151.2101,
        alt: 10668,
        observedAtMs: NOW_MS - 12_000,
      },
    },
    lat: -33.8568,
    lon: 151.2153,
    alt: 12000,
    heading: 270,
    pitch: -12,
    roll: 2,
    style: 'thermal',
    styleParams: {
      sensitivity: 0.42,
      bloom: 1,
      mode: 0,
      pixelation: 3.5,
      palette: 0.25,
    },
    bloom: true,
    sharpen: true,
    bloomIntensity: 84,
    bloomVersion: 1,
    sharpenIntensity: 65,
    hudVariant: 'operator',
    hudVisible: true,
    detectionMode: 'SPARSE',
    detectionDensity: 25,
    detectionAllocation: 'WEIGHTED',
    detectionFadePct: 16,
    detectionOutsideOpacityPct: 5,
    celestialRing: true,
    scopeEnabled: false,
    scopeFeatherPct: 35,
    scopeTerminusPct: 97,
    mapStack: 'esri-imagery',
    layerState,
    panelState: {
      specs: SHARE_VIEW_PANELS.map((panel) => ({
        id: panel.id,
        collapsed: !panel.collapsed,
        pinned: panel.pinnable ? true : null,
      })),
    },
    sharedAtMs: NOW_MS,
  };
  const normalized = normalizeShareViewState(state);
  for (const key of Object.keys(state))
    assert.notDeepEqual(
      normalized[key],
      createDefaultShareViewState()[key] ?? undefined,
      key,
    );
  assertRoundTrip(state);
});

test('generated states round-trip exactly and encode canonically', () => {
  const random = rng(0x5eed);
  let things = 0;
  for (let i = 0; i < 1500; i += 1) {
    const state = randomState(random);
    if (state.view?.kind === 'thing') things += 1;
    const hash = encodeShareView(state);
    const result = decodeShareView(hash, { nowMs: Number.MAX_SAFE_INTEGER });
    assert.equal(result.ok, true, `case ${i}: ${result.reason}`);
    assert.deepEqual(result.state, normalizeShareViewState(state), `case ${i}`);
    assert.equal(encodeShareView(result.state), hash, `case ${i} canonical`);
    assert.ok(hash.length < MAX_SHARE_VIEW_CHARS, `case ${i} size`);
  }
  assert.ok(things > 400, 'generator covers thing views');
});

test('normalization is idempotent', () => {
  const random = rng(42);
  for (let i = 0; i < 300; i += 1) {
    const once = normalizeShareViewState(randomState(random));
    assert.deepEqual(normalizeShareViewState(once), once);
  }
});

test('precision: coordinates 1e-4 degrees, angles and lengths whole units', () => {
  const { state } = decodeOk(
    encodeShareView({
      lat: 30.26724,
      lon: -97.74316,
      alt: 600.6,
      heading: 15.4,
      pitch: -30.5,
      roll: 359.6,
    }),
  );
  assert.equal(state.lat, 30.2672);
  assert.equal(state.lon, -97.7432);
  assert.equal(state.alt, 601);
  assert.equal(state.heading, 15);
  assert.equal(state.pitch, -30);
  assert.equal(state.roll, 0, '359.6 rounds to 360, which is 0');
  // Angles wrap into [0, 360) and are stored as the nearer signed turn.
  assert.equal(decodeOk(encodeShareView({ heading: -10 })).state.heading, 350);
  assert.equal(payloadBytes(encodeShareView({ heading: 350 })).length, 3);
  // Out-of-range input is clamped or wrapped, never rejected.
  const wild = decodeOk(
    encodeShareView({ lat: 95, lon: 190, pitch: -120 }),
  ).state;
  assert.deepEqual([wild.lat, wild.lon, wild.pitch], [90, -170, -90]);
});

test('defaults travel as frozen meanings that match today’s app defaults', () => {
  const defaults = createDefaultShareViewState();
  // When an app default moves, these tests should be updated to document the
  // drift; the codec's defaults table must NOT change (see SHARE-LINK-FORMAT).
  assert.equal(defaults.bloomIntensity, BLOOM_INTENSITY_DEFAULT);
  assert.equal(defaults.bloomVersion, BLOOM_SCALE_VERSION);
  assert.equal(defaults.hudVariant, HUD_LAYOUTS[0]);
  assert.deepEqual(SHARE_VIEW_ENUMS.hudVariant.slice(0, HUD_LAYOUTS.length), [
    ...HUD_LAYOUTS,
  ]);
  assert.deepEqual(SHARE_VIEW_ENUMS.style, [...VIEW_STYLES]);
  assert.deepEqual(SHARE_VIEW_ENUMS.mapStack, [...VIEW_MAPS]);
  assert.deepEqual(SHARE_VIEW_ENUMS.detectionAllocation, [
    ...ALLOCATION_STRATEGIES,
  ]);
  for (const kind of VIEW_FOLLOW_KINDS)
    assert.ok(
      SHARE_VIEW_ENTITY_KINDS.some((entry) => entry.kind === kind),
      kind,
    );
});

test('the field registry is well formed and permanent', () => {
  const numbers = SHARE_VIEW_FIELDS.map((f) => f.number);
  assert.equal(new Set(numbers).size, numbers.length);
  assert.equal(
    new Set(SHARE_VIEW_FIELDS.map((f) => f.key)).size,
    numbers.length,
  );
  // Snapshot: changing a number, key or default breaks links in the wild.
  assert.deepEqual(
    SHARE_VIEW_FIELDS.map((f) => [f.number, f.key, f.default]),
    [
      [1, 'view', 'place'],
      [2, 'lat', 0],
      [3, 'lon', 0],
      [4, 'alt', 800],
      [5, 'heading', 0],
      [6, 'pitch', -35],
      [7, 'roll', 0],
      [8, 'sharedAtMs', null],
      [9, 'flags', 0],
      [10, 'layerState', null],
      [11, 'layerOptions', null],
      [12, 'panelState', null],
      [13, 'thing', null],
      [14, 'style', 'normal'],
      [15, 'mapStack', 'photoreal'],
      [16, 'hudVariant', 'tactical'],
      [17, 'bloomIntensity', 0],
      [18, 'bloomVersion', 2],
      [19, 'sharpenIntensity', 49],
      [20, 'detectionMode', 'OFF'],
      [21, 'detectionDensity', 50],
      [22, 'detectionAllocation', 'ELASTIC'],
      [23, 'detectionFadePct', 7],
      [24, 'detectionOutsideOpacityPct', 1],
      [25, 'scopeFeatherPct', 100],
      [26, 'scopeTerminusPct', null],
      [27, 'styleParams', null],
    ],
  );
  assert.deepEqual(
    SHARE_VIEW_FLAGS.map((f) => [f.bit, f.key, f.default]),
    [
      [0, 'bloom', false],
      [1, 'sharpen', false],
      [2, 'hudVisible', false],
      [3, 'celestialRing', false],
      [4, 'scopeEnabled', true],
    ],
  );
  assert.deepEqual(
    SHARE_VIEW_ENTITY_KINDS.map((e) => [e.code, e.kind]),
    [
      [1, 'aircraft'],
      [2, 'military_aircraft'],
      [3, 'vessel'],
      [4, 'satellite'],
    ],
  );
  assert.deepEqual(
    SHARE_VIEW_PANELS.map((p) => [p.number, p.id]),
    SHARE_VIEW_PANELS.map((p, i) => [i, p.id]),
  );
});

test('the panel table agrees with the long form’s panel tokens', () => {
  for (const panel of SHARE_VIEW_PANELS) {
    const decoded = decodePanelStateParams(
      new URLSearchParams(`v=2&ui=${panel.token}.c.1_${panel.token}.p.1`),
    );
    assert.deepEqual(decoded.specs, [
      { id: panel.id, collapsed: true, pinned: panel.pinnable ? true : null },
    ]);
  }
});

test('the style parameter table agrees with the long form’s `sp` codec', () => {
  for (const [style, specs] of Object.entries(SHARE_VIEW_STYLE_PARAMS)) {
    const values = Object.fromEntries(
      specs.map((s, i) => [s.key, s.min + ((s.max - s.min) * (i + 1)) / 7]),
    );
    const params = new URLSearchParams('v=2');
    encodeStyleParamState(params, style, values);
    const legacy = decodeStyleParamState(params, style);
    assert.deepEqual(
      normalizeShareViewState({ style, styleParams: values }).styleParams,
      legacy,
      style,
    );
    assert.deepEqual(
      decodeOk(encodeShareView({ style, styleParams: values })).state
        .styleParams,
      legacy,
      style,
    );
  }
});

test('every layer option has a frozen absent meaning', () => {
  for (const entry of LAYER_STATE_REGISTRY) {
    if (!entry.optionOwner) continue;
    for (const spec of optionSpecs(entry.optionOwner)) {
      assert.ok(
        Object.hasOwn(
          SHARE_VIEW_LAYER_OPTION_ABSENT[entry.optionOwner] || {},
          spec.key,
        ),
        `${entry.optionOwner}.${spec.key} needs an entry in SHARE_VIEW_LAYER_OPTION_ABSENT`,
      );
    }
  }
  // A default-only layer state writes no option bytes at all.
  const layerState = createDefaultLayerState();
  layerState.enabledLayerIds = [...REGISTERED_LAYER_IDS];
  const bytes = payloadBytes(encodeShareView({ layerState }));
  assert.equal(bytes.includes(0x5a), false, 'no layer-options field');
});

test('layer tokens map to permanent numbers covering the whole ledger', () => {
  for (const token of Object.values(LAYER_STATE_TOKEN_RESERVATIONS)) {
    assert.equal(layerTokenFromNumber(layerTokenNumber(token)), token);
  }
  for (const token of ['0', '9', 'a', 'z', '00', '0z', 'zz'])
    assert.equal(layerTokenFromNumber(layerTokenNumber(token)), token);
  assert.equal(layerTokenNumber('00'), 36);
  assert.equal(layerTokenFromNumber(36 + 36 * 36), null);
  const numbers = LAYER_STATE_REGISTRY.map((e) => layerTokenNumber(e.token));
  assert.equal(new Set(numbers).size, numbers.length);
});

test('layer sets: absent, explicitly empty and populated stay distinct', () => {
  assert.equal(
    decodeOk(encodeShareView({ layerState: null })).state.layerState,
    null,
  );
  const empty = decodeOk(
    encodeShareView({ layerState: createDefaultLayerState() }),
  ).state.layerState;
  assert.deepEqual(empty, createDefaultLayerState());
  const all = createDefaultLayerState();
  all.enabledLayerIds = [...REGISTERED_LAYER_IDS];
  assertRoundTrip({ layerState: all });
});

test('panels: only differences from the frozen layout are written', () => {
  const defaults = {
    specs: SHARE_VIEW_PANELS.map((p) => ({
      id: p.id,
      collapsed: p.collapsed,
      pinned: p.pinnable ? false : null,
    })),
  };
  const base = payloadBytes(encodeShareView({})).length;
  assert.equal(
    payloadBytes(assertRoundTrip({ panelState: defaults })).length,
    base + 2,
  );
  const oneChanged = structuredClone(defaults);
  oneChanged.specs[3].collapsed = false;
  assert.equal(
    payloadBytes(assertRoundTrip({ panelState: oneChanged })).length,
    base + 3,
  );
  // A partial panel list (an older link) keeps its gaps as "no opinion".
  const partial = {
    specs: [{ id: 'cctv-panel', collapsed: false, pinned: null }],
  };
  assert.deepEqual(
    decodeOk(encodeShareView({ panelState: partial })).state.panelState,
    partial,
  );
});

test('a place view opens at its camera; a thing view also names what to follow', () => {
  const place = decodeOk(encodeShareView({ lat: 1, lon: 2 })).state;
  assert.deepEqual(place.view, { kind: 'place' });
  for (const entry of SHARE_VIEW_ENTITY_KINDS) {
    const id = entry.idForm === 'hex24' ? '3c6444' : '25544';
    const { state } = decodeOk(
      encodeShareView({
        lat: 1,
        lon: 2,
        view: { kind: 'thing', entity: { kind: entry.kind, id } },
      }),
    );
    assert.deepEqual(state.view, {
      kind: 'thing',
      entity: { kind: entry.kind, id },
      offset: null,
      lastKnown: null,
    });
  }
});

test('thing ids use the compact numeric form when they can, text otherwise', () => {
  const size = (kind, id) =>
    payloadBytes(
      encodeShareView({ view: { kind: 'thing', entity: { kind, id } } }),
    ).length;
  assert.equal(size('aircraft', 'ffffff'), size('aircraft', '000001') + 3);
  assert.ok(size('aircraft', '~abc123') > size('aircraft', 'abc123'));
  assert.ok(
    size('vessel', '366999712') < size('vessel', '002442000'),
    'leading zeros keep the text form',
  );
  for (const [kind, id] of [
    ['aircraft', '000000'],
    ['vessel', '002442000'],
    ['military_aircraft', 'adsb_x-1'],
    ['satellite', '1'],
  ])
    assert.equal(
      decodeOk(
        encodeShareView({ view: { kind: 'thing', entity: { kind, id } } }),
      ).state.view.entity.id,
      id,
    );
  // Invalid ids and kinds normalize to a place view.
  for (const entity of [
    { kind: 'aircraft', id: 'NOT VALID' },
    { kind: 'satellite', id: 'abc' },
    { kind: 'ufo', id: '1' },
  ])
    assert.deepEqual(
      normalizeShareViewState({ view: { kind: 'thing', entity } }).view,
      { kind: 'place' },
    );
  assert.equal(
    normalizeShareViewState({
      view: { kind: 'thing', entity: { kind: 'aircraft', id: 'ABC123' } },
    }).view.entity.id,
    'abc123',
  );
});

test('last-known time is stored relative to the created-at time when there is one', () => {
  const lastKnown = {
    lat: 10.0012,
    lon: 20.0034,
    alt: 11000,
    observedAtMs: NOW_MS - 15_000,
  };
  const view = {
    kind: 'thing',
    entity: { kind: 'aircraft', id: 'a1b2c3' },
    lastKnown,
  };
  const withCreated = assertRoundTrip({
    lat: 10,
    lon: 20,
    sharedAtMs: NOW_MS,
    view,
  });
  const withoutCreated = assertRoundTrip({ lat: 10, lon: 20, view });
  assert.deepEqual(decodeOk(withoutCreated).state.view.lastKnown, lastKnown);
  // Relative age (15 s) is 1 byte; the absolute time is 4.
  assert.ok(
    payloadBytes(withCreated).length - 5 < payloadBytes(withoutCreated).length,
  );
});

test('tracking selections in layer options become a thing view', () => {
  const layerState = createDefaultLayerState();
  layerState.enabledLayerIds = ['military'];
  layerState.options.flights.selectedMilitaryTrackingId = 'AE1234';
  const state = normalizeShareViewState({ layerState });
  assert.deepEqual(state.view, {
    kind: 'thing',
    entity: { kind: 'military_aircraft', id: 'ae1234' },
    offset: null,
    lastKnown: null,
  });
  assert.equal(
    state.layerState.options.flights.selectedMilitaryTrackingId,
    null,
  );
  assertRoundTrip({ layerState });
});

test('a created-at time in the future is dropped, like the long form’s `at`', () => {
  const hash = encodeShareView({ sharedAtMs: NOW_MS + 60_000 });
  assert.equal(decode(hash).state.sharedAtMs, null);
  assert.equal(
    decodeShareView(hash, { nowMs: NOW_MS + 60_000 }).state.sharedAtMs,
    NOW_MS + 60_000,
  );
  // Times on either side of the format epoch survive.
  for (const ms of [1000, (SHARE_VIEW_EPOCH_S - 86400) * 1000, NOW_MS])
    assert.equal(
      decode(encodeShareView({ sharedAtMs: ms })).state.sharedAtMs,
      ms,
    );
});

test('hash forms: `#s=`, `s=` and the bare payload decode the same', () => {
  const hash = encodeShareView({ lat: 51.5, lon: -0.12 });
  const payload = hash.slice(2);
  for (const form of [hash, `#${hash}`, payload, `#${hash}&lang=fr`])
    assert.deepEqual(decodeOk(form).state, decodeOk(hash).state, form);
  assert.equal(isShareViewHash(`#${hash}`), true);
  assert.equal(isShareViewHash('#v=2&lat=1&lon=2'), false);
  assert.equal(isShareViewHash('#lat=1&lon=2&s=AQ'), true);
  assert.equal(decode('#v=2&lat=1&lon=2').reason, 'not-a-share-view');
  assert.equal(decode(`#${hash}&s=AQ`).reason, 'not-a-share-view');
});

/* ---------------- forward compatibility ---------------- */

/** Append raw fields to an encoded hash, as a newer encoder would. */
function withExtraFields(hash, write) {
  const writer = new WireWriter();
  writer.bytes.push(...payloadBytes(hash));
  write(writer);
  return hashOf(writer.finish());
}

test('unknown top-level fields of every wire type are skipped and reported', () => {
  const state = {
    lat: 48.8584,
    lon: 2.2945,
    style: 'noir',
    layerState: { enabledLayerIds: ['flights'] },
  };
  const hash = encodeShareView(state);
  const future = withExtraFields(hash, (w) => {
    w.uintField(40, 123456);
    w.bytesField(41, [9, 9, 9, 0xff, 0]);
    w.tag(42, WIRE_FIXED32).bytes.push(1, 2, 3, 4);
    w.tag(43, WIRE_FIXED64).bytes.push(1, 2, 3, 4, 5, 6, 7, 8);
    w.sintField(2000, -5);
  });
  const result = decodeOk(future);
  assert.deepEqual(result.state, decodeOk(hash).state);
  assert.deepEqual(
    result.unknownFields.map((u) => [u.scope, u.field, u.wireType]),
    [
      ['view', 40, 0],
      ['view', 41, 2],
      ['view', 42, 5],
      ['view', 43, 1],
      ['view', 2000, 0],
    ],
  );
});

test('unknown fields inside a thing view, codes and bits are skipped too', () => {
  const thing = new WireWriter();
  thing.uintField(1, 1).uintField(2, 0xa1b2c3);
  const offset = new WireWriter().uintField(1, 900).uintField(7, 1);
  thing.bytesField(3, offset.finish());
  thing.textField(9, 'cockpit'); // a future thing field
  const writer = new WireWriter();
  writer.bytes.push(1);
  writer.uintField(1, 1).sintField(2, 100000).uintField(9, 0b100001); // flag bit 5 unknown
  writer.bytesField(
    10,
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  ); // layer 160
  writer.bytesField(12, new WireWriter().varint(11 * 16 + 4 + 1).finish()); // panel 11
  writer.uintField(14, 99); // style code 99
  writer.bytesField(13, thing.finish());
  const result = decodeOk(hashOf(writer.finish()));
  assert.deepEqual(result.state.view, {
    kind: 'thing',
    entity: { kind: 'aircraft', id: 'a1b2c3' },
    offset: { range: 900, heading: 0, pitch: -35 },
    lastKnown: null,
  });
  assert.equal(result.state.bloom, true);
  assert.equal(result.state.style, 'normal');
  assert.deepEqual(result.state.layerState.enabledLayerIds, []);
  assert.deepEqual(
    result.unknownFields.map((u) => [u.scope, u.field ?? u.code]),
    [
      ['enum:style', 99],
      ['flags', 32],
      ['layer', 160],
      ['panel', 11],
      ['thing', 9],
      ['thing.offset', 7],
    ],
  );
});

test('an unknown view kind or entity kind falls back to the stored camera', () => {
  const camera = {
    lat: 35.6762,
    lon: 139.6503,
    alt: 2500,
    heading: 45,
    pitch: -20,
  };
  const base = payloadBytes(encodeShareView(camera));
  const expected = decodeOk(encodeShareView(camera)).state;

  const futureKind = new WireWriter();
  futureKind.bytes.push(...base);
  futureKind.uintField(1, 7);
  futureKind.bytesField(60, [1, 2, 3]);
  const kindResult = decodeOk(hashOf(futureKind.finish()));
  assert.deepEqual(kindResult.state, expected);
  assert.equal(kindResult.fallback, 'unknown-view-kind');

  const futureEntity = new WireWriter();
  futureEntity.bytes.push(...base);
  futureEntity.uintField(1, 1);
  futureEntity.bytesField(
    13,
    new WireWriter().uintField(1, 12).textField(2, 'cam-77').finish(),
  );
  const entityResult = decodeOk(hashOf(futureEntity.finish()));
  assert.deepEqual(entityResult.state, expected);
  assert.equal(entityResult.fallback, 'unknown-entity-kind');
  assert.deepEqual(entityResult.unknownFields, [
    { scope: 'entity-kind', code: 12 },
  ]);

  const missing = new WireWriter();
  missing.bytes.push(...base);
  missing.uintField(1, 1);
  assert.equal(decodeOk(hashOf(missing.finish())).fallback, 'missing-thing');

  const badId = new WireWriter();
  badId.bytes.push(...base);
  badId
    .uintField(1, 1)
    .bytesField(
      13,
      new WireWriter().uintField(1, 1).uintField(2, 0x1000000).finish(),
    );
  assert.equal(decodeOk(hashOf(badId.finish())).fallback, 'invalid-entity-id');
});

test('enum names outside the code tables travel as text', () => {
  const hash = encodeShareView({
    hudVariant: 'future-hud',
    mapStack: 'future-map',
  });
  const { state, unknownFields } = decodeOk(hash);
  assert.equal(state.hudVariant, 'future-hud');
  assert.equal(state.mapStack, 'future-map');
  assert.equal(unknownFields, undefined);
  const style = new WireWriter();
  style.bytes.push(1);
  style.textField(14, 'thermal');
  assert.equal(decodeOk(hashOf(style.finish())).state.style, 'thermal');
  const unknownStyle = new WireWriter();
  unknownStyle.bytes.push(1);
  unknownStyle.textField(14, 'sepia');
  const result = decodeOk(hashOf(unknownStyle.finish()));
  assert.equal(result.state.style, 'normal');
  assert.deepEqual(result.unknownFields, [
    { scope: 'enum:style', code: 'sepia' },
  ]);
});

/* ---------------- integrity ---------------- */

test('malformed input is rejected with a reason, never thrown', () => {
  const good = payloadBytes(
    encodeShareView({
      lat: 10,
      lon: 20,
      layerState: { enabledLayerIds: ['flights'] },
    }),
  );
  const cases = {
    'not-a-string': [null, undefined, 42, {}],
    'too-long': [
      'A'.repeat(MAX_SHARE_VIEW_CHARS + 1),
      `s=${'A'.repeat(MAX_SHARE_VIEW_CHARS + 1)}`,
    ],
    'bad-base64': ['s=AQ==', 's=A*Q', 'AQAAA'],
    empty: ['s=', '#s='],
    'unsupported-version': [hashOf([0]), hashOf([2, 8, 1])],
    truncated: [
      hashOf(good.slice(0, good.length - 1)),
      hashOf([1, 0x10]), // field 2 varint with no value
      hashOf([1, 0x52, 0x7f, 1]), // field 10 claims 127 bytes
      hashOf([1, 0x52, 0xff, 0xff, 0xff, 0x7f]), // absurd length
    ],
    'varint-overflow': [
      hashOf([1, 0x10, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]),
    ],
    'non-canonical-varint': [hashOf([1, 0x10, 0x82, 0x00])],
    'bad-wire-type': [hashOf([1, 0x13]), hashOf([1, 0x16])],
    'bad-field-number': [hashOf([1, 0x00])],
    'wire-type-mismatch': [
      hashOf([1, 0x12, 0x01, 0x00]),
      hashOf([1, 0x50, 0x01]),
    ],
    'duplicate-field': [hashOf([1, 0x10, 0x02, 0x10, 0x04])],
    'duplicate-entry': [hashOf([1, 0x62, 0x02, 0x31, 0x31])],
    'out-of-range': [
      hashOf([1, ...new WireWriter().sintField(2, 900001).finish()]),
    ],
    'bad-text': [
      hashOf([1, ...new WireWriter().bytesField(14, [0xc3, 0xa9]).finish()]),
    ],
  };
  for (const [reason, inputs] of Object.entries(cases)) {
    for (const input of inputs) {
      const result = decodeShareView(input, { nowMs: NOW_MS });
      assert.deepEqual(
        result,
        { ok: false, reason },
        `${reason}: ${String(input).slice(0, 40)}`,
      );
    }
  }
});

test('every truncation and single-byte corruption of real payloads is handled', () => {
  const random = rng(7);
  for (let i = 0; i < 60; i += 1) {
    const bytes = payloadBytes(encodeShareView(randomState(random)));
    for (let cut = 1; cut < bytes.length; cut += 1) {
      const result = decode(hashOf(bytes.slice(0, cut)));
      assert.equal(typeof result.ok, 'boolean');
    }
    for (let j = 0; j < 40; j += 1) {
      const corrupt = Uint8Array.from(bytes);
      corrupt[1 + Math.floor(random() * (corrupt.length - 1))] = Math.floor(
        random() * 256,
      );
      const result = decode(hashOf(corrupt));
      assert.equal(typeof result.ok, 'boolean');
      if (result.ok)
        assert.deepEqual(normalizeShareViewState(result.state), result.state);
    }
  }
});

/* ---------------- sizes ---------------- */

test('size: a camera-only place view', () => {
  const hash = assertRoundTrip({
    lat: 48.8584,
    lon: 2.2945,
    alt: 1200,
    heading: 120,
    pitch: -25,
  });
  assert.equal(hash.length, 25);
  const copied = assertRoundTrip({
    lat: 48.8584,
    lon: 2.2945,
    alt: 1200,
    heading: 120,
    pitch: -25,
    sharedAtMs: NOW_MS,
  });
  assert.equal(copied.length, 32);
});

test('size: following an aircraft', () => {
  const layerState = createDefaultLayerState();
  layerState.enabledLayerIds = ['flights'];
  layerState.options.flights.models3d = true;
  const hash = assertRoundTrip({
    view: {
      kind: 'thing',
      entity: { kind: 'aircraft', id: 'a1b2c3' },
      offset: { range: 1500, heading: 30, pitch: -20 },
      lastKnown: {
        lat: 37.6213,
        lon: -122.379,
        alt: 3200,
        observedAtMs: NOW_MS - 4000,
      },
    },
    lat: 37.6102,
    lon: -122.3901,
    alt: 3900,
    heading: 30,
    pitch: -20,
    layerState,
    sharedAtMs: NOW_MS,
  });
  assert.equal(hash.length, 76);
});
