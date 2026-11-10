import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createQueries } from './queries.js';
import { createSubject } from './subject.js';
import { createModel } from './model.js';
import { summarizeAwarenessCohort } from '../../data/militaryAwarenessEngine.js';
import { layerFeedState } from '../../data/feedState.js';
import aisLiveVesselsLayer, {
  _setVesselStateForTest,
  _beginAisSessionForTest,
  _applyAisFeedSnapshotForTest,
  _setAisRuntimeForTest,
} from '../../data/aisLiveVessels.js';

test('a poll that returns the same stale AIS snapshot restores STALE on Contacts cohorts', () => {
  globalThis.document ??= { body: null };
  const services = {
    installations: { getNearby: () => [], getStats: () => ({}) },
    flights: { getNearby: () => [] },
    military: { getNearby: () => [] },
    vessels: { getNearby: () => [] },
  };
  const layerState = {
    enabled: true,
    passive: true,
    sourceRevision: '',
    cohortPages: new Map(),
    subject: {
      id: 'site-1',
      layerId: 'military-installations',
      label: 'Site',
      position: Cesium.Cartesian3.fromDegrees(0, 0, 0),
    },
  };
  let states;
  const parts = {
    navigation: {
      summarizeAwarenessCohortForNavigation: (items, source) =>
        summarizeAwarenessCohort(items, source),
      isFlightLayer: (id) => id === 'flights' || id === 'military',
    },
    rendering: { renderVisual() {}, scheduleDirectionOverlayUpdate() {} },
    panel: { renderResults() {} },
  };
  const realQueries = createQueries({ state: layerState, services, parts });
  parts.queries = { ...realQueries, collectSourceStates: () => states };
  parts.model = createModel({ state: layerState, services, parts });
  const subject = createSubject({ state: layerState, services, parts });
  const flights = (lastUpdate) => ({
    available: true, enabled: true, stale: false,
    stats: { source: 'OpenSky Network', count: 4, lastUpdate },
  });
  const vessels = (loading) => ({
    available: true, enabled: true, stale: true,
    stats: { source: 'Datalastic', stale: true, count: 3, lastUpdate: 1000, loading },
  });
  const rest = {
    military: { available: true, enabled: true, stale: false, stats: { source: 'adsb.lol', fallback: false, count: 1, lastUpdate: 1 } },
    'military-installations': { available: true, enabled: true, stale: false, stats: { coverage: { kind: 'subject', radiusM: 100000 } } },
  };
  const ais = () => layerState.results.cohorts.find((c) => c.id === 'ais-live-vessels');

  // 1. Stale AIS cache, nothing loading.
  states = { flights: flights(1), 'ais-live-vessels': vessels(false), ...rest };
  subject.refreshSelectedSubject(true);
  assert.equal(ais().sourceStatus, 'stale');

  // 2. AIS re-poll in flight while the flights poll lands (revision changes).
  states = { flights: flights(2), 'ais-live-vessels': vessels(true), ...rest };
  subject.refreshSelectedSubject();
  assert.equal(ais().sourceStatus, 'stale', 'a poll in flight keeps the snapshot stale');

  // 3. AIS poll returns the same stale snapshot; only loading flips back.
  states = { flights: flights(2), 'ais-live-vessels': vessels(false), ...rest };
  subject.refreshSelectedSubject();
  subject.refreshSelectedSubject();
  assert.equal(ais().sourceStatus, 'stale', 'Layers reads STALE again; Contacts/Cockpit must too');
});

function fakeRuntime() {
  return {
    now: () => 1000,
    setTimeout: () => ({}),
    clearTimeout() {},
  };
}

test('first AIS connect (no snapshot yet) carries no STALE on the Contacts cohort', () => {
  globalThis.document ??= { body: null };
  _setAisRuntimeForTest(fakeRuntime());
  _setVesselStateForTest({ viewer: {}, records: [] });
  try {
    _beginAisSessionForTest();
    // What server/providers/vessels/ais-live.js answers while its socket connects.
    _applyAisFeedSnapshotForTest({}, {
      rows: [], source: 'AISStream', status: 'connecting', refreshing: true,
    });
    const vesselStats = aisLiveVesselsLayer.getStats();
    assert.equal(vesselStats.loading, true);
    assert.equal(vesselStats.stale, true);
    assert.equal(vesselStats.lastUpdate, null);
    assert.equal(layerFeedState(vesselStats), 'loading', 'Layers chip reads LOADING');

    const flightsStats = { source: 'OpenSky Network', count: 2, lastUpdate: 5 };
    const militaryStats = { source: 'adsb.lol', fallback: false, count: 1, lastUpdate: 5 };
    const installStats = { coverage: { kind: 'subject', radiusM: 100000 } };
    const statsById = {
      flights: flightsStats,
      military: militaryStats,
      'ais-live-vessels': vesselStats,
      'military-installations': installStats,
    };
    const services = {
      installations: { getNearby: () => [], getStats: () => installStats },
      flights: { getNearby: () => [] },
      military: { getNearby: () => [] },
      vessels: aisLiveVesselsLayer,
    };
    const layerState = {
      enabled: true,
      passive: true,
      sourceRevision: '',
      cohortPages: new Map(),
      dataManager: {
        isEnabled: () => true,
        getLayerLifecycleState: () => ({ enabled: true, lifecycleState: 'enabled' }),
        layers: new Map(Object.entries(statsById).map(([id, s]) => [id, { module: { getStats: () => s } }])),
      },
      subject: {
        id: 'site-1',
        layerId: 'military-installations',
        label: 'Site',
        position: Cesium.Cartesian3.fromDegrees(0, 0, 0),
      },
    };
    const parts = {
      navigation: {
        summarizeAwarenessCohortForNavigation: (items, source) => summarizeAwarenessCohort(items, source),
        isFlightLayer: (id) => id === 'flights' || id === 'military',
      },
      rendering: { renderVisual() {}, scheduleDirectionOverlayUpdate() {} },
      panel: { renderResults() {} },
    };
    parts.queries = createQueries({ state: layerState, services, parts });
    parts.model = createModel({ state: layerState, services, parts });
    const subject = createSubject({ state: layerState, services, parts });

    const vesselsSource = parts.queries.collectSourceStates()['ais-live-vessels'];
    assert.equal(vesselsSource.available, false, 'never-answered source is unavailable');

    subject.refreshSelectedSubject(true);
    const ais = layerState.results.cohorts.find((c) => c.id === 'ais-live-vessels');
    assert.equal(ais.sourceStatus, null, 'no snapshot yet: no STALE label, Layers says LOADING');
  } finally {
    _setVesselStateForTest({ enabled: false });
    _setAisRuntimeForTest();
  }
});
