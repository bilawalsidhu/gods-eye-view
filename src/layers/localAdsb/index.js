import { VEHICLE_TINT_CSS } from '../../data/aircraftClass.js';
import { aircraftIcon } from '../../data/aircraftIcons.js';
import { rotorFrame } from '../../data/rotorFrames.js';
import { KNOT_MPS } from '../../data/units.js';
import {
  courseScreenRotation,
  stabilizeScreenRotation,
} from '../../data/screenRotation.js';
import { fromDegreesInto, toLonLatH } from '../../geo/ellipsoid.js';
import { hexColor } from '../../render/color.js';
import {
  drawOf,
  findCamera,
  findFrame,
  findQuery,
} from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
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
import { entityRecord } from '../../data/entityRecords.js';

export { HEARD_BY_RECEIVER } from './policy.js';
export { localAdsbCardModel, localAdsbReceiverLine } from './card.js';
export { localAdsbStatus } from './status.js';

const FEET_TO_METERS = 0.3048;
const RENDER_HOLD_ID = 'local-adsb';
/** Picks looked through under a click for a local aircraft. */
const CLICK_DRILL_LIMIT = 8;
/** Marker billboard size and distance scaling, as pushed and as recorded. */
const MARKER_SPRITE = Object.freeze({
  width: 20,
  height: 20,
  scaleByDistance: Object.freeze({
    near: 1000,
    nearValue: 3.0,
    far: 8_000_000,
    farValue: 0.5,
  }),
});
/** Markers and rings show within 2,000 km of the eye. */
const MARKER_RANGE = Object.freeze([0, 2_000_000]);
/** Draw sets made, so each layer instance's sets have ids of their own. */
let instances = 0;
/** Trail lines pass through their aircraft; a click never stops on one. */
const TRAIL_PICK_PREFIX = 'gev-trail:';
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
 * @param {object} options.services Render, context, picking, detection and
 *   readout operations supplied by the application; optionally `display`
 *   (`getParams()` → `{ models3d, models3dMode }`), `enrichment` (a source
 *   with `getEnrichment`), `trails` (`createTrail`), `geoid`
 *   (`ensureGeoidReady`, `geoidHeight`) and `groundSnap`
 *   (`createGroundSnap`).
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
  } = services.context;
  const { registerPickOwner, unregisterPickOwner } = services.picking;
  const color = hexColor(LOCAL_ADSB_COLOR);
  // An airport vehicle's tint, as in the Flights layer.
  const vehicleColor = hexColor(VEHICLE_TINT_CSS);
  const uatRingColor = hexColor(LOCAL_ADSB_UAT_RING_COLOR);

  let viewer = null;
  /**
   * The layer's draw sets on its viewer's renderer (`drawOf`), made at
   * `init`: the markers and the 978 MHz rings. Shown while the layer is
   * enabled. The selected aircraft's trail and its live head draw through
   * the shared trail renderer.
   * @type {{markers: object, rings: object}|null}
   */
  let sets = null;
  let enabled = false;
  let unsubscribe = null;
  let unsubscribeFeeds = null;
  let tickTimer = null;
  let syncTimer = null;
  let clickSubscription = null;
  let removePreRender = null;
  let renderHeld = false;
  let selectedId = null;
  let selectedTrail = null;
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

  /**
   * The camera's screen axes, as the course projection reads them, from the
   * camera port's pose; null without a camera.
   */
  function cameraBasis() {
    const pose = viewer ? findCamera(viewer)?.pose() : null;
    return pose?.right && pose?.up ? { right: pose.right, up: pose.up } : null;
  }

  function markerRotation(marker, basis = cameraBasis()) {
    if (!basis || !marker.position) return marker.lastRotation;
    const projected = courseScreenRotation(
      basis,
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
    return fromDegreesInto(
      fix.lon,
      fix.lat,
      renderHeightM(marker, fix.altitudeFt, fix.lat, fix.lon),
      { x: 0, y: 0, z: 0 },
    );
  }

  function updateDisplay(marker, at) {
    const display = marker.motion.displayAt(at);
    if (!display) return;
    marker.lat = display.lat;
    marker.lon = display.lon;
    marker.position = fromDegreesInto(
      display.lon,
      display.lat,
      renderHeightM(marker, display.altitudeFt, display.lat, display.lon),
      marker.position || { x: 0, y: 0, z: 0 },
    );
    if (display.courseDeg !== null) marker.courseDeg = display.courseDeg;
  }

  function billboardScale(marker) {
    return marker.onGround ? GROUND_SCALE : 1;
  }

  /** Class silhouette and per-class scale (×0.8 on the ground), magenta. */
  function refreshClass(marker) {
    const { klass, evidence } = localAdsbClass(
      marker.record,
      enrichment.get(marker.record.icao),
    );
    marker.evidence = evidence;
    marker.klass = klass;
    // What picks its fleet model: the adsbdb type, else the emitter category.
    marker.typeCode = enrichment.get(marker.record.icao)?.typeCode || null;
    marker.category = marker.record.category || null;
    if (!marker.carrier) return;
    marker.iconKind = klass;
    const scale = billboardScale(marker);
    if (marker.iconScale !== scale) {
      marker.iconScale = scale;
      entityRecord(marker.carrier).sprite.scale = scale;
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
      // Hidden with the layer: the context store reads its `show`.
      dataSource: sets?.markers ?? null,
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

  /**
   * A marker's icon, where and how it now draws: a helicopter's rotor frame
   * at `at` (still on the ground), an airport vehicle in its own tint, a
   * ground station's mast upright.
   */
  function markerItem(marker, basis, at) {
    const kind = marker.iconKind ?? 'airliner';
    return {
      id: marker.id,
      pos: marker.position,
      image: aircraftIcon(
        kind,
        undefined,
        kind === 'helicopter'
          ? rotorFrame(marker.id, at, {
              onGround: marker.onGround,
              speedMps: Number.isFinite(marker.record?.groundSpeedKt)
                ? marker.record.groundSpeedKt * KNOT_MPS
                : null,
            })
          : undefined,
      ),
      size: [MARKER_SPRITE.width, MARKER_SPRITE.height],
      scale: marker.iconScale ?? 1,
      color: kind === 'vehicle' ? vehicleColor : color,
      scaleByDistance: MARKER_SPRITE.scaleByDistance,
      rotationMode: 'screen',
      rotation: kind === 'station' ? 0 : markerRotation(marker, basis),
      // The 3D model, once loaded and placed, is the visual instead.
      show: !marker.modelOwnsVisual,
      disableDepthTest: Number.POSITIVE_INFINITY,
      displayRange: MARKER_RANGE,
      // The context carrier: what a pick hands to point-and-ask.
      meta: marker.carrier,
    };
  }

  /** The thin ring around an aircraft heard only on 978 MHz UAT. */
  function ringItem(marker) {
    return {
      id: marker.id,
      pos: marker.position,
      pixelSize: 24,
      color: [0, 0, 0, 0],
      outlineColor: uatRingColor,
      outlineWidth: 1.5,
      scaleByDistance: MARKER_SPRITE.scaleByDistance,
      disableDepthTest: Number.POSITIVE_INFINITY,
      displayRange: MARKER_RANGE,
    };
  }

  /** Draw every marker, ring and the trail head as they now are. */
  function drawMarkers() {
    if (!sets) return;
    const basis = cameraBasis();
    const at = now();
    const icons = [];
    const rings = [];
    for (const marker of markers.values()) {
      if (!marker.position) continue;
      icons.push(markerItem(marker, basis, at));
      if (marker.uat) rings.push(ringItem(marker));
    }
    if (icons.length) sets.markers.upsert(icons);
    if (rings.length) sets.rings.upsert(rings);
    drawTrailHead();
  }

  // ── Trail of the selected aircraft ──────────────────────────────────────

  function releaseTrail() {
    if (!selectedTrail) return;
    selectedTrail.trail?.destroy();
    selectedTrail = null;
  }

  /**
   * The live head: the last heard fix to the extrapolated marker, dimmed
   * where the surface hides it, drawn each frame as the aircraft moves (the
   * trail skips a head that has not moved). Nothing while either end is
   * unknown.
   */
  function drawTrailHead() {
    if (!selectedTrail?.trail?.setHead) return;
    const current = markers.get(selectedTrail.id);
    const from = selectedTrail.lastFix;
    const positions =
      current?.position && from ? [from, { ...current.position }] : [];
    // The trail's head line: 'gev-trail' ids, claimed by the trail pick
    // owner so a click on it never reads as empty space; dimmed where the
    // surface hides it. A head that has not moved is not drawn again.
    selectedTrail.trail.setHead(positions);
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
    if (typeof createTrail !== 'function' || !viewer) return;
    selectedTrail = {
      id: marker.id,
      trail: createTrail(viewer, { color: LOCAL_ADSB_COLOR, width: 2.5 }),
      // Live head: last heard fix → the extrapolated marker, every frame.
      lastFix: null,
    };
    refreshTrail();
    drawTrailHead();
  }

  // ── Markers ─────────────────────────────────────────────────────────────

  function upsertMarker(record, at) {
    const id = `${ENTITY_PREFIX}${record.icao}`;
    let marker = markers.get(id);
    if (!marker) {
      marker = {
        id,
        // What stands for the aircraft in the shared context store and the
        // readout card.
        carrier: null,
        uat: false,
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
    if (!marker.carrier) {
      marker.carrier = { id };
      entityRecord(marker.carrier).trackedId = id;
      // Sized from the record when the marker is followed (screen annotations).
      entityRecord(marker.carrier).sprite = { ...MARKER_SPRITE, scale: 1 };
      entityRecord(marker.carrier).displayPosition = () => marker.position;
    }
    refreshClass(marker);
    const uat = localAdsbIsUat(record);
    if (marker.uat && !uat) sets?.rings.remove([id]);
    marker.uat = uat;
    entityRecord(marker.carrier).labelModel = cardModel(marker, at);
    registerEntityContext(marker.carrier, contextMetadata(id, marker));
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
    entityRecord(marker.carrier).labelModel = cardModel(marker, now());
    services.overlays?.refreshReadout?.(marker.carrier);
  }

  function showSets(show) {
    if (sets) for (const set of Object.values(sets)) set.show = show;
    if (models) models.show = show;
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
    if (!sets) return;
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
    const gone = [];
    const ringsGone = [];
    for (const [id, marker] of markers) {
      if (live.has(id)) continue;
      markers.delete(id);
      gone.push(id);
      if (marker.uat) ringsGone.push(id);
    }
    const removed = gone.length > 0;
    if (removed) sets.markers.remove(gone);
    // A points set redraws on removal: only when a ring goes.
    if (ringsGone.length) sets.rings.remove(ringsGone);
    // Expired aircraft take their 3D models (and pending loads) with them.
    if (removed) models?.retain(markers);
    if (selectedId && !live.has(selectedId))
      clearSelection({ evicted: enabled });
    removeEntityContextsForLayer(LAYER_ID, { retainIds: live });
    if (selectedId) {
      const selected = markers.get(selectedId);
      if (getSelectedEntityContext()?.id !== selectedId) {
        selectedId = null;
        releaseTrail();
      } else services.overlays?.refreshReadout?.(selected.carrier);
    }
    drawMarkers();
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
    drawMarkers();
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
    const reselect = id === selectedId && selectedTrail?.id === id;
    selectedId = id;
    enrichment.request(marker.record, { selected: true });
    entityRecord(marker.carrier).labelModel = cardModel(marker, now());
    selectEntityContext(marker.carrier);
    if (!reselect) startTrail(marker);
    governorRequestRender('local-adsb-selection');
    return true;
  }

  /** A local aircraft's id when `hit` is one of its markers or models. */
  function ownHit(hit) {
    if (!hit || hit.surface || !markers.has(hit.id)) return null;
    // A ring is its aircraft's, as the ring was a point on its entity.
    return hit.set === sets?.markers.id ||
      hit.set === sets?.rings.id ||
      hit.set === models?.setId
      ? hit.id
      : null;
  }

  function ownedElsewhere(id) {
    return Boolean(id) && services.picking.isOwnedByOtherLayer?.(LAYER_ID, id);
  }

  /**
   * What a click means for this layer: a local aircraft id,
   * `'other'` when a sibling layer's contact is under the pointer, `'trail'`
   * for a trail line, or null for empty map.
   *
   * The frontmost pick decides, except that something no layer owns (a
   * photoreal tile, a ring) or a trail line drawn over or through a local
   * aircraft does not hide it: the click looks underneath, through the
   * renderer's draw-set picks, for the aircraft.
   */
  function clickTarget(event) {
    const top = event.drawHit;
    const own = ownHit(top);
    if (own) return own;
    // What is exactly on top when it is no draw-set item: a sibling's
    // contact drawn on its own, or a tile. Never a touch's wider contact
    // search: a tap that misses an aircraft selects nothing, and one near
    // another layer's contact clears the selection, as the exact pick did.
    const exact = top ? null : event.topHit;
    const topId = top
      ? top.id
      : exact && !exact.surface && exact.id != null
        ? String(exact.id)
        : null;
    if (!top && topId && markers.has(topId)) return topId;
    const trail = Boolean(topId) && String(topId).startsWith(TRAIL_PICK_PREFIX);
    if (ownedElsewhere(topId) && !trail) return 'other';
    let hits = [];
    try {
      hits =
        findQuery(viewer)?.drillPick(event.position.x, event.position.y, {
          limit: CLICK_DRILL_LIMIT,
        }) ?? [];
    } catch {
      hits = [];
    }
    for (const hit of hits) {
      const id = ownHit(hit);
      if (id) return id;
      if (String(hit.id).startsWith(TRAIL_PICK_PREFIX)) continue;
      // A sibling layer's contact above ours takes the click.
      if (ownedElsewhere(hit.id)) return 'other';
    }
    return trail ? 'trail' : null;
  }

  function installInteraction() {
    if (clickSubscription || !viewer) return;
    clickSubscription = inputFor(viewer).onClick((event) => {
      if (!enabled) return;
      const target = clickTarget(event);
      // Clicking a local aircraft always (re)selects it and republishes its
      // card, including the one already selected: its card may have been
      // displaced, and a click on a marker must never read as "deselect".
      if (target && markers.has(target)) {
        selectMarker(target);
        return;
      }
      // A click on a trail line is not empty map.
      if (target === 'trail' || !selectedId) return;
      // Another contact or empty map releases only this layer's selection,
      // leaving a sibling layer's new selection intact.
      clearSelection();
      governorRequestRender('local-adsb-selection');
    });
  }

  function releaseInteraction() {
    clickSubscription?.();
    clickSubscription = null;
  }

  function installFrame() {
    if (removePreRender || !viewer) return;
    removePreRender = findFrame(viewer)?.on('preRender', frame) ?? null;
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
      const carto = toLonLatH(marker.position);
      rows.push({
        id: marker.record.icao,
        label: localAdsbTitle(marker.record),
        callsign: marker.record.callsign,
        position: { ...marker.position },
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
      const draw = drawOf(viewer);
      const prefix = `${LAYER_ID}:${++instances}`;
      sets = {
        markers: draw.icons({
          id: `${prefix}:markers`,
          horizonCull: true,
          show: false,
        }),
        rings: draw.points({
          id: `${prefix}:rings`,
          horizonCull: true,
          show: false,
        }),
      };
      models = createLocalAdsbModels({
        viewer,
        draw,
        camera: findCamera(viewer),
        setId: `${prefix}:models`,
        seeThrough: [sets.markers.id, sets.rings.id],
        resolveAsset,
        groundSnap: services.groundSnap?.createGroundSnap?.() || null,
      });
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
      showSets(true);
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
      showSets(false);
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
      if (sets) for (const set of Object.values(sets)) set.dispose();
      sets = null;
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
