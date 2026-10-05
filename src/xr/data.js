import {
  createFlightSource,
  createVesselSource,
} from '../sources/live/standalone.js';
import { createUsgsEarthquakeSource } from '../layers/earthquakes/source.js';
import { createSatelliteSource } from '../layers/satellites/source.js';
import { satelliteContacts } from './satellites.js';
import { sampleContacts } from './geo.js';

export const LAYERS = [
  {
    id: 'earthquakes',
    name: 'Earthquakes',
    color: '#ffb36a',
    label: 'USGS · M2.5+ · past 24h',
    interval: 120000,
  },
  {
    id: 'flights',
    name: 'Aircraft',
    color: '#6ee7cd',
    label: 'OpenSky / ADS-B · snapshot',
    interval: 30000,
  },
  {
    id: 'vessels',
    name: 'Vessels',
    color: '#79baff',
    label: 'AISStream · received positions',
    interval: 60000,
  },
  {
    id: 'satellites',
    name: 'Satellites',
    color: '#c6a0ff',
    label: 'CelesTrak stations · predicted orbit',
    interval: 60000,
  },
];

export function defaultLoaders() {
  const flights = createFlightSource(),
    vessels = createVesselSource();
  const earthquakes = createUsgsEarthquakeSource(),
    satellites = createSatelliteSource();
  return {
    async earthquakes(signal) {
      const rows = await earthquakes.getSnapshot({ signal });
      return {
        source: 'USGS',
        records: rows.map((r) => ({
          id: r.stableId,
          name: `M${r.mag.toFixed(1)} · ${r.place || 'Earthquake'}`,
          lat: r.lat,
          lon: r.lon,
          observedAtMs: r.time,
          detail: `${r.depthKm ?? 'Unknown'} km depth`,
          layer: 'earthquakes',
        })),
      };
    },
    async flights(signal) {
      const snapshot = await flights.getSnapshot({}, { signal });
      return {
        ...snapshot,
        records: snapshot.records.map((r) => ({
          id: r.id,
          name: r.callsign || r.id,
          lat: r.latitude,
          lon: r.longitude,
          observedAtMs: r.positionTimeMs,
          layer: 'flights',
          detail: `${r.originCountry || 'Unknown origin'} · ${r.baroAltitudeM == null ? 'Altitude unknown' : Math.round(r.baroAltitudeM) + ' m barometric'}`,
        })),
      };
    },
    async vessels(signal) {
      const snapshot = await vessels.getSnapshot({}, { signal });
      return {
        ...snapshot,
        records: snapshot.records.map((r) => ({
          id: r.id,
          name: r.name,
          lat: r.latitude,
          lon: r.longitude,
          observedAtMs: r.observedAtMs,
          layer: 'vessels',
          detail: `${r.type || 'Vessel'} · ${r.destination || 'Destination unknown'}`,
        })),
      };
    },
    async satellites(signal) {
      const result = await satellites.readGroup('stations', { signal });
      if (!result.ok) throw new Error(`CelesTrak HTTP ${result.status}`);
      return {
        source: 'CelesTrak · predicted',
        stale: result.stale,
        records: satelliteContacts(result.text),
      };
    },
  };
}

/** Each layer owns its request; canceled responses can never replace current data. */
export function createSpatialData({
  loaders = defaultLoaders(),
  now = () => Date.now(),
  onChange = () => {},
} = {}) {
  const states = Object.fromEntries(
    LAYERS.map((layer) => [
      layer.id,
      {
        ...layer,
        enabled: false,
        status: 'disabled',
        records: [],
        total: 0,
        source: layer.label,
        receivedAt: null,
        attemptedAt: null,
        error: null,
        controller: null,
      },
    ]),
  );
  let destroyed = false;
  const publish = () => {
    if (!destroyed) onChange(states);
  };
  async function refresh(id) {
    const state = states[id];
    if (destroyed || !state?.enabled || state.controller) return;
    const controller = new AbortController();
    state.controller = controller;
    state.attemptedAt = now();
    const timeout = setTimeout(
      () => controller.abort(new Error('Feed request timed out')),
      20000,
    );
    state.status = 'loading';
    state.error = null;
    publish();
    try {
      const snapshot = await loaders[id](controller.signal);
      controller.signal.throwIfAborted();
      if (destroyed || state.controller !== controller || !state.enabled)
        return;
      state.records = sampleContacts(snapshot.records);
      state.total = snapshot.records.length;
      state.source = snapshot.source || state.label;
      state.status = snapshot.stale ? 'stale' : 'current';
      state.receivedAt = now();
    } catch (error) {
      if (destroyed || state.controller !== controller || !state.enabled)
        return;
      state.status = state.records.length ? 'stale' : 'unavailable';
      state.error = error.message || 'Feed unavailable';
    } finally {
      clearTimeout(timeout);
      if (state.controller === controller) {
        state.controller = null;
        publish();
      }
    }
  }
  return {
    states,
    refresh,
    toggle(id) {
      const state = states[id];
      if (!state || destroyed) return;
      state.enabled = !state.enabled;
      if (!state.enabled) {
        state.controller?.abort();
        state.controller = null;
        state.status = 'disabled';
        publish();
      } else {
        publish();
        void refresh(id);
      }
    },
    tick() {
      if (destroyed) return;
      for (const state of Object.values(states)) {
        if (
          state.enabled &&
          (state.attemptedAt == null ||
            now() - state.attemptedAt >= state.interval)
        )
          void refresh(state.id);
      }
    },
    destroy() {
      destroyed = true;
      for (const state of Object.values(states)) {
        state.controller?.abort();
        state.controller = null;
      }
    },
  };
}

export function feedLabel(state, now = Date.now()) {
  if (!state.enabled) return 'Off';
  if (state.status === 'loading')
    return state.records.length ? 'Refreshing snapshot' : 'Connecting…';
  if (state.error)
    return `${state.status === 'stale' ? 'Last snapshot · ' : ''}${state.error}`;
  const age =
    state.receivedAt == null
      ? null
      : Math.max(0, Math.floor((now - state.receivedAt) / 1000));
  const stale =
    state.status === 'stale' ||
    (age != null && age * 1000 > state.interval * 2);
  return `${stale ? 'Stale · ' : ''}${state.records.length.toLocaleString()}${state.total > state.records.length ? '/' + state.total.toLocaleString() : ''} contacts${age == null ? '' : ' · ' + age + 's ago'}`;
}
