import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import { getWorldPacket } from './worldPacket.js';
import { createGevActionRunner } from '../voice/gevActions.js';

function withoutVoicePresentation(result) {
  const packet = { ...result };
  delete packet.say;
  delete packet.display;
  delete packet.schedule;
  return packet;
}

function harness() {
  const position = Cesium.Cartesian3.fromDegrees(-97.74, 30.26, 500);
  const viewer = {
    trackedEntity: undefined,
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: {
      canvas: {
        clientWidth: 1200,
        clientHeight: 800,
        addEventListener() {},
        removeEventListener() {},
      },
      globe: { getHeight: () => 0 },
      tweens: [],
    },
    camera: {
      positionWC: position,
      positionCartographic: Cesium.Cartographic.fromCartesian(position),
      heading: 0,
      pitch: Cesium.Math.toRadians(-45),
      moveEnd: { addEventListener: () => () => {} },
      cancelFlight() {},
      lookAtTransform() {},
    },
  };
  const rows = [
    {
      id: 'traffic',
      name: 'Traffic',
      enabled: true,
      stats: {
        count: 3,
        source: 'fixture',
        lastUpdate: null,
      },
    },
  ];
  const dataManager = {
    layers: new Map([['traffic', { module: null }]]),
    getAll: () => rows,
  };
  const styleManager = {
    activeStyle: 'normal',
    getContextModeState: () => ({ mode: 'flights' }),
    getCockpitState: () => null,
    getControlState: () => ({ hud: { visible: 'auto' } }),
  };
  return { viewer, dataManager, styleManager };
}

test('World Packet preserves get_current_view_state parity', async () => {
  const { viewer, dataManager, styleManager } = harness();
  const packet = getWorldPacket({ viewer, dataManager, styleManager });
  const runner = createGevActionRunner({ viewer, dataManager, styleManager });
  const voice = await runner('get_current_view_state');

  assert.deepEqual(withoutVoicePresentation(voice), packet);
  assert.equal(packet.context.mode, 'contacts');
  assert.equal(packet.context.modeInternal, 'flights');
  assert.equal(packet.layers[0].feedState, 'nominal');
  assert.equal(packet.feedProvenance.overall, 'nominal');
});

test('World Packet keeps stale/unavailable feed semantics distinct from empty', () => {
  const { viewer, dataManager, styleManager } = harness();
  dataManager.getAll = () => [
    {
      id: 'traffic',
      name: 'Traffic',
      enabled: true,
      stats: {
        count: 0,
        source: 'fixture',
        error: 'fixture unavailable',
        lastUpdate: null,
      },
    },
  ];

  const packet = getWorldPacket({ viewer, dataManager, styleManager });
  assert.equal(packet.layers[0].count, 0);
  assert.notEqual(packet.layers[0].feedState, 'nominal');
  assert.notEqual(packet.feedProvenance.overall, 'nominal');
  assert.match(packet.feedProvenance.note, /fixture unavailable/i);
});

// The 2026-10 main voice contract omits disabled layers from the model payload.
test('World Packet and voice preserve enabled-only payload and count disabled layers', async () => {
  const { viewer, dataManager, styleManager } = harness();
  const rows = dataManager.getAll();
  rows.push({
    id: 'earthquakes',
    name: 'Earthquakes',
    enabled: false,
    stats: { count: 99, source: 'fixture', error: 'stale' },
  });
  let reads = 0;
  dataManager.getAll = () => {
    reads += 1;
    return rows;
  };
  const packet = getWorldPacket({ viewer, dataManager, styleManager });
  assert.equal(reads, 1, 'collect the roster once rather than repeatedly');
  assert.equal(packet.disabledLayerCount, 1);
  assert.deepEqual(
    packet.layers.map((layer) => layer.id),
    ['traffic'],
  );
  assert.equal(packet.feedProvenance.overall, 'nominal');

  const runner = createGevActionRunner({ viewer, dataManager, styleManager });
  const voice = await runner('get_current_view_state');
  assert.deepEqual(withoutVoicePresentation(voice), packet);
});

const PINNED_NOW = Date.UTC(2026, 9, 17, 12, 0, 0);

