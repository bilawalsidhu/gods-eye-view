import * as Cesium from 'cesium';
import { aircraftIcon } from '../../data/aircraftIcons.js';
import {
  horizonOccluder,
  screenProjectedRotation,
  stabilizeScreenRotation,
} from '../../data/iconOrientation.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  localAdsbPositionIsFresh,
  mergeLocalAdsbRecords,
  summarizeLocalAdsb,
} from '../../sources/adsbRecords.js';
import {
  localAdsbCardModel,
  localAdsbIsUat,
  localAdsbSourceText,
  localAdsbTitle,
} from './card.js';
import {
  ENTITY_PREFIX,
  LAYER_ID,
  LAYER_NAME,
  LAYER_SOURCE,
  LOCAL_ADSB_COLOR,
  LOCAL_ADSB_SYNC_MS,
  LOCAL_ADSB_TICK_MS,
  LOCAL_ADSB_UAT_RING_COLOR,
} from './policy.js';
import { localAdsbStatus } from './status.js';

export {
  LAYER_ID as LOCAL_ADSB_LAYER_ID,
  HEARD_BY_RECEIVER,
} from './policy.js';
export {
  localAdsbCardModel,
  localAdsbIsUat,
  localAdsbReceiverLine,
  localAdsbTitle,
} from './card.js';
export { localAdsbStatus } from './status.js';

const FEET_TO_METERS = 0.3048;

function heightMeters(record) {
  return Number.isFinite(record.altitudeFt)
    ? Math.max(0, record.altitudeFt * FEET_TO_METERS)
    : 0;
}

/**
 * Local ADS-B layer: draws aircraft heard by the user's own receivers.
 *
 * Two inputs feed it. The receiver is any object with `getState()` returning
 * `{ connected, status, message, mode, webUsbSupported, aircraft, messagesPerSecond }`,
 * `subscribe(listener)` and `setMode(mode)`; `aircraft` holds records from
 * `src/sources/adsbRecords.js`. The browser WebUSB session is one such
 * receiver. The optional `feeds` session (`./feeds.js`) supplies records read
 * by the server from local 1090/978 MHz decoders; it polls only while this
 * layer is enabled. Records are merged by ICAO (`mergeLocalAdsbRecords`).
 * Aircraft heard only on 978 MHz UAT carry a thin ring around the marker.
 *
 * Markers are never followed by the camera. A marker disappears once its
 * position is older than 60 s; a record without any message for 60 s is gone.
 * @param {object} options
 * @param {object} options.receiver Local receiver session.
 * @param {object} [options.feeds] Decoder-feed session (start, stop,
 *   getState, subscribe).
 * @param {object} options.services Render, context, picking, detection and
 *   readout operations supplied by the application.
 * @param {() => number} [options.now] Clock, injectable for tests.
 * @returns {object} Data-layer module.
 */
