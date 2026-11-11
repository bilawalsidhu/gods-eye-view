import {
  createSelectionKeeper,
  writeSelectedMarker,
} from '../../shared/selectionKeeper.js';
// The ALPR camera badges on the globe contract (engine.movers, engine.input,
// engine.camera, engine.projector, engine.surface, engine.credits), the
// same on every engine. Each displayed camera is a plain marker handle: a
// 38 px badge in one sprite set, or the 60 px selected badge in a set of
// one drawn over it, shrinking with distance, always on top and culled
// behind the globe's horizon. The overlay (../overlay.js) paints the
// nearest cameras' artwork and bearing wedges on the canvas and keeps a
// faint, unscaled badge under each as a pick target. Records, requests and
// the view's camera set stay in the layer (../index.js).
//
// The contract has no ground clamping: a marker sits on its cached ground
// floor cell, else on the terrain, and waits unseen until one of them is
// known; floors still resolving are asked for once per render.

import {
  createSurfacePoints,
  readSurface,
} from '../../../globe/surfacePlacement.js';
import * as geo from '../../../geo/index.js';
import { distanceScale } from '../../../globe/cpuPicks.js';
import { rgbaFromCss } from '../../shared/color.js';
import { alprCreditMarkup } from '../model.js';
import { createAlprOverlayCore } from '../overlay.js';
import {
  alprEntityContext,
  alprFocusBox,
  alprLabelModel,
  alprViewRecords,
} from '../presentation.js';
import { createAlprFloorResolver } from '../floors.js';
import {
  MARKER_IMAGE,
  SELECTED_IMAGE,
  validAlprGroundHeight,
} from '../visuals.js';
import {
  LAYER_ID,
  MAX_RENDERED,
  ALPR_COLOR,
  ALPR_SELECTED_COLOR,
  MARKER_ICON_SIZE,
  SELECTED_MARKER_ICON_SIZE,
  CREDIT_DISPLAY_MS,
  MARKER_FLOOR_LIFT_M,
  MARKER_SCALE_BY_DISTANCE,
} from '../policy.js';

export const ALPR_SELECTED_SET_ID = 'alpr-selected';
// Under the moving contacts (src/data/spriteOrder.js), as map data; the
// selected badge over the others.
const MARKER_ORDER = -1;
const SELECTED_ORDER = -0.5;
// What a canvas-owned marker keeps of its badge: enough for a pick.
const PICK_TARGET_ALPHA = 0.01;
// The label accents, in Cesium's CSS form.
const ACCENT = ALPR_COLOR;
const SELECTED_ACCENT = ALPR_SELECTED_COLOR;

/**
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 * @param {{ state: object, services: object, source: object }} options
 *   The layer's state, services and camera source.
 */