// Exercises every packet field: context vocabulary and Contacts window,
// cockpit, controls, scene playback, tracked families (one not ready),
// enabled and disabled layers, and an aged and an unavailable feed.
function pinnedHarness() {
  const { viewer } = harness();
  const rows = [
    {
      id: 'flights',
      name: 'Flights',
      enabled: true,
      stats: {
        count: 12,
        source: 'fixture-adsb',
        lastUpdate: PINNED_NOW - 90_000,
      },
    },
    {
      id: 'traffic',
      name: 'Traffic',
      enabled: true,
      stats: {
        count: 0,
        source: 'fixture',
        error: 'fixture unavailable',
        lastUpdate: null,
      },
    },
    {
      id: 'earthquakes',
      name: 'Earthquakes',
      enabled: false,
      stats: { count: 99, source: 'fixture', error: 'stale' },
    },
  ];
  const module = (methods) => ({ module: methods });
  const dataManager = {
    layers: new Map([
      [
        'flights',
        module({
          getTrackedInfo: () => ({ icao24: 'abc123', callsign: 'TEST1' }),
        }),
      ],
      [
        'ais-live-vessels',
        module({ getSelectedInfo: () => ({ mmsi: '366000001' }) }),
      ],
      [
        'satellites',
        module({
          getTrackedInfo: () => {
            throw new Error('not ready');
          },
        }),
      ],
      [
        'military-awareness',
        module({
          getContextSnapshot: () => ({ snapshot: true }),
          contactsWindowFromSnapshot: (snapshot) =>
            snapshot ? { windowMin: 30, count: 4 } : null,
        }),
      ],
    ]),
    getAll: () => rows,
  };
  const styleManager = {
    activeStyle: 'night-vision',
    getContextModeState: () => ({
      mode: 'flights',
      entering: null,
      priorMode: null,
    }),
    getCockpitState: () => ({ active: false }),
    getControlState: () => ({ hud: { visible: 'auto' } }),
  };
  const sceneDirector = {
    getPlaybackStatus: () => ({ playing: false, sceneId: 'fixture' }),
  };
  return { viewer, dataManager, styleManager, sceneDirector };
}

// Captured from main's get_current_view_state before the extraction
// (bilawalsidhu/gods-eye-view@3d8e1ef0) with Date.now pinned to PINNED_NOW,
// minus the speech envelope. Key order is part of the contract.
const PRE_EXTRACTION_PAYLOAD = {
  ok: true,
  action: 'get_current_view_state',
  camera: {
    latitude: 30.259999999999994,
    longitude: -97.74,
    heightM: 499.99999999901877,
  },
  style: 'night-vision',
  context: {
    mode: 'contacts',
    entering: null,
    priorMode: null,
    modeInternal: 'flights',
    enteringInternal: null,
    priorModeInternal: null,
    contactsWindow: { windowMin: 30, count: 4 },
  },
  cockpit: { active: false },
  controls: { hud: { visible: 'auto' } },
  scenePlayback: { playing: false, sceneId: 'fixture' },
  tracked: [
    {
      kind: 'aircraft',
      layerId: 'flights',
      icao24: 'abc123',
      callsign: 'TEST1',
    },
    { kind: 'vessel', layerId: 'ais-live-vessels', mmsi: '366000001' },
  ],
  disabledLayerCount: 1,
  layers: [
    {
      id: 'flights',
      name: 'Flights',
      enabled: true,
      count: 12,
      error: null,
      feedState: 'nominal',
      source: 'fixture-adsb',
      lastUpdate: 1792238310000,
    },
    {
      id: 'traffic',
      name: 'Traffic',
      enabled: true,
      count: 0,
      error: 'fixture unavailable',
      feedState: 'unavailable',
      source: 'fixture',
      lastUpdate: 0,
    },
  ],
  feedProvenance: {
    overall: 'unavailable',
    layers: [
      {
        id: 'flights',
        name: 'Flights',
        enabled: true,
        feedState: 'nominal',
        source: 'fixture-adsb',
        count: 12,
        lastUpdate: 1792238310000,
        ageSec: 90,
        ageLabel: '1m ago',
        error: null,
      },
      {
        id: 'traffic',
        name: 'Traffic',
        enabled: true,
        feedState: 'unavailable',
        source: 'fixture',
        count: 0,
        lastUpdate: 0,
        ageSec: null,
        ageLabel: null,
        error: 'fixture unavailable',
      },
    ],
    note: 'Traffic is UNAVAILABLE (fixture, fixture unavailable). Narrate that provenance with any count; do not describe this as live.',
  },
};

function assertPinnedPayload(actual) {
  assert.deepEqual(actual, PRE_EXTRACTION_PAYLOAD);
  // deepEqual ignores key order; the serialized form does not.
  assert.equal(JSON.stringify(actual), JSON.stringify(PRE_EXTRACTION_PAYLOAD));
}

test('World Packet matches the pre-extraction get_current_view_state payload', () => {
  const packet = getWorldPacket({ ...pinnedHarness(), now: PINNED_NOW });
  assertPinnedPayload(packet);
});

test('voice get_current_view_state still returns the pre-extraction payload', async (t) => {
  t.mock.method(Date, 'now', () => PINNED_NOW);
  const runner = createGevActionRunner(pinnedHarness());
  const voice = await runner('get_current_view_state');
  assertPinnedPayload(withoutVoicePresentation(voice));
});

test('World Packet ages feeds against the clock when now is not a finite number', (t) => {
  t.mock.method(Date, 'now', () => PINNED_NOW);
  for (const now of [null, Number.NaN, '2026-10-17']) {
    const packet = getWorldPacket({ ...pinnedHarness(), now });
    const flights = packet.feedProvenance.layers.find(
      (layer) => layer.id === 'flights',
    );
    assert.equal(flights.ageSec, 90, `now: ${String(now)}`);
    assert.equal(flights.ageLabel, '1m ago', `now: ${String(now)}`);
  }
});

test('World Packet rejects null options with the camera requirement', () => {
  assert.throws(() => getWorldPacket(null), /requires a viewer camera/);
});
