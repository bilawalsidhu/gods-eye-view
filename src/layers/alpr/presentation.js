import { isFollowing } from '../../data/followed.js';
import { inputFor } from '../../input/dispatcher.js';
import { isUnderOtherCard } from '../../data/pickRegistry.js';
import { distance, fromDegrees, toLonLatH } from '../../geo/index.js';
import {
  LAYER_ID,
  MAX_VIEWPORT_DEGREES,
  MAX_RENDERED,
  ALPR_COLOR,
  ALPR_SELECTED_COLOR,
  SELECTED_MARKER_ICON_SIZE,
  MARKER_FLOOR_LIFT_M,
} from './policy.js';
import { boxContains } from './model.js';
import { msg } from '../../i18n/index.js';
import { createAlprFloorResolver } from './floors.js';
import { createAlprOverlay } from './overlay.js';
import { lookupAlprModelSpec } from './modelSpecs.js';
import { specSummary } from '../cctv/modelSpecs.js';
import {
  alprDisplayId,
  alprLabelDetails,
  validAlprGroundHeight,
} from './visuals.js';
import { entityRecord, readEntityRecord } from '../../data/entityRecords.js';
import { alprIconPosition, alprMarkers } from './markerState.js';
import { horizonFrom } from '../../geo/horizon.js';
import { cameraOf, canvasOf, findQuery } from '../../render/rendererOf.js';