export function createAlprDisplay(engine, { state, services, source }) {
  const { governorRequestRender } = services.render;
  const {
    clearSelectedEntityContextForLayer,
    getSelectedEntityContext,
    registerEntityContext,
    removeEntityContextsForLayer,
    selectEntityContext,
  } = services.context.forEngine?.(engine) ?? services.context;
  const markers = new Map();
  const floors = createAlprFloorResolver(services.groundFloor);
  let normal = null,
    selected = null,
    initialized = false,
    visible = false;
  let visibleRecords = [],
    selectionStartedAt = 0,
    generation = 0,
    floorRequest = null;
  let removeMove = null,
    removeFrame = null,
    removeClick = null;
  let creditMarkup = null,
    removeCredit = null,
    creditTimer = null,
    creditPresented = false;
  let lastCamera = null,
    dirty = false;

  const cachedFloor = (record) =>
    services.groundFloor.cachedGroundFloor(record.latitude, record.longitude);
  const location = (record) =>
    geo.cartographic.fromDegrees(record.longitude, record.latitude);
  const ownSets = () => [normal, selected].filter(Boolean);

  const sampleHeight = (record) =>
    readSurface(engine, location(record), {
      exclude: ownSets(),
      prefer: 'tiles',
    });
  const terrainHeight = (record) =>
    readSurface(engine, location(record), { prefer: 'terrain' });
  let surface = null;
  const surfaceSet = {
    set(index, { position }) {
      const marker = [...markers.values()][index];
      marker.position = position;
      marker.resolved = validAlprGroundHeight(marker.surface.surfaceHeight);
      syncMarker(marker);
    },
    commit: () => flushSprites(),
  };
  /** The rendered surface under a camera, else the terrain, else its floor. */
  function surfaceHeight(record) {
    let height = sampleHeight(record);
    if (!validAlprGroundHeight(height)) height = terrainHeight(record);
    if (!validAlprGroundHeight(height)) height = cachedFloor(record);
    return height;
  }

  /**
   * Marker placement from the cached ground floor (validated mesh or DEM,
   * the ellipsoidal datum every layer shares); a cell that has not resolved
   * yet places it on the terrain until it does (`clamped`).
   */
  function placement(record) {
    const floor = cachedFloor(record);
    const clamped = !validAlprGroundHeight(floor);
    const height = clamped ? terrainHeight(record) : floor;
    const resolved = validAlprGroundHeight(height);
    return {
      clamped,
      resolved,
      surface: {
        cartographic: location(record),
        surfaceHeight: resolved ? height : undefined,
        position: geo.cartesian3.fromDegrees(
          record.longitude,
          record.latitude,
          resolved ? height + MARKER_FLOOR_LIFT_M : 0,
        ),
      },
      position: geo.cartesian3.fromDegrees(
        record.longitude,
        record.latitude,
        resolved ? height + MARKER_FLOOR_LIFT_M : 0,
      ),
    };
  }

  function viewportBox() {
    const { width, height } = engine.host.size();
    if (!width || !height) return null;
    const focus = engine.camera.pickEllipsoid({ x: width / 2, y: height / 2 });
    if (!focus) return null;
    return alprFocusBox(
      geo.cartographic.fromCartesian(focus),
      geo.cartesian3.distance(engine.camera.livePosition, focus),
    );
  }
  /** Records the current view would display (nearest first when capped). */
  const viewRecords = (records) => alprViewRecords(records, viewportBox());

  /**
   * Writes a marker's badge when it changed: its own place, or the canvas
   * anchor at full size and nearly transparent while the overlay paints it.
   */
  function syncMarker(marker) {
    if (!initialized) return;
    const owned = marker.canvasOwned;
    const position =
      owned && marker.gevAlprCanvasPosition
        ? marker.gevAlprCanvasPosition
        : marker.position;
    const isSelected = marker.id === state.selectedId;
    // The sets shrink badges with distance; a pick target keeps its size.
    const scale = owned
      ? 1 /
        distanceScale(
          MARKER_SCALE_BY_DISTANCE,
          geo.cartesian3.distance(engine.camera.livePosition, position),
        )
      : 1;
    const show =
      visible &&
      state.enabled &&
      marker.shown &&
      marker.resolved &&
      engine.projector.horizonVisible(position);
    const alpha = owned ? PICK_TARGET_ALPHA : 1;
    const previous = marker.drawn;
    if (
      previous &&
      previous.position === position &&
      previous.scale === scale &&
      previous.show === show &&
      previous.alpha === alpha &&
      previous.selected === isSelected
    )
      return;
    marker.drawn = { position, scale, show, alpha, selected: isSelected };
    const fields = {
      position,
      scale,
      show,
      color: [1, 1, 1, alpha],
      pickId: marker.id,
    };
    normal.set(marker.index, { ...fields, show: show && !isSelected });
    if (isSelected) {
      writeSelectedMarker(selected, fields);
    }
    // The overlay changes ownership while it paints, after the frame's
    // render request was taken: wake the next frame, which commits.
    if (!dirty) queueMicrotask(requestDirtySprites);
    dirty = true;
  }
  function requestDirtySprites() {
    if (dirty) engine.render.request('alpr-render');
  }
  function flushSprites() {
    if (!dirty || !initialized) return;
    normal.commit();
    selected.commit();
    dirty = false;
  }
  function dropSelectedSprite() {
    if (!initialized) return;
    writeSelectedMarker(selected, null);
    dirty = true;
  }

  const overlay = createAlprOverlayCore({
    state,
    services: {
      ...services,
      overlays: {
        ...services.overlays,
        registerPaintLane: (...args) =>
          services.overlays.registerPaintLane?.(...args, engine),
      },
    },
    onSurfaceChange: refreshPlacements,
    engine,
    markers,
    syncMarker,
    sampleHeight,
    terrainHeight,
  });

  /** Places every marker again (a new map stack moved the surface). */
  function refreshPlacements() {
    if (!state.enabled || !initialized) return;
    generation++;
    floorRequest = null;
    floors.cancel();
    for (const marker of markers.values()) {
      Object.assign(marker, placement(marker.record));
      marker.drawn = null;
      syncMarker(marker);
    }
    surface?.place({ all: true });
    resolveFloors();
    flushSprites();
    governorRequestRender('alpr-surface', engine);
  }

  /**
   * Resolves the floor cells of the records this view will display, waiting
   * at most the ground service's bounded deadline. Never throws.
   */
  async function prepareFloors(records) {
    if (typeof services.groundFloor.resolveGroundFloorCells !== 'function')
      return;
    const cold = viewRecords(records)
      .visible.filter((record) => !validAlprGroundHeight(cachedFloor(record)))
      .map((record) => ({ lat: record.latitude, lon: record.longitude }));
    if (!cold.length) return;
    try {
      await floors.prepare(cold);
    } catch {
      /* markers wait on the terrain until their floors resolve */
    }
  }

  /** Resolves the clamped markers' floors once, then places them in place. */
  function resolveFloors() {
    if (
      floorRequest ||
      typeof services.groundFloor.resolveGroundFloorCells !== 'function'
    )
      return;
    const batch = [...markers.values()].filter((marker) => marker.clamped);
    if (!batch.length) return;
    const epoch = generation;
    const request = Promise.resolve(
      floors.resolve(
        batch.map((marker) => ({
          lat: marker.record.latitude,
          lon: marker.record.longitude,
        })),
      ),
    )
      .catch(() => {})
      .then(() => {
        if (epoch !== generation || floorRequest !== request) return;
        floorRequest = null;
        if (!state.enabled || !initialized) return;
        let moved = false;
        for (const marker of batch) {
          if (markers.get(marker.id) !== marker) continue;
          const next = placement(marker.record);
          // Cells that never resolved stay clamped; later renders retry them.
          if (next.clamped) continue;
          Object.assign(marker, next);
          syncMarker(marker);
          moved = true;
        }
        if (!moved) return;
        flushSprites();
        governorRequestRender('alpr-floor', engine);
      });
    floorRequest = request;
  }

  function updateAppearance(marker, active) {
    if (marker.gevLabelModel) {
      marker.gevLabelModel.accent = active ? SELECTED_ACCENT : ACCENT;
      marker.gevLabelModel.leaderAnimationStartedAt = active
        ? selectionStartedAt
        : 0;
    }
    syncMarker(marker);
  }

  /**
   * Loaded cameras that project inside the canvas and in front of the globe.
   * "Nearby" spans twice the camera-to-ground range, so a view can hold
   * cameras while none is on screen; the row then says so rather than
   * leaving the user to wait for markers.
   * @returns {number|null} Count, or null without a canvas to project into.
   */
  function countOnScreen() {
    const { width, height } = engine.host.size();
    if (!width || !height) return null;
    let count = 0;
    for (const marker of markers.values()) {
      if (!engine.projector.horizonVisible(marker.position)) continue;
      const point = engine.projector.worldToWindow(marker.position);
      if (
        point &&
        point.x >= 0 &&
        point.x <= width &&
        point.y >= 0 &&
        point.y <= height
      )
        count += 1;
    }
    return count;
  }

  function hideOnMapCredit() {
    services.credits?.hideOsmCredit?.(engine, LAYER_ID);
    clearTimeout(creditTimer);
    creditTimer = null;
    removeCredit?.();
    removeCredit = null;
    governorRequestRender('alpr-credit', engine);
  }

  /**
   * The OSM credit inline while cameras show; another source's credit on
   * screen for a few seconds after it first displays.
   */
  function presentOnMapCredit() {
    if (
      state.enabled &&
      source.attribution?.name === 'OpenStreetMap' &&
      services.credits?.showOsmCredit
    ) {
      services.credits.showOsmCredit(engine, LAYER_ID);
      return;
    }
    if (!state.enabled || creditPresented || !creditMarkup) return;
    creditPresented = true;
    removeCredit = engine.credits.addStatic(creditMarkup, { onScreen: true });
    creditTimer = setTimeout(hideOnMapCredit, CREDIT_DISPLAY_MS);
    governorRequestRender('alpr-credit', engine);
  }

  function renderRecords() {
    if (!initialized) return;
    // Over the render cap, keep the cameras nearest the view centre and say
    // coverage is limited rather than dropping an arbitrary subset.
    const { visible: shown, capped } = viewRecords(state.records);
    state.renderSaturated = capped;
    visibleRecords = shown;
    // A refresh may retain its own selection, never reclaim one cleared or
    // replaced by an aircraft, another layer, or a voice action.
    if (!selection.reconcile({ layerId: LAYER_ID, records: shown })) {
      dropSelectedSprite();
      clearSelectedEntityContextForLayer(LAYER_ID);
    }
    governorRequestRender('alpr-render', engine);
    const ids = new Set(shown.map((record) => record.id));
    let changed = false;
    for (const id of [...markers.keys()])
      if (!ids.has(id)) {
        markers.delete(id);
        changed = true;
      }
    removeEntityContextsForLayer(LAYER_ID, { retainIds: ids });
    for (const record of shown) {
      let marker = markers.get(record.id);
      const isSelected = record.id === state.selectedId;
      if (marker?.record === record) continue;
      if (!marker) {
        marker = {
          id: record.id,
          record,
          ...placement(record),
          index: -1,
          shown: true,
          canvasOwned: false,
          displayPosition: null,
          gevAlprCanvasPosition: null,
          gevAlprWedge: null,
          drawn: null,
        };
        markers.set(record.id, marker);
        changed = true;
      } else {
        // The handle and its badge stay while the geometry is unchanged:
        // updating metadata must not rebuild the marker.
        const previous = marker.record;
        if (
          previous.latitude !== record.latitude ||
          previous.longitude !== record.longitude
        ) {
          Object.assign(marker, placement(record));
          marker.displayPosition = null;
          marker.gevAlprCanvasPosition = null;
        }
        if (
          previous.latitude !== record.latitude ||
          previous.longitude !== record.longitude ||
          previous.directionDeg !== record.directionDeg
        ) {
          marker.gevAlprCanvasPosition = null;
          marker.gevAlprWedge = null;
        }
        marker.record = record;
      }
      // The mapped camera datum has no elevation; it is not the marker's
      // visual anchor. Only the selected marker samples the rendered
      // surface, at most once per second.
      marker.gevTrackedId = record.id;
      marker.gevDisplayPosition = () => marker.displayPosition;
      marker.gevLabelModel = alprLabelModel(record, source, {
        accent: ACCENT,
        startedAt: isSelected ? selectionStartedAt : 0,
      });
      registerEntityContext(marker, alprEntityContext(record, source));
    }
    normal.setCount(markers.size);
    let index = 0;
    for (const marker of markers.values()) {
      marker.index = index++;
      marker.drawn = null;
      updateAppearance(marker, marker.id === state.selectedId);
    }
    flushSprites();
    if (changed) state.renderRevision += 1;
    surface?.place();
    state.onScreen = countOnScreen();
    resolveFloors();
    const chosen = state.selectedId ? markers.get(state.selectedId) : null;
    if (!chosen) state.selectedId = null;
    updateSelectedAnchor();
    overlay.sync(shown);
    if (chosen) services.overlays?.refreshReadout?.(chosen, engine);
    // Keep the on-map credit tied to displayed data, not loading or zoom prompts.
    if (shown.length) presentOnMapCredit();
    else hideOnMapCredit();
  }

  function clearRendered({ retainContext = false } = {}) {
    hideOnMapCredit();
    generation++;
    floors.cancel();
    floorRequest = null;
    overlay.clear();
    visibleRecords = [];
    markers.clear();
    if (initialized) {
      normal.setCount(0);
      selected.setCount(0);
      dirty = true;
      flushSprites();
    }
    if (!retainContext) removeEntityContextsForLayer(LAYER_ID);
  }

  function selectRecord(id) {
    const marker = markers.get(id);
    if (!marker || !state.recordById.has(id)) return false;
    clearSelection();
    state.selectedId = id;
    selectionStartedAt = globalThis.performance?.now?.() ?? Date.now();
    updateAppearance(marker, true);
    state.lastAnchorSampleAt = 0;
    selectEntityContext(marker);
    updateSelectedAnchor();
    overlay.sync(visibleRecords);
    flushSprites();
    governorRequestRender('alpr-selection', engine);
    return true;
  }

  function clearSelection() {
    const marker = state.selectedId ? markers.get(state.selectedId) : null;
    state.selectedId = null;
    selectionStartedAt = 0;
    dropSelectedSprite();
    if (marker) updateAppearance(marker, false);
    overlay.sync(visibleRecords);
    flushSprites();
    clearSelectedEntityContextForLayer(LAYER_ID);
    governorRequestRender('alpr-selection', engine);
  }

  /**
   * The selected marker's readout anchor: its canvas anchor, else the
   * rendered surface under it, sampled at most once per second.
   */
  function updateSelectedAnchor() {
    if (!state.enabled || !state.selectedId) return;
    if (getSelectedEntityContext()?.id !== state.selectedId) {
      clearSelection();
      return;
    }
    const marker = markers.get(state.selectedId);
    const record = state.recordById.get(state.selectedId);
    if (marker?.gevAlprCanvasPosition) {
      marker.displayPosition = marker.gevAlprCanvasPosition;
      return;
    }
    if (!marker || !record || Date.now() - state.lastAnchorSampleAt < 1000)
      return;
    state.lastAnchorSampleAt = Date.now();
    const height = surfaceHeight(record);
    if (!validAlprGroundHeight(height)) return;
    const next = geo.cartesian3.fromDegrees(
      record.longitude,
      record.latitude,
      height,
    );
    if (
      !marker.displayPosition ||
      geo.cartesian3.distance(next, marker.displayPosition) > 0.1
    ) {
      marker.displayPosition = next;
      governorRequestRender('alpr-anchor', engine);
    }
  }

  function focusNearest() {
    if (!state.enabled || !initialized || engine.camera.following())
      return false;
    let nearest = null,
      distance = Infinity;
    for (const marker of markers.values()) {
      const candidate = geo.cartesian3.distanceSquared(
        engine.camera.livePosition,
        marker.position,
      );
      if (candidate < distance) {
        nearest = marker;
        distance = candidate;
      }
    }
    if (!nearest) return false;
    const record = state.recordById.get(nearest.id);
    const height = record ? surfaceHeight(record) : undefined;
    if (!selectRecord(nearest.id)) return false;
    const center = geo.cartesian3.fromDegrees(
      record.longitude,
      record.latitude,
      validAlprGroundHeight(height) ? height : 0,
    );
    engine.camera.flyToSphere(
      { center, radius: 30 },
      {
        duration: 1.2,
        heading: engine.camera.pose().heading || 0,
        pitch: -Math.PI / 4,
        range: 800,
      },
    );
    governorRequestRender('alpr-focus', engine);
    return true;
  }

  const selection = createSelectionKeeper({
    state,
    getSelectedEntityContext,
    selectRecord,
    clearSelection,
    pickId: ({ position, picked }) =>
      overlay.pick(position) ||
      (typeof picked?.id === 'string' ? picked.id : null),
    reselectContext: true,
  });
  const onClick = selection.onClick;

  // Badges move on screen with the camera: their horizon test and a pick
  // target's size follow it.
  function frame() {
    const camera = engine.camera.livePosition;
    if (
      !lastCamera ||
      !geo.cartesian3.equalsEpsilon(camera, lastCamera, 0, 0.00001)
    ) {
      lastCamera = geo.cartesian3.clone(camera);
      for (const marker of markers.values()) syncMarker(marker);
    }
    flushSprites();
    updateSelectedAnchor();
  }

  function createSet(id, sizePx, capacity, image, order) {
    return engine.movers.createSet({
      id,
      kind: 'sprite',
      capacity,
      order,
      pickable: true,
      depthTest: 'always',
      sharpen: true,
      sprite: {
        sizePx,
        // City-wide views hold hundreds of badges; they shrink.
        scaleByDistance: MARKER_SCALE_BY_DISTANCE,
        atlas: { url: image, cells: { camera: [0, 0, 1, 1] } },
      },
    });
  }

  return {
    get ready() {
      return initialized;
    },
    count: () => markers.size,
    following: () => Boolean(engine.camera.following()),
    viewportBox,
    prepareFloors,
    renderRecords,
    clearRendered,
    hideOnMapCredit,
    selectRecord,
    clearSelection,
    focusNearest,
    /** The marker handles displayed now. */
    markers: () => [...markers.values()],
    init({ onMove }) {
      if (initialized) throw new Error('ALPR renderer is already initialized');
      // A source credit that is not a public HTTPS link fails here.
      creditMarkup = alprCreditMarkup(source.attribution);
      normal = createSet(
        LAYER_ID,
        MARKER_ICON_SIZE,
        MAX_RENDERED,
        MARKER_IMAGE,
        MARKER_ORDER,
      );
      selected = createSet(
        ALPR_SELECTED_SET_ID,
        SELECTED_MARKER_ICON_SIZE,
        1,
        SELECTED_IMAGE,
        SELECTED_ORDER,
      );
      normal.setCount(0);
      selected.setCount(0);
      normal.commit();
      selected.commit();
      initialized = true;
      surface = createSurfacePoints(engine, {
        groups: () => [
          {
            set: surfaceSet,
            points: [...markers.values()].map((marker) => {
              marker.surface.show = visible && marker.clamped;
              return marker.surface;
            }),
            exclude: ownSets(),
          },
        ],
        heightOffset: MARKER_FLOOR_LIFT_M,
        request: () => governorRequestRender('alpr-surface', engine),
      });
      removeMove = engine.camera.moveEnd.addEventListener(onMove);
      removeFrame = engine.frames.preRender.addEventListener(frame);
      overlay.init();
    },
    /** Shows the badges and takes clicks, or hides both. */
    setVisible(value) {
      const next = Boolean(value);
      if (next) creditPresented = false;
      removeClick?.();
      removeClick = next
        ? engine.input.on('click', onClick, { pick: true })
        : null;
      if (visible === next) return;
      visible = next;
      if (visible) surface?.place({ all: true });
      for (const marker of markers.values()) syncMarker(marker);
      flushSprites();
    },
    destroy(options) {
      if (!initialized) return;
      surface?.destroy();
      surface = null;
      clearRendered(options);
      overlay.destroy();
      removeClick?.();
      removeClick = null;
      removeMove?.();
      removeMove = null;
      removeFrame?.();
      removeFrame = null;
      normal.destroy();
      selected.destroy();
      normal = selected = null;
      initialized = false;
      visible = false;
      lastCamera = null;
      dirty = false;
      creditPresented = false;
    },
  };
}
