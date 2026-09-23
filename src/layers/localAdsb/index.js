import * as Cesium from 'cesium';
import { CLASS_SCALE_2D } from '../../data/aircraftClass.js';
import { aircraftIcon } from '../../data/aircraftIcons.js';
import {
  horizonOccluder,
  screenProjectedRotation,
  stabilizeScreenRotation,
} from '../../data/iconOrientation.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { pickRenderAltitudeM } from '../../data/renderAltitude.js';
import { routePlausible } from '../../data/routePlausible.js';
import {
  localAdsbPositionIsFresh,
  mergeLocalAdsbRecords,
  summarizeLocalAdsb,
} from '../../sources/adsbRecords.js';
import { GROUND_SCALE } from '../flights/policy.js';
import {
  localAdsbCardModel,
  localAdsbIsUat,
  localAdsbSourceText,
  localAdsbTitle,
} from './card.js';
import { createLocalAdsbEnrichment, localAdsbClass } from './enrichment.js';
import { createLocalAdsbModels } from './models.js';
import { LocalAdsbMotion } from './motion.js';
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
  localAdsbClassLine,
  localAdsbIsUat,
  localAdsbReceiverLine,
  localAdsbTitle,
} from './card.js';
export { localAdsbClass } from './enrichment.js';
export { localAdsbStatus } from './status.js';

const FEET_TO_METERS = 0.3048;
const RENDER_HOLD_ID = 'local-adsb';
/** The DISPLAY rail's first-run 3D preference, used when no reader is wired. */
const DEFAULT_DISPLAY = Object.freeze({
  models3d: true,
  models3dMode: 'proximity',
});

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
 * Aircraft get the public Flights treatment in magenta: a class from the
 * emitter category or adsbdb type (`aircraftClass.js`), the class silhouette
 * and scale, the Flights 3D models under the DISPLAY rail's 3D toggle, smooth
 * real-time motion (`./motion.js`, no display delay) and, while selected, a
 * trail of the positions the receiver heard.
 *
 * Markers are never followed by the camera. A marker disappears once its
 * position is older than 60 s; a record without any message for 60 s is gone.
 * @param {object} options
 * @param {object} options.receiver Local receiver session.
 * @param {object} [options.feeds] Decoder-feed session (start, stop,
 *   getState, subscribe).
 * @param {object} options.services Render, context, picking, detection and
 *   readout operations supplied by the application; optionally `display`
 *   (`getParams()` → `{ models3d, models3dMode }`), `enrichment` (a source
 *   with `getEnrichment`), `trails` (`createTrail`), `geoid`
 *   (`ensureGeoidReady`, `geoidHeight`) and `groundSnap`
 *   (`createGroundSnap`).
 * @param {() => number} [options.now] Clock, injectable for tests.
 * @param {(url: string) => string} [options.resolveAsset] Model URL resolver.
 * @param {(options: object) => Promise<object>} [options.loadModel] Model
 *   loader, injectable for tests.
 * @returns {object} Data-layer module.
 */
