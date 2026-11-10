import { bindOverlayHost } from '../../overlays/bindOverlayHost.js';
import * as geo from '../../geo/index.js';
import { CLASS_SCALE_2D } from '../../data/aircraftClass.js';
import { aircraftIcon } from '../../data/aircraftIcons.js';
import {
  screenProjectedRotation,
  stabilizeScreenRotation,
} from '../../data/iconOrientation.js';
import { rgbaFromCss } from '../shared/color.js';
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
import { localAdsbQaDrawn } from './qaDrawn.js';
import { LocalAdsbMotion } from './motion.js';
import {
  ENTITY_PREFIX,
  LAYER_ID,
  LAYER_NAME,
  LAYER_SOURCE,
  LOCAL_ADSB_COLOR,
  LOCAL_ADSB_SYNC_MS,
  LOCAL_ADSB_TICK_MS,
} from './policy.js';
import { localAdsbStatus } from './status.js';

export { HEARD_BY_RECEIVER } from './policy.js';
export { localAdsbCardModel, localAdsbReceiverLine } from './card.js';
export { localAdsbStatus } from './status.js';

const FEET_TO_METERS = 0.3048;
const RENDER_HOLD_ID = 'local-adsb';
/** Trail lines pass through their aircraft; a click never stops on one. */
const TRAIL_PICK_PREFIX = 'gev-trail:';
/** The model tint (the layer's magenta), engine-neutral. */
const MODEL_COLOR = Object.freeze(rgbaFromCss(LOCAL_ADSB_COLOR));
/** The DISPLAY rail's first-run 3D preference, used when no reader is wired. */
const DEFAULT_DISPLAY = Object.freeze({
  models3d: true,
  models3dMode: 'proximity',
});

/**
 * Local ADS-B layer: draws aircraft heard by the user's own receivers.
 *
 * Two inputs feed it. The receiver is any object with `getState()` returning
 * `{ connected, status, message, errorText, mode, webUsbSupported, aircraft, messagesPerSecond }`,
 * `subscribe(listener)` and `setMode(mode)`; `aircraft` holds records from
 * `src/sources/adsbRecords.js`, and the optional `errorText` is the English
 * text of an `error` status (`message`, the UI-language one, stands in for a
 * receiver without it). The browser WebUSB session is one such receiver.
 * The optional `feeds` session (`./feeds.js`) supplies records read
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
 * @param {object} options.services Render, context, picking, selection
 *   (`selectionDispatcherFor`), renderer (`create({ viewer, engine })`: the
 *   engine's Local ADS-B display), detection and readout operations
 *   supplied by the application; optionally `display` (`getParams()` →
 *   `{ models3d, models3dMode }`), `enrichment` (a source with
 *   `getEnrichment`), `geoid` (`ensureGeoidReady`, `geoidHeight`) and
 *   `groundSnap` (`createGroundSnap`).
 * @param {() => number} [options.now] Clock, injectable for tests.
 * @param {(url: string) => string} [options.resolveAsset] Model URL resolver.
 * @returns {object} Data-layer module.
 */
