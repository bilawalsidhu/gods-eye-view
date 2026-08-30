import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import { aircraftIcon } from './aircraftIcons.js';
import { markDetectionSourcesChanged } from './detection.js';
import {
  horizonOccluder,
  screenProjectedRotation,
  stabilizeScreenRotation,
} from './iconOrientation.js';
import { LOCAL_ADSB_STALE_MS } from './sdr/adsbDecoder.js';
import sdrController from './sdr/controller.js';

const CONTACT_PREFIX = 'local-adsb:';
const CONTACT_COLOR = Cesium.Color.fromCssColorString('#ff4fd8');

function contactLabel(aircraft) {
  return aircraft.callsign?.trim() || aircraft.icao;
}

function positionedAircraft(entries) {
  return entries.filter((entry) => (
    Number.isFinite(entry.latitude)
      && Number.isFinite(entry.longitude)
      && Number.isFinite(entry.altitudeFt)
  ));
}

/** Create the browser-local ADS-B layer with an injectable controller for tests. */
export function createAdsbLayer({ controller = sdrController } = {}) {
  let viewer = null;
  let dataSource = null;
  let enabled = false;
  let unsubscribe = null;
  let state = controller.getState();
  const entities = new Map();

  function aircraftVisible(record) {
    if (!viewer?.camera?.positionWC || !record.position) return true;
    return horizonOccluder(viewer.camera).isPointVisible(record.position);
  }

  function aircraftRotation(record) {
    if (!viewer?.scene || !record.position) return record.lastRotation;
    const projected = screenProjectedRotation(
      viewer.scene,
      record.position,
      record.headingDeg,
      record.lastRotation,
    );
    const stable = stabilizeScreenRotation(record.lastRotation, projected);
    if (stable !== null) record.lastRotation = stable;
    return record.lastRotation;
  }

  function syncEntities(nextState) {
    state = nextState;
    if (!dataSource || !enabled) return;
    const liveIds = new Set();
    for (const aircraft of positionedAircraft(nextState.aircraft)) {
      const id = `${CONTACT_PREFIX}${aircraft.icao}`;
      liveIds.add(id);
      const altitudeM = Math.max(0, aircraft.altitudeFt * 0.3048);
      const position = Cesium.Cartesian3.fromDegrees(
        aircraft.longitude,
        aircraft.latitude,
        altitudeM,
      );
      let record = entities.get(id);
      if (!record) {
        record = {
          entity: null,
          position,
          headingDeg: Number.isFinite(aircraft.headingDeg) ? aircraft.headingDeg : 0,
          lastRotation: 0,
        };
        record.entity = dataSource.entities.add({
          id,
          position,
          billboard: {
            image: aircraftIcon('airliner'),
            width: 20,
            height: 20,
            scale: 1,
            color: CONTACT_COLOR,
            sizeInMeters: false,
            scaleByDistance: new Cesium.NearFarScalar(1000, 3.0, 8_000_000, 0.5),
            alignedAxis: Cesium.Cartesian3.ZERO,
            rotation: new Cesium.CallbackProperty(() => aircraftRotation(record), false),
            show: new Cesium.CallbackProperty(() => aircraftVisible(record), false),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 2_000_000),
          },
          properties: {
            layerId: 'adsb',
            icao24: aircraft.icao,
            callsign: aircraft.callsign || null,
            altitudeFt: aircraft.altitudeFt,
            speedKt: aircraft.speedKt,
            headingDeg: aircraft.headingDeg,
            verticalRateFpm: aircraft.verticalRateFpm,
            source: 'Local RTL-SDR',
          },
        });
        entities.set(id, record);
      } else {
        record.position = position;
        if (Number.isFinite(aircraft.headingDeg)) record.headingDeg = aircraft.headingDeg;
        record.entity.position = position;
        record.entity.properties = new Cesium.PropertyBag({
          layerId: 'adsb',
          icao24: aircraft.icao,
          callsign: aircraft.callsign || null,
          altitudeFt: aircraft.altitudeFt,
          speedKt: aircraft.speedKt,
          headingDeg: aircraft.headingDeg,
          verticalRateFpm: aircraft.verticalRateFpm,
          source: 'Local RTL-SDR',
        });
      }
    }
    const now = Date.now();
    for (const [id, record] of entities) {
      const lastSeen = nextState.aircraft.find((entry) => `${CONTACT_PREFIX}${entry.icao}` === id)?.lastSeen || 0;
      if (liveIds.has(id) || now - lastSeen < LOCAL_ADSB_STALE_MS) continue;
      dataSource.entities.remove(record.entity);
      entities.delete(id);
    }
    governorRequestRender('local-adsb-update');
    markDetectionSourcesChanged('local-adsb-update');
  }

  return {
    id: 'adsb',
    name: 'Local ADS-B',
    icon: '📡',
    source: 'RTL-SDR · WebUSB',
    updateInterval: 0,
    statsRefreshInterval: 1000,

    init(nextViewer) {
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource('local-adsb');
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      unsubscribe = controller.subscribe(syncEntities);
      return true;
    },

    async enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      if (state.mode !== 'adsb') await controller.setMode('adsb');
      state = controller.getState();
      syncEntities(controller.getState());
      return true;
    },

    async disable() {
      enabled = false;
      if (dataSource) dataSource.show = false;
      if (state.mode === 'adsb') await controller.setMode('fm');
      state = controller.getState();
      markDetectionSourcesChanged('local-adsb-disabled');
      return true;
    },

    async update() {
      syncEntities(controller.getState());
      return true;
    },

    destroy() {
      unsubscribe?.();
      unsubscribe = null;
      if (viewer && dataSource) viewer.dataSources.remove(dataSource, true);
      dataSource = null;
      viewer = null;
      entities.clear();
      enabled = false;
    },

    getStats() {
      const positioned = positionedAircraft(state.aircraft);
      const lastUpdate = state.aircraft.reduce((latest, entry) => Math.max(latest, entry.lastSeen || 0), 0) || null;
      return {
        count: positioned.length,
        lastUpdate,
        source: 'RTL-SDR · WebUSB',
        status: state.status === 'unsupported' || state.status === 'error' ? 'unavailable' : state.status,
        loading: state.status === 'connecting' || state.status === 'tuning',
        loadingLabel: state.connected
          ? (state.mode === 'adsb' ? '1090 MHz local receiver' : 'receiver is in FM mode')
          : 'connect hardware in Radio',
        ...(state.status === 'unsupported' || state.status === 'error' ? { error: state.message } : {}),
      };
    },

    getAllPositions(maxCount = 500) {
      if (!enabled) return [];
      return positionedAircraft(state.aircraft).slice(0, maxCount).map((aircraft) => ({
        id: aircraft.icao,
        label: contactLabel(aircraft),
        callsign: aircraft.callsign?.trim() || null,
        position: Cesium.Cartesian3.fromDegrees(
          aircraft.longitude,
          aircraft.latitude,
          Math.max(0, aircraft.altitudeFt * 0.3048),
        ),
        latitude: aircraft.latitude,
        longitude: aircraft.longitude,
        altitudeM: aircraft.altitudeFt * 0.3048,
      }));
    },

    getDetectableObjects(options = {}) {
      const rows = this.getAllPositions(options.maxCount);
      return rows.map((row) => ({
        position: row.position,
        sourceId: row.id,
        // The box only needs a valid position. Keep its callout honest: unlike
        // Context/analyst identity, the on-globe annotation must not substitute
        // a raw ICAO hex when this receiver has not decoded a callsign.
        id: row.callsign || '',
        type: 'AIR',
        skipLabel: false,
      }));
    },

    getAnalystRecords(maxCount = 2000) {
      if (!enabled) return [];
      return positionedAircraft(state.aircraft).slice(0, maxCount).map((aircraft) => ({
        id: aircraft.icao,
        callsign: aircraft.callsign || null,
        latitude: aircraft.latitude,
        longitude: aircraft.longitude,
        altitudeM: aircraft.altitudeFt * 0.3048,
        speedMps: Number.isFinite(aircraft.speedKt) ? aircraft.speedKt * 0.514444 : null,
        headingDeg: aircraft.headingDeg ?? null,
        verticalRateMps: Number.isFinite(aircraft.verticalRateFpm)
          ? aircraft.verticalRateFpm * 0.00508
          : null,
        lastSeenMs: aircraft.lastSeen,
        source: 'Local RTL-SDR',
      }));
    },
  };
}

const adsbLayer = createAdsbLayer();
export default adsbLayer;