export function createLocalAdsbLayer({
  receiver,
  feeds = null,
  services,
  now = Date.now,
  resolveAsset = (url) => url,
  loadModel,
}) {
  if (typeof receiver?.getState !== 'function')
    throw new TypeError('Local ADS-B requires a receiver session');
  const {
    governorRequestRender,
    holdContinuousRender = () => {},
    releaseContinuousRender = () => {},
  } = services.render;
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
  let removePreRender = null;
  let renderHeld = false;
  let selectedId = null;
  let selectedTrail = null;
  let trailHeadSeq = 0;
  let models = null;
  let geoidReady = false;
  let rejectedFixes = 0;
  let state = receiver.getState();
  const markers = new Map();
  // Per-ICAO receptions (band|source -> last message) across merges.
  const heardBy = new Map();
  const enrichment = createLocalAdsbEnrichment({
    source: services.enrichment || null,
    onChange: () => {
      for (const marker of markers.values()) refreshClass(marker);
      refreshSelectedCard();
      governorRequestRender('local-adsb-enrichment');
    },
  });

  function displayPreferences() {
    return services.display?.getParams?.() || DEFAULT_DISPLAY;
  }

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
      marker.courseDeg ?? 0,
      marker.lastRotation,
    );
    const stable = stabilizeScreenRotation(marker.lastRotation, projected);
    if (stable !== null) marker.lastRotation = stable;
    return marker.lastRotation;
  }

  function geoidN(lat, lon) {
    if (!geoidReady || typeof services.geoid?.geoidHeight !== 'function')
      return null;
    try {
      const value = services.geoid.geoidHeight(lat, lon);
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  /** Barometric feet → ellipsoidal render metres, as the Flights layer does
   *  for a contact without a geometric altitude: baro + geoid N. */
  function renderHeightM(marker, altitudeFt, lat, lon) {
    if (marker.geoidN === null) marker.geoidN = geoidN(lat, lon);
    const height = pickRenderAltitudeM({
      geoAltM: null,
      baroAltM: Number.isFinite(altitudeFt)
        ? altitudeFt * FEET_TO_METERS
        : null,
      onGround: false,
      surfaceM: null,
      geoidN: marker.geoidN,
    });
    return Number.isFinite(height) ? height : (marker.geoidN ?? 0);
  }

  function fixPosition(marker, fix) {
    return Cesium.Cartesian3.fromDegrees(
      fix.lon,
      fix.lat,
      renderHeightM(marker, fix.altitudeFt, fix.lat, fix.lon),
    );
  }

  function updateDisplay(marker, at) {
    const display = marker.motion.displayAt(at);
    if (!display) return;
    marker.lat = display.lat;
    marker.lon = display.lon;
    marker.position = Cesium.Cartesian3.fromDegrees(
      display.lon,
      display.lat,
      renderHeightM(marker, display.altitudeFt, display.lat, display.lon),
      Cesium.Ellipsoid.WGS84,
      marker.position || new Cesium.Cartesian3(),
    );
    if (display.courseDeg !== null) marker.courseDeg = display.courseDeg;
  }

  function billboardScale(marker) {
    return (
      (CLASS_SCALE_2D[marker.klass] || 1) * (marker.onGround ? GROUND_SCALE : 1)
    );
  }

  /** Class silhouette and per-class scale (×0.8 on the ground), magenta. */
  function refreshClass(marker) {
    const { klass, evidence } = localAdsbClass(
      marker.record,
      enrichment.get(marker.record.icao),
    );
    marker.evidence = evidence;
    marker.klass = klass;
    const billboard = marker.entity?.billboard;
    if (!billboard) return;
    if (marker.iconKind !== klass) {
      marker.iconKind = klass;
      billboard.image = aircraftIcon(klass);
    }
    const scale = billboardScale(marker);
    if (marker.iconScale !== scale) {
      marker.iconScale = scale;
      billboard.scale = scale;
    }
  }

  function plausibleRoute(marker, meta) {
    const route = meta?.route;
    if (!route || route.callsign !== marker.record.callsign) return null;
    const record = marker.record;
    const ok = routePlausible({
      latDeg: marker.lat ?? record.lat,
      lonDeg: marker.lon ?? record.lon,
      altitudeM: Number.isFinite(record.altitudeFt)
        ? record.altitudeFt * FEET_TO_METERS
        : null,
      verticalRateMps: Number.isFinite(record.verticalRateFpm)
        ? (record.verticalRateFpm * FEET_TO_METERS) / 60
        : null,
      origin: route.origin,
      destination: route.destination,
    });
    return ok ? route : null;
  }

  function cardModel(marker, at) {
    const meta = enrichment.get(marker.record.icao);
    return localAdsbCardModel(marker.record, at, {
      aircraftClass: { klass: marker.klass, evidence: marker.evidence },
      meta,
      route: plausibleRoute(marker, meta),
    });
  }

  function contextMetadata(id, marker) {
    const record = marker.record;
    const meta = enrichment.get(record.icao);
    return {
      id,
      layerId: LAYER_ID,
      dataSource,
      layerName: LAYER_NAME,
      source: localAdsbSourceText(record),
      label: localAdsbTitle(record),
      latitude: marker.lat ?? record.lat,
      longitude: marker.lon ?? record.lon,
      properties: {
        icao: record.icao,
        callsign: record.callsign,
        category: record.category ?? null,
        aircraftClass: marker.evidence ? marker.klass : null,
        typeCode: meta?.typeCode ?? null,
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

  // ── Trail of the selected aircraft ──────────────────────────────────────

  function releaseTrail() {
    if (!selectedTrail) return;
    selectedTrail.trail?.destroy();
    if (selectedTrail.head && viewer && !viewer.isDestroyed?.()) {
      try {
        viewer.entities.remove(selectedTrail.head);
      } catch {
        /* torn down */
      }
    }
    selectedTrail = null;
  }

  function refreshTrail() {
    const marker = selectedId ? markers.get(selectedId) : null;
    if (!marker || !selectedTrail?.trail) return;
    const positions = marker.motion.fixes.map((fix) =>
      fixPosition(marker, fix),
    );
    selectedTrail.lastFix = positions.at(-1) || null;
    selectedTrail.trail.setPositions(positions);
  }

  function startTrail(marker) {
    releaseTrail();
    const createTrail = services.trails?.createTrail;
    if (typeof createTrail !== 'function' || !viewer?.entities) return;
    selectedTrail = {
      id: marker.id,
      trail: createTrail(viewer, { color: LOCAL_ADSB_COLOR, width: 2.5 }),
      head: null,
      lastFix: null,
    };
    // Live head: last heard fix → the extrapolated marker, every frame.
    selectedTrail.head = viewer.entities.add({
      // 'gev-trail' namespace: claimed by the trail pick owner so a click on
      // the head segment never reads as empty space.
      id: `gev-trail:local-adsb-head-${++trailHeadSeq}`,
      polyline: {
        positions: new Cesium.CallbackProperty(() => {
          const current = markers.get(selectedTrail?.id);
          const from = selectedTrail?.lastFix;
          if (!current?.position || !from) return [];
          return [from, Cesium.Cartesian3.clone(current.position)];
        }, false),
        width: 2.5,
        material: color.withAlpha(0.9),
        depthFailMaterial: color.withAlpha(0.45),
        arcType: Cesium.ArcType.GEODESIC,
      },
    });
    refreshTrail();
  }

  // ── Markers ─────────────────────────────────────────────────────────────

  function upsertMarker(record, at) {
    const id = `${ENTITY_PREFIX}${record.icao}`;
    let marker = markers.get(id);
    if (!marker) {
      marker = {
        id,
        entity: null,
        record,
        motion: new LocalAdsbMotion(),
        position: null,
        lat: null,
        lon: null,
        courseDeg: Number.isFinite(record.trackDeg) ? record.trackDeg : null,
        lastRotation: 0,
        klass: null,
        evidence: false,
        iconKind: null,
        iconScale: null,
        onGround: Boolean(record.onGround),
        geoidN: null,
        modelOwnsVisual: false,
      };
      markers.set(id, marker);
    }
    marker.record = record;
    marker.onGround = Boolean(record.onGround);
    const rejectedBefore = marker.motion.rejectedFixes;
    const newFix = marker.motion.observe(record, at);
    rejectedFixes += marker.motion.rejectedFixes - rejectedBefore;
    updateDisplay(marker, at);
    if (!marker.entity) {
      marker.entity = dataSource.entities.add({
        id,
        position: new Cesium.CallbackProperty(() => marker.position, false),
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
          show: new Cesium.CallbackProperty(
            () => !marker.modelOwnsVisual && markerVisible(marker),
            false,
          ),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
            0,
            2_000_000,
          ),
        },
      });
      marker.entity.gevTrackedId = id;
      marker.entity.gevDisplayPosition = () => marker.position;
    }
    refreshClass(marker);
    const uat = localAdsbIsUat(record);
    if (uat !== Boolean(marker.entity.point))
      marker.entity.point = uat ? uatRing(marker) : undefined;
    marker.entity.gevLabelModel = cardModel(marker, at);
    registerEntityContext(marker.entity, contextMetadata(id, marker));
    if (newFix && id === selectedId) refreshTrail();
    return id;
  }

  function clearSelection({ evicted = false } = {}) {
    if (!selectedId) return;
    selectedId = null;
    releaseTrail();
    clearSelectedEntityContextForLayer(LAYER_ID, { evicted });
  }

  function refreshSelectedCard() {
    const marker = selectedId ? markers.get(selectedId) : null;
    if (!marker) return;
    marker.entity.gevLabelModel = cardModel(marker, now());
    services.overlays?.refreshReadout?.(marker.entity);
  }

  function updateRenderHold() {
    const want = enabled && markers.size > 0;
    if (want === renderHeld) return;
    renderHeld = want;
    if (want) holdContinuousRender(RENDER_HOLD_ID);
    else releaseContinuousRender(RENDER_HOLD_ID);
  }

  function requestEnrichment() {
    const selected = selectedId ? markers.get(selectedId) : null;
    if (selected) enrichment.request(selected.record, { selected: true });
    for (const id of models?.eligible || []) {
      const marker = markers.get(id);
      if (marker) enrichment.request(marker.record);
    }
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
      if (marker.entity) dataSource.entities.remove(marker.entity);
      markers.delete(id);
      removed = true;
    }
    if (selectedId && !live.has(selectedId))
      clearSelection({ evicted: enabled });
    removeEntityContextsForLayer(LAYER_ID, { retainIds: live });
    if (selectedId) {
      const selected = markers.get(selectedId);
      if (getSelectedEntityContext()?.id !== selectedId) {
        selectedId = null;
        releaseTrail();
      } else services.overlays?.refreshReadout?.(selected.entity);
    }
    requestEnrichment();
    updateRenderHold();
    if (live.size || removed) governorRequestRender('local-adsb-update');
    // Detection re-solves labels only when the set of contacts changes, not
    // on every position report.
    if (added || removed) markSourcesChanged('local-adsb-update');
  }

  /** Per-frame pass: smooth positions and courses, then 3D models. */
  function frame() {
    if (!enabled || !markers.size) return;
    const at = now();
    for (const marker of markers.values()) updateDisplay(marker, at);
    models?.frame(markers, displayPreferences(), at);
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
    enrichment.request(marker.record, { selected: true });
    marker.entity.gevLabelModel = cardModel(marker, now());
    selectEntityContext(marker.entity);
    startTrail(marker);
    governorRequestRender('local-adsb-selection');
    return true;
  }

  function pickedId(picked) {
    const resolved = services.picking.resolvePickId?.(picked);
    if (resolved !== undefined) return resolved;
    if (typeof picked?.id === 'string') return picked.id;
    return typeof picked?.id?.id === 'string' ? picked.id.id : null;
  }

  function installInteraction() {
    if (clickHandler || !viewer?.scene?.canvas) return;
    clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    clickHandler.setInputAction((click) => {
      // A tool owns the pointer (src/data/inputOwnership.js): yield the click.
      if (!isPointerFree() || !enabled) return;
      const id = pickedId(viewer.scene.pick(click.position));
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

  function installFrame() {
    if (removePreRender || !viewer?.scene?.preRender?.addEventListener) return;
    removePreRender = viewer.scene.preRender.addEventListener(frame);
  }

  function releaseFrame() {
    removePreRender?.();
    removePreRender = null;
  }

  function positionRows(maxCount = 500) {
    if (!enabled) return [];
    const rows = [];
    for (const marker of markers.values()) {
      if (rows.length >= maxCount) break;
      if (!marker.position) continue;
      const carto = Cesium.Cartographic.fromCartesian(marker.position);
      rows.push({
        id: marker.record.icao,
        label: localAdsbTitle(marker.record),
        callsign: marker.record.callsign,
        position: Cesium.Cartesian3.clone(marker.position),
        latitude: marker.lat,
        longitude: marker.lon,
        altitudeM: carto?.height ?? 0,
      });
    }
    return rows;
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
      if (viewer.scene?.primitives) {
        models = createLocalAdsbModels({
          viewer,
          color,
          resolveAsset,
          groundSnap: services.groundSnap?.createGroundSnap?.() || null,
          ...(loadModel ? { loadModel } : {}),
        });
      }
      services.geoid
        ?.ensureGeoidReady?.()
        ?.then(() => {
          geoidReady = true;
          for (const marker of markers.values()) marker.geoidN = null;
        })
        ?.catch(() => {
          /* the baro path stays un-geoid-corrected */
        });
      unsubscribe = receiver.subscribe?.(scheduleSync) || null;
      unsubscribeFeeds = feeds?.subscribe?.(requestSync) || null;
      return true;
    },

    async enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      registerPickOwner(LAYER_ID, (pickedValue) => markers.has(pickedValue));
      installInteraction();
      installFrame();
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
      releaseFrame();
      unregisterPickOwner(LAYER_ID);
      sync();
      models?.clear();
      if (dataSource) dataSource.show = false;
      markSourcesChanged('local-adsb-disabled');
      return true;
    },

    async update() {
      state = receiver.getState();
      sync();
      frame();
      return true;
    },

    destroy() {
      enabled = false;
      clearInterval(tickTimer);
      clearTimeout(syncTimer);
      tickTimer = null;
      syncTimer = null;
      releaseInteraction();
      releaseFrame();
      unregisterPickOwner(LAYER_ID);
      unsubscribe?.();
      unsubscribe = null;
      unsubscribeFeeds?.();
      unsubscribeFeeds = null;
      feeds?.destroy?.();
      enrichment.destroy();
      clearSelection();
      removeEntityContextsForLayer(LAYER_ID);
      markers.clear();
      updateRenderHold();
      models?.destroy();
      models = null;
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
        // Fixes refused by the speed check: the browser decoder's own count
        // plus the layer's check on every merged record.
        rejectedPositions:
          Math.max(0, Number(current.positionsRejected) || 0) + rejectedFixes,
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