export function createLocalAdsbLayer({
  receiver,
  feeds = null,
  services,
  now = Date.now,
}) {
  if (typeof receiver?.getState !== 'function')
    throw new TypeError('Local ADS-B requires a receiver session');
  const { governorRequestRender } = services.render;
  const {
    registerEntityContext,
    selectEntityContext,
    clearSelectedEntityContextForLayer,
    getSelectedEntityContext,
    removeEntityContextsForLayer,
  } = services.context;
  const { registerPickOwner, unregisterPickOwner } = services.picking;
  const color = Cesium.Color.fromCssColorString(LOCAL_ADSB_COLOR);
  const uatRingColor = Cesium.Color.fromCssColorString(
    LOCAL_ADSB_UAT_RING_COLOR,
  );

  let viewer = null;
  let dataSource = null;
  let enabled = false;
  let unsubscribe = null;
  let unsubscribeFeeds = null;
  let tickTimer = null;
  let syncTimer = null;
  let clickHandler = null;
  let selectedId = null;
  let state = receiver.getState();
  const markers = new Map();
  // Per-ICAO receptions (band|source -> last message) across merges.
  const heardBy = new Map();

  function markSourcesChanged(reason) {
    services.detection?.markSourcesChanged?.(reason);
  }

  function mergedRecords(at = now(), receiverState = state) {
    return mergeLocalAdsbRecords(
      [receiverState.aircraft || [], feeds?.getState?.()?.records || []],
      at,
      heardBy,
    );
  }

  function freshRecords(at = now()) {
    return mergedRecords(at).filter((record) =>
      localAdsbPositionIsFresh(record, at),
    );
  }

  function markerVisible(marker) {
    if (!viewer?.camera?.positionWC || !marker.position) return true;
    return horizonOccluder(viewer.camera).isPointVisible(marker.position);
  }

  function markerRotation(marker) {
    if (!viewer?.scene || !marker.position) return marker.lastRotation;
    const projected = screenProjectedRotation(
      viewer.scene,
      marker.position,
      marker.trackDeg,
      marker.lastRotation,
    );
    const stable = stabilizeScreenRotation(marker.lastRotation, projected);
    if (stable !== null) marker.lastRotation = stable;
    return marker.lastRotation;
  }

  function contextMetadata(id, record) {
    return {
      id,
      layerId: LAYER_ID,
      dataSource,
      layerName: LAYER_NAME,
      source: localAdsbSourceText(record),
      label: localAdsbTitle(record),
      latitude: record.lat,
      longitude: record.lon,
      properties: {
        icao: record.icao,
        callsign: record.callsign,
        altitudeFt: record.altitudeFt,
        groundSpeedKt: record.groundSpeedKt,
        trackDeg: record.trackDeg,
        verticalRateFpm: record.verticalRateFpm,
        lastPositionAt: record.lastPositionAt,
        messageCount: record.messageCount,
        receiverSource: record.source,
        bands: record.bands,
        sources: record.sources,
      },
    };
  }

  function uatRing(marker) {
    return new Cesium.PointGraphics({
      pixelSize: 24,
      color: Cesium.Color.TRANSPARENT,
      outlineColor: uatRingColor,
      outlineWidth: 1.5,
      scaleByDistance: new Cesium.NearFarScalar(1000, 3.0, 8_000_000, 0.5),
      show: new Cesium.CallbackProperty(() => markerVisible(marker), false),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
        0,
        2_000_000,
      ),
    });
  }

  function upsertMarker(record, at) {
    const id = `${ENTITY_PREFIX}${record.icao}`;
    const position = Cesium.Cartesian3.fromDegrees(
      record.lon,
      record.lat,
      heightMeters(record),
    );
    let marker = markers.get(id);
    if (!marker) {
      marker = {
        entity: null,
        record,
        position,
        trackDeg: Number.isFinite(record.trackDeg) ? record.trackDeg : 0,
        lastRotation: 0,
      };
      marker.entity = dataSource.entities.add({
        id,
        position,
        billboard: {
          image: aircraftIcon('airliner'),
          width: 20,
          height: 20,
          scale: 1,
          color,
          sizeInMeters: false,
          scaleByDistance: new Cesium.NearFarScalar(1000, 3.0, 8_000_000, 0.5),
          alignedAxis: Cesium.Cartesian3.ZERO,
          rotation: new Cesium.CallbackProperty(
            () => markerRotation(marker),
            false,
          ),
          show: new Cesium.CallbackProperty(() => markerVisible(marker), false),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
            0,
            2_000_000,
          ),
        },
      });
      marker.entity.gevTrackedId = id;
      marker.entity.gevDisplayPosition = () => marker.position;
      markers.set(id, marker);
    } else {
      marker.position = position;
      marker.entity.position = position;
    }
    marker.record = record;
    const uat = localAdsbIsUat(record);
    if (uat !== Boolean(marker.entity.point))
      marker.entity.point = uat ? uatRing(marker) : undefined;
    if (Number.isFinite(record.trackDeg)) marker.trackDeg = record.trackDeg;
    marker.entity.gevLabelModel = localAdsbCardModel(record, at);
    registerEntityContext(marker.entity, contextMetadata(id, record));
    return id;
  }

  function clearSelection({ evicted = false } = {}) {
    if (!selectedId) return;
    selectedId = null;
    clearSelectedEntityContextForLayer(LAYER_ID, { evicted });
  }

  function sync() {
    clearTimeout(syncTimer);
    syncTimer = null;
    if (!dataSource) return;
    const at = now();
    const live = new Set();
    let added = false;
    if (enabled) {
      for (const record of freshRecords(at)) {
        const id = `${ENTITY_PREFIX}${record.icao}`;
        if (!markers.has(id)) added = true;
        live.add(upsertMarker(record, at));
      }
    }
    let removed = false;
    for (const [id, marker] of markers) {
      if (live.has(id)) continue;
      dataSource.entities.remove(marker.entity);
      markers.delete(id);
      removed = true;
    }
    if (selectedId && !live.has(selectedId))
      clearSelection({ evicted: enabled });
    removeEntityContextsForLayer(LAYER_ID, { retainIds: live });
    if (selectedId) {
      const selected = markers.get(selectedId);
      if (getSelectedEntityContext()?.id !== selectedId) selectedId = null;
      else services.overlays?.refreshReadout?.(selected.entity);
    }
    if (live.size || removed) governorRequestRender('local-adsb-update');
    // Detection re-solves labels only when the set of contacts changes, not
    // on every position report.
    if (added || removed) markSourcesChanged('local-adsb-update');
  }

  function scheduleSync(nextState) {
    state = nextState;
    requestSync();
  }

  function requestSync() {
    if (!enabled || syncTimer) return;
    syncTimer = setTimeout(sync, LOCAL_ADSB_SYNC_MS);
  }

  function selectMarker(id) {
    const marker = markers.get(id);
    if (!marker) return false;
    selectedId = id;
    marker.entity.gevLabelModel = localAdsbCardModel(marker.record, now());
    selectEntityContext(marker.entity);
    governorRequestRender('local-adsb-selection');
    return true;
  }

  function installInteraction() {
    if (clickHandler || !viewer?.scene?.canvas) return;
    clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    clickHandler.setInputAction((click) => {
      // A tool owns the pointer (src/data/inputOwnership.js): yield the click.
      if (!isPointerFree() || !enabled) return;
      const picked = viewer.scene.pick(click.position);
      const id = typeof picked?.id?.id === 'string' ? picked.id.id : null;
      if (id && markers.has(id) && id !== selectedId) selectMarker(id);
      else if (selectedId) {
        // Another contact, empty map or the same marker releases only this
        // layer's selection, leaving a sibling layer's new selection intact.
        clearSelection();
        governorRequestRender('local-adsb-selection');
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function releaseInteraction() {
    clickHandler?.destroy();
    clickHandler = null;
  }

  function positionRows(maxCount = 500) {
    if (!enabled) return [];
    return freshRecords()
      .slice(0, maxCount)
      .map((record) => ({
        id: record.icao,
        label: localAdsbTitle(record),
        callsign: record.callsign,
        position: Cesium.Cartesian3.fromDegrees(
          record.lon,
          record.lat,
          heightMeters(record),
        ),
        latitude: record.lat,
        longitude: record.lon,
        altitudeM: heightMeters(record),
      }));
  }

  return {
    id: LAYER_ID,
    name: LAYER_NAME,
    icon: '📡',
    source: LAYER_SOURCE,
    updateInterval: 0,
    statsRefreshInterval: LOCAL_ADSB_TICK_MS,
    /** The shared receiver session, also driven by the Radio panel card. */
    receiver,
    /** Decoder-feed session; the Radio card shows its one-line summary. */
    feeds,

    init(nextViewer) {
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      unsubscribe = receiver.subscribe?.(scheduleSync) || null;
      unsubscribeFeeds = feeds?.subscribe?.(requestSync) || null;
      return true;
    },

    async enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      registerPickOwner(LAYER_ID, (pickedId) => markers.has(pickedId));
      installInteraction();
      clearInterval(tickTimer);
      tickTimer = setInterval(sync, LOCAL_ADSB_TICK_MS);
      feeds?.start?.();
      // The layer asks the shared tuner for 1090 MHz. Disabling it leaves the
      // receiver in whatever mode the Radio card shows, so turning the layer
      // off never starts FM audio on its own.
      if (receiver.getState().mode !== 'adsb') await receiver.setMode('adsb');
      state = receiver.getState();
      sync();
      return true;
    },

    async disable() {
      enabled = false;
      feeds?.stop?.();
      clearInterval(tickTimer);
      tickTimer = null;
      releaseInteraction();
      unregisterPickOwner(LAYER_ID);
      sync();
      if (dataSource) dataSource.show = false;
      markSourcesChanged('local-adsb-disabled');
      return true;
    },

    async update() {
      state = receiver.getState();
      sync();
      return true;
    },

    destroy() {
      enabled = false;
      clearInterval(tickTimer);
      clearTimeout(syncTimer);
      tickTimer = null;
      syncTimer = null;
      releaseInteraction();
      unregisterPickOwner(LAYER_ID);
      unsubscribe?.();
      unsubscribe = null;
      unsubscribeFeeds?.();
      unsubscribeFeeds = null;
      feeds?.destroy?.();
      clearSelection();
      removeEntityContextsForLayer(LAYER_ID);
      markers.clear();
      if (viewer && dataSource) viewer.dataSources.remove(dataSource, true);
      dataSource = null;
      viewer = null;
      void receiver.destroy?.();
    },

    getStats() {
      const current = receiver.getState();
      const at = now();
      const records = mergedRecords(at, current);
      const { heard, positioned } = summarizeLocalAdsb(records, at);
      const lastUpdate =
        records.reduce(
          (latest, record) => Math.max(latest, record.lastMessageAt || 0),
          0,
        ) || null;
      return {
        count: positioned,
        lastUpdate,
        source: LAYER_SOURCE,
        ...localAdsbStatus({
          receiver: current,
          feedState: feeds?.getState?.() || null,
          heard,
        }),
      };
    },

    /**
     * Select a heard aircraft's marker and publish its readout card, exactly
     * as a click does. The camera does not follow it.
     * @param {string} icao Lowercase ICAO hex.
     * @returns {boolean} Whether a fresh marker was selected.
     */
    selectAircraft(icao) {
      return enabled && selectMarker(`${ENTITY_PREFIX}${icao}`);
    },

    getAllPositions(maxCount = 500) {
      return positionRows(maxCount);
    },

    getDetectableObjects(options = {}) {
      return positionRows(options.maxCount).map((row) => ({
        position: row.position,
        sourceId: row.id,
        // Label only a decoded callsign; never substitute the raw ICAO hex.
        id: row.callsign || '',
        type: 'AIR',
        skipLabel: false,
      }));
    },
  };
}