export function createLocalAdsbLayer({
  receiver,
  feeds = null,
  services,
  now = Date.now,
  resolveAsset = (url) => url,
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
  } = bindOverlayHost(services.context, () => renderer?.engine);
  const { registerPickOwner, unregisterPickOwner } = services.picking;

  /** The engine's Local ADS-B display for this lifecycle (render/display.js). */
  let renderer = null;
  let enabled = false;
  let unsubscribe = null;
  let unsubscribeFeeds = null;
  let tickTimer = null;
  let syncTimer = null;
  let selectionRemove = null;
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
      governorRequestRender('local-adsb-enrichment', renderer?.engine);
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
    if (!renderer?.view.camera?.positionWC || !marker.position) return true;
    return renderer.view.horizon().isPointVisible(marker.position);
  }

  function markerRotation(marker) {
    if (!renderer?.view.scene || !marker.position) return marker.lastRotation;
    const projected = screenProjectedRotation(
      renderer.view.scene,
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
    return geo.cartesian3.fromDegrees(
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
    marker.position = geo.cartesian3.fromDegrees(
      display.lon,
      display.lat,
      renderHeightM(marker, display.altitudeFt, display.lat, display.lon),
      geo.ellipsoid.WGS84,
      marker.position || geo.cartesian3.create(),
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
    if (!marker.entity || !renderer) return;
    if (marker.iconKind !== klass) {
      marker.iconKind = klass;
      renderer.markers.setImage(marker.entity, aircraftIcon(klass));
    }
    const scale = billboardScale(marker);
    if (marker.iconScale !== scale) {
      marker.iconScale = scale;
      renderer.markers.setScale(marker.entity, scale);
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
      dataSource: renderer?.dataSource ?? null,
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

  // ── Trail of the selected aircraft ──────────────────────────────────────

  function releaseTrail() {
    if (!selectedTrail) return;
    selectedTrail.trail?.destroy();
    if (selectedTrail.head) renderer?.trails.removeHead(selectedTrail.head);
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
    const trail = renderer?.trails.create({
      color: LOCAL_ADSB_COLOR,
      width: 2.5,
    });
    if (!trail) return;
    selectedTrail = {
      id: marker.id,
      trail,
      head: null,
      lastFix: null,
    };
    // Live head: last heard fix → the extrapolated marker, every frame.
    selectedTrail.head = renderer.trails.createHead({
      // 'gev-trail' namespace: claimed by the trail pick owner so a click on
      // the head segment never reads as empty space.
      id: `gev-trail:local-adsb-head-${++trailHeadSeq}`,
      positions: () => {
        const current = markers.get(selectedTrail?.id);
        const from = selectedTrail?.lastFix;
        if (!current?.position || !from) return [];
        return [from, geo.cartesian3.clone(current.position)];
      },
      color: LOCAL_ADSB_COLOR,
      width: 2.5,
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
    if (!renderer) {
      refreshClass(marker);
      return id;
    }
    if (!marker.entity) {
      // Magenta glyph, 20 px, ×3 near / ×0.5 far, always on top, not drawn
      // past 2,000 km (the renderer's display distance).
      marker.entity = renderer.markers.add({
        id,
        image: aircraftIcon('airliner'),
        position: () => marker.position,
        rotation: () => markerRotation(marker),
        show: () => !marker.modelOwnsVisual && markerVisible(marker),
      });
      marker.entity.gevTrackedId = id;
      marker.entity.gevDisplayPosition = () => marker.position;
    }
    refreshClass(marker);
    const uat = localAdsbIsUat(record);
    if (uat !== renderer.markers.hasRing(marker.entity))
      renderer.markers.setRing(marker.entity, uat, () => markerVisible(marker));
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
    if (!marker?.entity) return;
    marker.entity.gevLabelModel = cardModel(marker, now());
    services.overlays?.refreshReadout?.(marker.entity, renderer?.engine);
  }

  function updateRenderHold() {
    const want = Boolean(renderer) && enabled && markers.size > 0;
    if (want === renderHeld) return;
    renderHeld = want;
    if (want) holdContinuousRender(RENDER_HOLD_ID, renderer?.engine);
    else releaseContinuousRender(RENDER_HOLD_ID, renderer?.engine);
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
      if (marker.entity) renderer.markers.remove(marker.entity);
      markers.delete(id);
      removed = true;
    }
    // Expired aircraft take their 3D models (and pending loads) with them.
    if (removed) models?.retain(markers);
    if (selectedId && !live.has(selectedId))
      clearSelection({ evicted: enabled });
    if (renderer) removeEntityContextsForLayer(LAYER_ID, { retainIds: live });
    if (renderer && selectedId) {
      const selected = markers.get(selectedId);
      if (getSelectedEntityContext()?.id !== selectedId) {
        selectedId = null;
        releaseTrail();
      } else
        services.overlays?.refreshReadout?.(selected.entity, renderer?.engine);
    }
    requestEnrichment();
    updateRenderHold();
    if (live.size || removed)
      governorRequestRender('local-adsb-update', renderer?.engine);
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
    if (!marker?.entity) return false;
    const reselect = id === selectedId && selectedTrail?.id === id;
    selectedId = id;
    enrichment.request(marker.record, { selected: true });
    marker.entity.gevLabelModel = cardModel(marker, now());
    selectEntityContext(marker.entity);
    if (!reselect) startTrail(marker);
    governorRequestRender('local-adsb-selection', renderer?.engine);
    return true;
  }

  function selectById(id) {
    if (!enabled || id === null || id === undefined) return false;
    let icao = String(id).trim().toLowerCase();
    if (icao.startsWith(ENTITY_PREFIX)) icao = icao.slice(ENTITY_PREFIX.length);
    if (!icao) return false;
    return selectMarker(`${ENTITY_PREFIX}${icao}`);
  }

  /**
   * Join the engine's selection dispatcher with this layer's own click rule
   * (`lookUnder`): a click on a local aircraft — on top, or under picks no
   * layer owns (a photoreal tile, a ring) and trail lines — always
   * (re)selects it and republishes its card, including the one already
   * selected (its card may have been displaced; a click on a marker never
   * reads as "deselect"); another layer's contact on top, or empty map,
   * releases only this layer's selection, leaving a sibling layer's new
   * selection intact; a click on a trail line alone does nothing. The
   * dispatcher picks with a drill of 8 and yields to a tool that owns the
   * pointer (src/data/inputOwnership.js).
   */
  function installInteraction() {
    if (selectionRemove || !renderer) return;
    const dispatcher = services.selection?.selectionDispatcherFor?.(
      renderer.engine,
    );
    if (!dispatcher) return;
    selectionRemove = dispatcher.register(LAYER_ID, {
      owns: (id) => markers.has(id),
      lookUnder: (id) => String(id).startsWith(TRAIL_PICK_PREFIX),
      onSelect(id) {
        if (enabled && markers.has(id)) selectMarker(id);
      },
      onEmptyClick() {
        if (!enabled || !selectedId) return;
        clearSelection();
        governorRequestRender('local-adsb-selection', renderer?.engine);
      },
    });
  }

  function releaseInteraction() {
    selectionRemove?.();
    selectionRemove = null;
  }

  function installFrame() {
    if (removePreRender || !renderer) return;
    removePreRender = renderer.view.on('preRender', frame);
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
      const carto = geo.cartographic.fromCartesian(marker.position);
      rows.push({
        id: marker.record.icao,
        label: localAdsbTitle(marker.record),
        callsign: marker.record.callsign,
        position: geo.cartesian3.clone(marker.position),
        latitude: marker.lat,
        longitude: marker.lon,
        altitudeM: carto?.height ?? 0,
      });
    }
    return rows;
  }

  const picks = { owner: LAYER_ID, predicate: (id) => markers.has(id) };
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

    /**
     * @param {object|null} nextViewer The Cesium viewer (null on an engine
     *   without one).
     * @param {{ engine?: object }} [context] LayerLifecycle's context.
     */
    init(nextViewer, options = {}) {
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
      return this.attachRenderer(options);
    },

    show(enabled) {
      renderer?.setVisible(enabled);
    },
    picks,
    attachRenderer({ engine = null } = {}) {
      renderer = services.renderer.create({ engine });
      renderer.attach();
      if (renderer.models) {
        models = createLocalAdsbModels({
          renderer,
          color: MODEL_COLOR,
          resolveAsset,
          groundSnap: services.groundSnap?.createGroundSnap?.() || null,
        });
      }
      if (enabled) {
        const restore = selectedId;
        selectedId = null;
        renderer.setVisible(true);
        registerPickOwner(picks.owner, picks.predicate, renderer?.engine);
        installInteraction();
        installFrame();
        sync();
        const selected = getSelectedEntityContext();
        if (restore && (!selected || selected.id === restore))
          selectMarker(restore);
      }
      return true;
    },

    detachRenderer() {
      if (!renderer) return;
      if (getSelectedEntityContext()?.id !== selectedId) selectedId = null;
      releaseInteraction();
      releaseFrame();
      unregisterPickOwner(LAYER_ID, renderer?.engine);
      releaseTrail();
      models?.destroy();
      models = null;
      releaseContinuousRender(RENDER_HOLD_ID, renderer.engine);
      renderHeld = false;
      renderer.detach();
      renderer.destroy();
      removeEntityContextsForLayer(LAYER_ID);
      renderer = null;
      for (const marker of markers.values()) {
        marker.entity = null;
        marker.iconKind = marker.iconScale = null;
        marker.modelOwnsVisual = false;
      }
      updateRenderHold();
    },

    async enable() {
      enabled = true;
      renderer?.setVisible(true);
      registerPickOwner(picks.owner, picks.predicate, renderer?.engine);
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
      unregisterPickOwner(LAYER_ID, renderer?.engine);
      sync();
      models?.clear();
      renderer?.setVisible(false);
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
      unsubscribe?.();
      unsubscribe = null;
      unsubscribeFeeds?.();
      unsubscribeFeeds = null;
      feeds?.destroy?.();
      enrichment.destroy();
      clearSelection();
      this.detachRenderer();
      markers.clear();
      void receiver.destroy?.();
    },

    ...(import.meta.env?.DEV
      ? {
          qaDrawn() {
            return localAdsbQaDrawn(markers, models?.qaModels?.(), {
              enabled,
              cameraPosition: renderer?.view.camera?.positionWC,
              isVisible: markerVisible,
            });
          },
        }
      : {}),

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
     * as a click does; the selection hook other selectable layers expose
     * (vessels' selectById). The camera does not follow it.
     * @param {string} id The ICAO hex of a getAllPositions row, in any case,
     *   or the marker id (`local-adsb:<icao>`).
     * @returns {boolean} Whether a fresh marker was selected.
     */
    selectById,

    /** The same as selectById, by ICAO hex. */
    selectAircraft: (icao) => selectById(icao),

    /**
     * Snapshot loaded locally received aircraft as plain JSON-safe records for the analyst
     * query engine. On demand only (once per spoken query); [] while the
     * layer is off.
     * @param {number} [maxCount=Infinity] Most records to return.
     * @returns {Array<Object>} {id, icao24, callsign, lat, lon, altitudeM, speedKts, heading, onGround}.
     */
    getAnalystRecords(maxCount = Infinity) {
      if (!enabled) return [];
      const num = (v) => (Number.isFinite(v) ? v : null);
      const result = [];
      for (const marker of markers.values()) {
        if (result.length >= maxCount) break;
        const record = marker.record || {};
        const lat = marker.lat ?? record.lat;
        const lon = marker.lon ?? record.lon;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        result.push({
          id: record.callsign || record.icao,
          icao24: record.icao || null,
          callsign: record.callsign || null,
          lat,
          lon,
          altitudeM: Number.isFinite(record.altitudeFt)
            ? Math.round(record.altitudeFt * 0.3048)
            : null,
          speedKts: num(record.groundSpeedKt),
          heading: num(record.trackDeg),
          onGround: record.onGround === true,
        });
      }
      return result;
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