/** A `#rrggbb` colour as `rgb(r,g,b)`, the form the readout card has always had. */
function cssRgb(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`;
}

export function createAlprPresentation({ state, services, source }) {
  const { governorRequestRender } = services.render;
  const {
    clearSelectedEntityContextForLayer,
    getSelectedEntityContext,
    registerEntityContext,
    removeEntityContextsForLayer,
    selectEntityContext,
  } = services.context;

  const { cachedGroundFloor } = services.groundFloor;
  const markers = state.markers;
  const overlay = createAlprOverlay({
    state,
    services,
    onSurfaceChange: refreshMarkerPlacements,
  });
  let visibleRecords = [];
  let selectionStartedAt = 0;
  /** Markers still clamped while their floor cell resolves (id -> carrier). */
  const clampedMarkers = new Map();
  let floorResolve = null;
  const floors = createAlprFloorResolver(services.groundFloor);

  /** Heights under a camera now, through the renderer's query port. */
  function heightNow(record, against) {
    const query = findQuery(state.viewer);
    if (!query) return null;
    const point = { lon: record.longitude, lat: record.latitude };
    // A miss is tiles still streaming. The markers are no ground: the
    // height sees through them.
    return against === 'terrain'
      ? query.sampleHeightNow(point, { against: 'terrain' })
      : query.sampleHeightNow(point, { exclude: [markers.icons?.id] });
  }

  /**
   * The ground under a camera: the rendered surface, else the terrain,
   * else the cached floor; null when none is plausible.
   */
  function groundHeight(record) {
    let height = heightNow(record);
    if (!validAlprGroundHeight(height)) height = heightNow(record, 'terrain');
    if (!validAlprGroundHeight(height))
      height = cachedGroundFloor(record.latitude, record.longitude);
    return validAlprGroundHeight(height) ? height : null;
  }

  /**
   * Marker placement from the cached ground floor (validated mesh or DEM, the
   * ellipsoidal datum every layer shares). Ground clamping on photoreal tiles
   * re-samples every clamped marker whenever a tile streams in, which made a
   * whole-city view stutter while zooming, so it is only the placeholder for
   * a cell that has not resolved yet.
   * @param {{latitude:number, longitude:number}} record Camera.
   * @returns {{position: {x:number, y:number, z:number}, clamped: boolean}} Placement.
   */
  function markerPlacement(record) {
    const floor = cachedGroundFloor(record.latitude, record.longitude);
    const clamped = !validAlprGroundHeight(floor);
    return {
      clamped,
      position: fromDegrees(
        record.longitude,
        record.latitude,
        clamped ? 0 : floor + MARKER_FLOOR_LIFT_M,
      ),
    };
  }

  /** Records the current view would display (viewport box, nearest first when capped). */
  function viewRecords(records) {
    const box = viewportBox(state.viewer);
    if (!box) return { box, visible: [], capped: false };
    let visible = records.filter((record) =>
      boxContains(box, {
        south: record.latitude,
        north: record.latitude,
        west: record.longitude,
        east: record.longitude,
      }),
    );
    const capped = visible.length > MAX_RENDERED;
    if (capped) {
      const lat = (box.south + box.north) / 2;
      const lon = (box.west + box.east) / 2;
      const scale = Math.cos((lat * Math.PI) / 180);
      const distance = (record) =>
        (record.latitude - lat) ** 2 + ((record.longitude - lon) * scale) ** 2;
      visible = visible
        .map((record) => ({ record, d: distance(record) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, MAX_RENDERED)
        .map((item) => item.record);
    }
    return { box, visible, capped };
  }

  /**
   * Resolve the floor cells of the records this view will display, waiting at
   * most the ground service's bounded deadline. Never throws.
   * @param {Array<object>} records Candidate records.
   * @returns {Promise<void>}
   */
  async function prepareFloors(records) {
    const resolve = services.groundFloor.resolveGroundFloorCells;
    if (typeof resolve !== 'function') return;
    const cold = viewRecords(records)
      .visible.filter(
        (record) =>
          !validAlprGroundHeight(
            cachedGroundFloor(record.latitude, record.longitude),
          ),
      )
      .map((record) => ({ lat: record.latitude, lon: record.longitude }));
    if (!cold.length) return;
    try {
      await floors.prepare(cold);
    } catch {
      /* markers fall back to clamping until their floors resolve */
    }
  }

  /**
   * Loaded cameras that project inside the canvas and in front of the globe.
   * "Nearby" spans twice the camera-to-ground range, so a view can hold
   * cameras while none is on screen; the row then says so rather than
   * leaving the user to wait for markers. Runs once per render pass.
   * @returns {number|null} Count, or null without a scene to project into.
   */
  function countOnScreen() {
    const canvas = canvasOf(state.viewer);
    const width = canvas?.clientWidth || canvas?.width;
    const height = canvas?.clientHeight || canvas?.height;
    const query = findQuery(state.viewer);
    if (!query || !width || !height) return null;
    let count = 0;
    try {
      const horizon = horizonFrom(cameraOf(state.viewer).pose().position);
      for (const carrier of markers.values()) {
        const position = alprIconPosition(carrier);
        if (!position || !horizon.isPointVisible(position)) continue;
        const point = query.project(position);
        if (
          point &&
          point.x >= 0 &&
          point.x <= width &&
          point.y >= 0 &&
          point.y <= height
        )
          count += 1;
      }
    } catch {
      // A scene without a usable frame (startup, teardown) cannot answer.
      return null;
    }
    return count;
  }

  /** Write a marker's native placement; the canvas anchor is left alone. */
  function setMarkerPosition(carrier, position, clamped) {
    const marker = alprMarkers.write(carrier);
    marker.position = position;
    marker.clamped = clamped;
    markers.changed(carrier);
  }

  /** Refresh all native placements, including those under canvas badges. */
  function refreshMarkerPlacements() {
    if (!state.enabled || !markers.icons) return;
    clampedMarkers.clear();
    for (const carrier of markers.values()) {
      const { position, clamped } = markerPlacement(
        alprMarkers.read(carrier)?.record,
      );
      setMarkerPosition(carrier, position, clamped);
      if (clamped) clampedMarkers.set(carrier.id, carrier);
    }
    markers.flush();
    resolveClampedFloors();
    governorRequestRender('alpr-surface');
  }

  /** Resolve floors for clamped markers once, then place them in place. */
  function resolveClampedFloors() {
    const resolve = services.groundFloor.resolveGroundFloorCells;
    if (floorResolve || !clampedMarkers.size || typeof resolve !== 'function')
      return;
    const batch = [...clampedMarkers.values()];
    const request = Promise.resolve(
      floors.resolve(
        batch.map((carrier) => {
          const { record } = alprMarkers.read(carrier);
          return { lat: record.latitude, lon: record.longitude };
        }),
      ),
    )
      .catch(() => {})
      .then(() => {
        if (floorResolve !== request) return;
        floorResolve = null;
        if (!state.enabled || !markers.icons) return;
        let moved = false;
        for (const carrier of batch) {
          if (clampedMarkers.get(carrier.id) !== carrier) continue;
          clampedMarkers.delete(carrier.id);
          const { position, clamped } = markerPlacement(
            alprMarkers.read(carrier)?.record,
          );
          if (clamped) continue;
          setMarkerPosition(carrier, position, false);
          moved = true;
        }
        markers.flush();
        if (moved) governorRequestRender('alpr-floor');
        // Cells that never resolved stay clamped; later renders retry them.
      });
    floorResolve = request;
  }

  function updateAppearance(carrier, selected) {
    alprMarkers.write(carrier).selected = selected;
    markers.changed(carrier);
    const labelModel = readEntityRecord(carrier)?.labelModel;
    if (labelModel) {
      labelModel.accent = cssRgb(selected ? ALPR_SELECTED_COLOR : ALPR_COLOR);
      labelModel.leaderAnimationStartedAt = selected ? selectionStartedAt : 0;
    }
  }

  // The horizon rectangle is unstable during low-angle orbits and can exclude
  // the ground point in the center of the screen. Bound nearby coverage around
  // that point instead; the camera-to-ground range keeps zoom-out queries capped.
  function viewportBox(viewer) {
    const query = findQuery(viewer);
    const canvas = canvasOf(viewer);
    if (typeof query?.pickEllipsoid === 'function' && canvas) {
      const width = canvas.clientWidth || canvas.width;
      const height = canvas.clientHeight || canvas.height;
      if (!width || !height) return null;
      const focus = query.pickEllipsoid(width / 2, height / 2);
      if (!focus) return null;
      const location = toLonLatH(focus);
      if (!location) return null;
      const range = distance(cameraOf(viewer).pose().position, focus);
      const radius = Math.max(1000, 2 * range);
      const latitude = location.lat;
      const longitude = location.lon;
      const latSpan = radius / 111000;
      const lonSpan = latSpan / Math.cos((latitude * Math.PI) / 180);
      if (
        !Number.isFinite(latSpan + lonSpan) ||
        2 * Math.max(latSpan, lonSpan) > MAX_VIEWPORT_DEGREES ||
        Math.abs(latitude) + latSpan > 90 ||
        Math.abs(longitude) + lonSpan > 180
      )
        return null;
      return {
        south: latitude - latSpan,
        west: longitude - lonSpan,
        north: latitude + latSpan,
        east: longitude + lonSpan,
      };
    }
    // Rectangle-only viewers retain the same bounded-area contract.
    const rectangle = viewer ? cameraOf(viewer).viewRectangle() : null;
    if (!rectangle) return null;
    const { south, north, west, east } = rectangle;
    if (
      !Number.isFinite(south + north + west + east) ||
      east <= west ||
      north - south > MAX_VIEWPORT_DEGREES ||
      east - west > MAX_VIEWPORT_DEGREES
    )
      return null;
    return { south, west, north, east };
  }

  function clearRendered() {
    floors.cancel();
    floorResolve = null;
    overlay.clear();
    visibleRecords = [];
    clampedMarkers.clear();
    markers.clear();
    removeEntityContextsForLayer(LAYER_ID);
  }

  function renderRecords() {
    const selectedContext = getSelectedEntityContext();
    // Over the render cap, keep the cameras nearest the view centre and say
    // coverage is limited rather than dropping an arbitrary subset.
    const { visible, capped } = viewRecords(state.records);
    state.renderSaturated = capped;
    visibleRecords = visible;
    // A refresh may retain its own selection, never reclaim one cleared or
    // replaced by an aircraft, another layer, or a voice action.
    if (
      selectedContext?.layerId !== LAYER_ID ||
      selectedContext.id !== state.selectedId ||
      !visible.some((record) => record.id === state.selectedId)
    ) {
      state.selectedId = null;
      clearSelectedEntityContextForLayer(LAYER_ID);
    }
    governorRequestRender('alpr-render');
    const visibleIds = new Set(visible.map((record) => record.id));
    let changed = false;
    const gone = [];
    for (const carrier of markers.values())
      if (!visibleIds.has(carrier.id)) gone.push(carrier.id);
    if (gone.length) {
      markers.remove(gone);
      for (const id of gone) clampedMarkers.delete(id);
      changed = true;
    }
    removeEntityContextsForLayer(LAYER_ID, { retainIds: visibleIds });
    for (const record of visible) {
      const existing = markers.get(record.id);
      if (alprMarkers.read(existing)?.record === record) {
        updateAppearance(existing, record.id === state.selectedId);
        continue;
      }
      const selected = record.id === state.selectedId;
      const { position, clamped } = markerPlacement(record);
      // Direction wedges are painted by the overlay for the nearest cameras.
      // Native ground-clamped wedges (a ground polyline plus a classification
      // polygon per camera) cost ~40 ms per frame for 200 downtown cameras on
      // photoreal tiles, so markers stay icons only.
      let carrier = existing;
      // Keep the marker and its icon while its geometry is unchanged.
      // Updating metadata must not rebuild the marker.
      const previous = alprMarkers.read(carrier)?.record;
      if (!carrier) {
        carrier = markers.add(record.id);
        changed = true;
      }
      const marker = alprMarkers.write(carrier);
      if (!existing) {
        marker.position = position;
        marker.clamped = clamped;
      } else {
        if (
          previous.latitude !== record.latitude ||
          previous.longitude !== record.longitude
        ) {
          setMarkerPosition(carrier, position, clamped);
          marker.canvasPosition = null;
          marker.displayPosition = null;
        }
        if (
          previous.latitude !== record.latitude ||
          previous.longitude !== record.longitude ||
          previous.directionDeg !== record.directionDeg
        ) {
          marker.canvasPosition = null;
          marker.wedge = null;
        }
      }
      marker.record = record;
      entityRecord(carrier).trackedId = record.id;
      // The mapped camera datum has no elevation; it is not the clamped marker's
      // visual anchor. Only the selected marker samples the rendered surface,
      // at most once per second, through the renderer's height queries.
      marker.displayPosition ??= null;
      entityRecord(carrier).displayPosition = () => marker.displayPosition;
      entityRecord(carrier).labelModel = {
        title: alprDisplayId(record),
        details: alprLabelDetails(record, source),
        accent: cssRgb(ALPR_COLOR),
        cardStyle: 'tactical',
        selected: true,
        leaderStyle: 'elbow',
        leaderAnimationMs: 440,
        leaderAnimationStartedAt: selected ? selectionStartedAt : 0,
        leaderDrawRatio: 0.68,
        anchorRadiusPx: SELECTED_MARKER_ICON_SIZE / 2,
        anchorRadiusScale: null,
      };
      updateAppearance(carrier, selected);
      registerEntityContext(carrier, {
        id: record.id,
        layerId: LAYER_ID,
        // Hidden with the layer: the context store reads its `show`.
        dataSource: markers.icons,
        layerName: 'ALPR Cameras',
        source:
          source.attribution?.description || source.label || 'Camera source',
        label: msg('ALPR camera'),
        latitude: record.latitude,
        longitude: record.longitude,
        properties: {
          operator: record.operator,
          manufacturer: record.manufacturer,
          spec:
            specSummary(
              lookupAlprModelSpec(record.model, record.manufacturer),
            ) || null,
          cameraType: record.cameraType,
          zone: record.zone,
          directionDeg: record.directionDeg,
          ref: record.ref,
          lastVerified: record.lastVerified,
          osmId: record.osmId,
          sourceTag: record.source,
        },
      });
    }
    if (changed) state.renderRevision += 1;
    state.onScreen = countOnScreen();
    for (const carrier of markers.values())
      if (alprMarkers.read(carrier)?.clamped)
        clampedMarkers.set(carrier.id, carrier);
    resolveClampedFloors();
    const selectedCarrier = state.selectedId
      ? markers.get(state.selectedId)
      : null;
    if (!selectedCarrier) state.selectedId = null;
    updateSelectedAnchor();
    overlay.sync(visible);
    markers.flush();
    if (selectedCarrier) services.overlays?.refreshReadout?.(selectedCarrier);
  }

  function focusNearest() {
    if (!state.enabled || !state.viewer || isFollowing(state.viewer))
      return false;
    const port = cameraOf(state.viewer);
    const eye = port.pose().position;
    let nearest = null,
      best = Infinity;
    for (const carrier of markers.values()) {
      const position = alprIconPosition(carrier);
      if (!position) continue;
      const candidate = distance(eye, position);
      if (candidate < best) {
        nearest = carrier;
        best = candidate;
      }
    }
    if (!nearest) return false;
    const record = state.recordById.get(nearest.id);
    const height = groundHeight(record);
    const center = fromDegrees(record.longitude, record.latitude, height ?? 0);
    if (!selectRecord(nearest.id)) return false;
    port.flyToBounds(
      { center, radius: 30 },
      {
        durationS: 1.2,
        offset: {
          heading: port.pose().heading || 0,
          pitch: -Math.PI / 4,
          range: 800,
        },
      },
    );
    governorRequestRender('alpr-focus');
    return true;
  }

  function selectRecord(id) {
    const carrier = markers.get(id);
    if (!carrier || !state.recordById.has(id)) return false;
    clearSelection();
    state.selectedId = id;
    selectionStartedAt = globalThis.performance?.now?.() ?? Date.now();
    updateAppearance(carrier, true);
    state.lastAnchorSampleAt = 0;
    selectEntityContext(carrier);
    updateSelectedAnchor();
    overlay.sync(visibleRecords);
    markers.flush();
    governorRequestRender('alpr-selection');
    return true;
  }

  function clearSelection() {
    const carrier = state.selectedId ? markers.get(state.selectedId) : null;
    const record = state.recordById.get(state.selectedId);
    if (carrier && record) updateAppearance(carrier, false);
    state.selectedId = null;
    selectionStartedAt = 0;
    overlay.sync(visibleRecords);
    markers.flush();
    clearSelectedEntityContextForLayer(LAYER_ID);
    governorRequestRender('alpr-selection');
  }

  function updateSelectedAnchor() {
    if (!state.enabled || !state.selectedId) return;
    const selected = getSelectedEntityContext();
    if (selected?.id !== state.selectedId) {
      clearSelection();
      return;
    }
    const carrier = markers.get(state.selectedId);
    const record = state.recordById.get(state.selectedId);
    const marker = alprMarkers.read(carrier);
    if (marker?.canvasPosition) {
      marker.displayPosition = marker.canvasPosition;
      return;
    }
    if (!carrier || !record || Date.now() - state.lastAnchorSampleAt < 1000)
      return;
    state.lastAnchorSampleAt = Date.now();
    const height = groundHeight(record);
    if (height === null) return;
    const next = fromDegrees(record.longitude, record.latitude, height);
    const shown = marker?.displayPosition;
    if (!shown || distance(next, shown) > 0.1) {
      alprMarkers.write(carrier).displayPosition = next;
      governorRequestRender('alpr-anchor');
    }
  }

  function installInteraction(viewer) {
    if (state.clickSubscription) return;
    state.clickSubscription = inputFor(viewer).onClick((event) => {
      if (!state.enabled) return;
      // Another layer's card or label painted on top takes the click: the item
      // under it does not act, and the click is not empty space either.
      if (isUnderOtherCard(event)) return;
      // The painted overlay answers first; the scene is picked only if not.
      const hit = event.drawHit;
      const id =
        overlay.pick(event.screenPosition) ||
        (hit && hit.set === markers.icons?.id ? hit.id : null);
      if (
        id &&
        state.recordById.has(id) &&
        (id !== state.selectedId || getSelectedEntityContext()?.id !== id)
      )
        selectRecord(id);
      else if (state.selectedId) clearSelection();
    });
  }
  return {
    initOverlay: () => overlay.init(),
    destroyOverlay: () => overlay.destroy(),
    viewportBox,
    clearRendered,
    renderRecords,
    selectRecord,
    focusNearest,
    clearSelection,
    updateSelectedAnchor,
    installInteraction,
    prepareFloors,
  };
}
