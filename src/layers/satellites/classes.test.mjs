import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SATELLITE_CLASSES,
  PRESUMED_DEAD_AFTER_YEARS,
  SATELLITE_CLASS_DISPLAY,
  SATELLITE_CLASS_IDS,
  classifySatellite,
  mergeClassVisibility,
  parseSatcatCsv,
} from './classes.js';
import { CATALOG_GROUPS } from './policy.js';

const NOW = 2026;
const classify = (subject) => classifySatellite({ nowYear: NOW, ...subject });

test('six classes, every one but Starlink on by default', () => {
  assert.deepEqual(SATELLITE_CLASS_IDS, [
    'stations',
    'imaging',
    'telecom',
    'starlink',
    'probes',
    'debris',
  ]);
  assert.deepEqual(
    SATELLITE_CLASS_IDS.filter((id) => DEFAULT_SATELLITE_CLASSES[id]),
    ['stations', 'imaging', 'telecom', 'probes', 'debris'],
  );
  for (const id of SATELLITE_CLASS_IDS) {
    const display = SATELLITE_CLASS_DISPLAY[id];
    assert.match(display.color, /^#[0-9a-f]{6}$/, id);
    assert.ok(display.label && display.blurb, id);
  }
});

test('SATCAT object type and status file debris first, overruling UCS', () => {
  const imaging = { purpose: 'Earth Observation' };
  for (const objectType of ['R/B', 'DEB', 'UNK'])
    assert.equal(
      classify({ name: 'X', satcat: { objectType, opsStatus: '' } }),
      'debris',
      objectType,
    );
  // A satellite UCS listed in 2023 that SATCAT now calls dead or decayed.
  for (const opsStatus of ['-', 'D'])
    assert.equal(
      classify({
        name: 'OLDSAT',
        ucs: imaging,
        satcat: { objectType: 'PAY', opsStatus },
      }),
      'debris',
      opsStatus,
    );
  assert.equal(
    classify({
      name: 'OLDSAT',
      ucs: imaging,
      satcat: { objectType: 'PAY', opsStatus: '+' },
    }),
    'imaging',
  );
  // SATCAT calls a new launch's objects UNK until it names them: only an
  // old unknown object, or one with no launch date, is debris.
  assert.equal(
    classify({
      name: 'OBJECT C',
      group: 'resource',
      satcat: { objectType: 'UNK', opsStatus: '', launchDate: '2025-11-02' },
    }),
    'imaging',
  );
  assert.equal(
    classify({
      name: 'OBJECT C',
      group: 'resource',
      satcat: { objectType: 'UNK', opsStatus: '', launchDate: '2019-04-01' },
    }),
    'debris',
  );
  // Debris riding in the stations group (CelesTrak lists FREGAT DEB there).
  assert.equal(classify({ name: 'FREGAT DEB', group: 'stations' }), 'debris');
  assert.equal(classify({ name: 'SL-16 R/B', group: 'visual' }), 'debris');
});

test('the ISS is a station whatever else says', () => {
  assert.equal(
    classify({
      noradId: 25544,
      name: 'ISS (ZARYA)',
      group: 'visual',
      satcat: { objectType: 'DEB' },
    }),
    'stations',
  );
});

test('stations: crewed stations and visiting vehicles by name', () => {
  assert.equal(
    classify({ name: 'CSS (TIANHE)', group: 'stations' }),
    'stations',
  );
  assert.equal(
    classify({ name: 'ISS (NAUKA)', group: 'stations' }),
    'stations',
  );
  for (const name of [
    'SHENZHOU-21',
    'TIANZHOU-9',
    'SOYUZ-MS 28',
    'PROGRESS-MS 31',
    'CREW DRAGON 11',
    'CYGNUS NG-23',
  ])
    assert.equal(classify({ name, group: 'visual' }), 'stations', name);
});

test('UCS purpose decides imaging, telecom and probes', () => {
  const table = [
    ['Earth Observation', 'imaging'],
    ['Earth Science', 'imaging'],
    ['Meteorological', 'imaging'],
    ['Surveillance', 'imaging'],
    ['Earth Observation/Navigation', 'imaging'],
    ['Earth/Space Observation', 'imaging'],
    ['Communications', 'telecom'],
    ['Navigation/Global Positioning', 'telecom'],
    ['Navigation/Regional Positioning', 'telecom'],
    ['Technology Development', 'probes'],
    ['Technology Demonstration', 'probes'],
    ['Space Science', 'probes'],
    ['Unknown', 'probes'],
  ];
  for (const [purpose, expected] of table)
    assert.equal(
      classify({ name: 'UNNAMED-1', group: 'visual', ucs: { purpose } }),
      expected,
      purpose,
    );
});

test('satellites launched after the UCS snapshot are classed by name', () => {
  const table = [
    ['ICEYE-X50', 'imaging'],
    ['CAPELLA-17', 'imaging'],
    ['FLOCK 4Y-12', 'imaging'],
    ['PELICAN-3', 'imaging'],
    ['SENTINEL-1C', 'imaging'],
    ['LANDSAT 9', 'imaging'],
    ['GOES 19', 'imaging'],
    ['ONEWEB-0712', 'telecom'],
    ['IRIDIUM 180', 'telecom'],
    ['GPS BIII-8  (PRN 14)', 'telecom'],
    ['KUIPER-00042', 'telecom'],
    ['STARLINK-34012', 'starlink'],
  ];
  for (const [name, expected] of table)
    assert.equal(
      classify({ name, group: 'visual', launchYear: 2025 }),
      expected,
      name,
    );
});

test('the group the TLE came in is the last resort', () => {
  assert.equal(
    classify({ name: 'UNNAMED-1', group: 'resource', launchYear: 2024 }),
    'imaging',
  );
  assert.equal(
    classify({ name: 'UNNAMED-1', group: 'geo', launchYear: 2024 }),
    'telecom',
  );
  assert.equal(
    classify({ name: 'UNNAMED-1', group: 'science', launchYear: 2024 }),
    'probes',
  );
  assert.equal(classify({ name: 'STARLINK-1', group: 'dense' }), 'starlink');
  assert.equal(
    classify({ name: 'UNNAMED-1', group: 'visual', launchYear: 2024 }),
    'probes',
  );
});

test('CubeSats deployed from the ISS are not stations', () => {
  // They ride in CelesTrak's stations group under the ISS's 1998 designator.
  for (const name of [
    'DUPLEX',
    'KNACKSAT-2',
    'GXIBA-1',
    'LEOPARD',
    'HMU-SAT2',
  ]) {
    assert.equal(
      classify({ name, group: 'stations', launchYear: 1998 }),
      'probes',
      `${name} without SATCAT`,
    );
    assert.equal(
      classify({
        name,
        group: 'stations',
        launchYear: 1998,
        satcat: { objectType: 'PAY', opsStatus: '', launchDate: '2025-04-21' },
      }),
      'probes',
      `${name}: SATCAT's 2025 launch, not the designator's 1998`,
    );
  }
  assert.equal(
    classify({
      name: 'UNNAMED-1',
      group: 'stations',
      ucs: { purpose: 'Earth Observation' },
    }),
    'imaging',
  );
});

test('an unknown old payload is presumed dead; a recognisable one is not', () => {
  const old = NOW - PRESUMED_DEAD_AFTER_YEARS;
  assert.equal(
    classify({ name: 'ATLAS CENTAUR 2', group: 'visual', launchYear: 1963 }),
    'probes',
    'without a SATCAT record (a failed read) nothing is presumed',
  );
  assert.equal(
    classify({
      name: 'ATLAS CENTAUR 2',
      group: 'visual',
      launchYear: 1963,
      satcat: { objectType: 'PAY', opsStatus: '' },
    }),
    'debris',
    'a blank SATCAT status is no evidence of life',
  );
  assert.equal(
    classify({ name: 'UNNAMED-1', group: 'visual', launchYear: old + 1 }),
    'probes',
  );
  assert.equal(
    classify({ name: 'NOAA 15', group: 'weather', launchYear: 1998 }),
    'imaging',
  );
  assert.equal(
    classify({
      name: 'UNNAMED-1',
      group: 'visual',
      launchYear: 1990,
      satcat: { objectType: 'PAY', opsStatus: '+' },
    }),
    'probes',
    'SATCAT says it works',
  );
});

test('class visibility merges booleans and ignores everything else', () => {
  const next = mergeClassVisibility({
    telecom: true,
    imaging: false,
    debris: 'yes',
    bogus: true,
  });
  assert.deepEqual(next, {
    ...DEFAULT_SATELLITE_CLASSES,
    telecom: true,
    imaging: false,
  });
  assert.deepEqual(mergeClassVisibility(null), {
    ...DEFAULT_SATELLITE_CLASSES,
  });
  assert.equal(Object.hasOwn(next, 'bogus'), false);
});

test('SATCAT CSV parses, quoted commas included, keyed by NORAD id', () => {
  const csv = [
    'OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER,LAUNCH_DATE',
    'ISS (ZARYA),1998-067A,25544,PAY,+,ISS,1998-11-20',
    '"THOR AGENA, D R/B",1964-002A,733,r/b,,US,1964-01-19',
    'BROKEN,,notanumber,PAY,+,US,',
    '',
  ].join('\r\n');
  const records = parseSatcatCsv(csv);
  assert.deepEqual([...records.keys()], [25544, 733]);
  assert.deepEqual(records.get(25544), {
    objectType: 'PAY',
    opsStatus: '+',
    launchDate: '1998-11-20',
  });
  assert.equal(records.get(733).objectType, 'R/B');
  assert.equal(parseSatcatCsv('<html>busy</html>').size, 0);
  assert.equal(parseSatcatCsv('').size, 0);
});

test('turning Stations off takes the ISS ring and label with its point', async () => {
  const { createControls } = await import('./controls.js');
  let overlaySyncs = 0;
  const ring = { primitive: { show: true } };
  const state = {
    _enabled: true,
    _params: {
      catalog: 'core',
      showOrbits: true,
      classes: { ...DEFAULT_SATELLITE_CLASSES, stations: false },
    },
    _catalog: new Map([[25544, { satelliteClass: 'stations' }]]),
    _points: new Map([[25544, { show: true }]]),
    _orbitPaths: new Map([[25544, ring]]),
    _detectionObjects: new Map(),
    _trackedNorad: null,
  };
  const controls = createControls({
    state,
    services: { layerState: { isExplicitLayerStateOrigin: () => false } },
    parts: { labels: { _syncIssOverlay: () => (overlaySyncs += 1) } },
    source: {},
  });
  controls._applyClassVisibility();
  assert.equal(state._points.get(25544).show, false);
  assert.equal(ring.primitive.show, false, 'the ring goes with the class');
  assert.ok(overlaySyncs >= 1, 'the label is re-synced');
  state._params.classes = { ...DEFAULT_SATELLITE_CLASSES };
  controls._applyClassVisibility();
  assert.equal(ring.primitive.show, true, 'and comes back with it');
});

test('a failed Starlink load hides the core catalog Starlink points again', async () => {
  const { createCatalog } = await import('./catalog.js');
  let applied = 0;
  const state = {
    _params: {
      catalog: 'dense',
      classes: { ...DEFAULT_SATELLITE_CLASSES, starlink: true },
    },
    _denseLoadToken: 3,
    _denseIds: [],
    _catalog: new Map(),
    _points: new Map(),
    _detectionObjects: new Map(),
    _trackedNorad: null,
    _activeUpdateControllers: new Set(),
  };
  const catalog = createCatalog({
    state,
    services: {},
    parts: {
      controls: {
        _applyClassVisibility: () => (applied += 1),
        _notifyRowControls() {},
      },
      labels: { _syncIssOverlay() {} },
    },
    source: {},
  });
  catalog._denseLoadFailed(state._denseLoadToken, 'feed unreachable');
  assert.equal(state._params.catalog, 'core');
  assert.equal(state._params.classes.starlink, false, 'the choice says so');
  assert.ok(applied >= 1, 'class visibility is applied again');
});

test('every ingested group names the class its unnamed members fall back to', () => {
  // A group added to CATALOG_GROUPS without a class would file its members
  // under PROBES, the catch-all.
  const expected = {
    stations: 'probes',
    visual: 'probes',
    'gps-ops': 'telecom',
    glonass: 'telecom',
    galileo: 'telecom',
    geo: 'telecom',
    resource: 'imaging',
    weather: 'imaging',
    planet: 'imaging',
    sar: 'imaging',
    science: 'probes',
  };
  assert.deepEqual(
    Object.fromEntries(
      CATALOG_GROUPS.map(({ tag }) => [
        tag,
        classify({ noradId: 99999, name: 'UNNAMED-1', group: tag }),
      ]),
    ),
    expected,
  );
});

test('enabling the layer leaves a hidden Stations class without its ISS ring', async () => {
  const { createLifecycle } = await import('./lifecycle.js');
  const iss = { primitive: { show: false } };
  const other = { primitive: { show: false } };
  let issVisible = false;
  const state = {
    _params: { showPoints: true, showOrbits: true },
    _orbitPaths: new Map([
      [25544, iss],
      [90001, other],
    ]),
    _points: new Map(),
  };
  const { methods } = createLifecycle({
    state,
    services: {
      focus: { clearFocusTarget() {} },
      render: { holdContinuousRender() {}, releaseContinuousRender() {} },
      picking: { registerPickOwner() {}, unregisterPickOwner() {} },
    },
    parts: {
      controls: {
        satelliteVisualsVisible: (enabled, on) => enabled && on !== false,
        _issOrbitVisible: () => issVisible,
      },
      labels: { _syncIssOverlay() {} },
      interaction: { _installClickHandler() {} },
      tracking: { _applyPendingTrackingRestore() {} },
      rendering: {},
    },
  });
  methods.enable(null);
  assert.equal(iss.primitive.show, false, 'the ISS ring follows its class');
  assert.equal(other.primitive.show, true, 'other rings follow showOrbits');
  issVisible = true;
  methods.enable(null);
  assert.equal(iss.primitive.show, true);
});

test('a mission group outranks an orbit group, and an Unknown UCS purpose is no evidence', () => {
  assert.equal(
    classify({ name: 'MTG-X1', group: 'geo', groups: ['geo', 'weather'] }),
    'imaging',
  );
  assert.equal(
    classify({ name: 'UNNAMED-1', group: 'geo', groups: ['geo'] }),
    'telecom',
  );
  assert.equal(
    classify({
      name: 'GPS BIII-9',
      group: 'visual',
      ucs: { purpose: 'Unknown' },
    }),
    'telecom',
  );
  assert.equal(
    classify({
      name: 'UNNAMED-1',
      group: 'resource',
      ucs: { purpose: 'Unknown' },
    }),
    'imaging',
  );
});

test('a tracked ISS keeps its ring while Stations is hidden', async () => {
  const { createControls } = await import('./controls.js');
  const ring = { primitive: { show: true } };
  const state = {
    _enabled: true,
    _params: {
      catalog: 'core',
      showOrbits: true,
      classes: { ...DEFAULT_SATELLITE_CLASSES, stations: false },
    },
    _catalog: new Map([[25544, { satelliteClass: 'stations' }]]),
    _points: new Map([[25544, { show: true }]]),
    _orbitPaths: new Map([[25544, ring]]),
    _detectionObjects: new Map(),
    _trackedNorad: null,
  };
  const controls = createControls({
    state,
    services: { layerState: { isExplicitLayerStateOrigin: () => false } },
    parts: { labels: { _syncIssOverlay() {} } },
    source: {},
  });
  controls._syncIssOrbit();
  assert.equal(ring.primitive.show, false);
  state._trackedNorad = 25544;
  controls._syncIssOrbit();
  assert.equal(ring.primitive.show, true, 'tracked, it keeps its ring');
  state._params.showOrbits = false;
  controls._syncIssOrbit();
  assert.equal(ring.primitive.show, false, 'orbits off still hides it');
});
