import {
  createSelectionKeeper,
  writeSelectedMarker,
} from '../../shared/selectionKeeper.js';
import { bindOverlayHost } from '../../../overlays/bindOverlayHost.js';
// Mapped Installations on the globe contract (engine.movers, engine.ground,
// engine.input, engine.camera), the same on every engine:
//
// - each rendered site is a 9 px disc in its class colour with a 1 px black
//   outline at 0.8, always on top (the selected site's is 13 px and white,
//   in a set of one over the others); a named area's disc is not drawn, its
//   named-area marker is (./namedMarkers.js);
// - every rendered site's outlines, named areas' too, are 2 px ground lines
//   at 0.85 in its class colour, on terrain and 3D tiles;
// - the selected site's footprints are filled at 0.22 in its class colour,
//   on the 3D tiles while they hide the globe, else on both.
//
// A pick of a disc, an outline or the fill names the site. The contract has
// no ground clamping: a disc sits on its site's cached ground floor (the
// ellipsoid until the floor resolves), and floors that resolve late paint
// again. A site whose geometry is unchanged keeps its context handle across
// repaints, and its outlines stay drawn while a changed set is rebuilt.

import { t } from '../../../i18n/index.js';
import * as geo from '../../../geo/index.js';
import {
  claimCameraSensitivity,
  releaseCameraSensitivity,
} from '../../../data/cameraSensitivity.js';
import { installationClassLabel, installationTitle } from '../classLabel.js';
import { LAYER_ID, MAX_RENDERED } from '../policy.js';
import { createNamedMarkers } from './namedMarkers.js';
import {
  MARKER_ORDER,
  MARKER_OUTLINE_COLOR,
  MARKER_OUTLINE_PX,
  MARKER_SIZE_PX,
  OUTLINE_ALPHA,
  OUTLINE_ORDER,
  OUTLINE_WIDTH_PX,
  SELECTED_MARKER_COLOR,
  SELECTED_MARKER_ORDER,
  SELECTED_MARKER_SIZE_PX,
  SELECTION_FILL_ALPHA,
  SELECTION_FILL_ORDER,
  installationAccent,
} from './style.js';

export const MARKER_SET_ID = LAYER_ID;
export const SELECTED_MARKER_SET_ID = `${LAYER_ID}-selected`;
export const OUTLINE_SET_ID = `${LAYER_ID}-outlines`;
export const SELECTION_FILL_SET_ID = `${LAYER_ID}-selection-fill`;

const CONTEXT_EVENTS = [
  'gev:entity-selected',
  'gev:entity-selection-cleared',
  'gev:awareness-subject-selected',
];

const footprintsOf = (record) =>
  record.footprints || (record.footprint ? [[record.footprint]] : []);
const outlinesOf = (record) =>
  record.outlineLines || (record.footprint ? [record.footprint] : []);

/**
 * Geometry identity of one rendered record. A record whose key is unchanged
 * keeps its handle and its drawn outlines across refreshes: ground geometry
 * rebuilds a few frames later on Cesium, so redrawing unchanged sites on
 * every reload made them blink.
 * @param {object} record Installation record.
 * @returns {string} Stable key for the record's drawn geometry.
 */
export function installationRenderKey(record) {
  const footprints = footprintsOf(record);
  const outlines = outlinesOf(record);
  let points = 0;
  for (const rings of footprints)
    for (const ring of rings) points += ring.length;
  for (const line of outlines) points += line.length;
  return [
    record.latitude.toFixed(6),
    record.longitude.toFixed(6),
    record.class,
    record.kind,
    record.name,
    footprints.length,
    outlines.length,
    points,
  ].join('|');
}

/**
 * A ground set whose rebuild never blanks what it drew: the next items go
 * into a second set, and the first is emptied once the second is drawn.
 */
function createSteadyGroundSet(engine, { id, ...options }) {
  const sets = [0, 1].map((n) =>
    engine.ground.createSet({ ...options, id: `${id}-${n}` }),
  );
  let front = 0;
  let pending = false;
  let removeWatch = null;
  const stopWatch = () => {
    removeWatch?.();
    removeWatch = null;
  };
  function settle() {
    if (!pending || !sets[1 - front].ready()) return;
    sets[front].replace([]);
    sets[front].commit();
    front = 1 - front;
    pending = false;
    stopWatch();
  }
  return {
    ids: sets.map((set) => set.id),
    replace(items) {
      const next = sets[1 - front];
      next.replace(items);
      next.commit();
      pending = true;
      settle();
      if (pending)
        removeWatch ??= engine.frames.postRender.addEventListener(settle);
    },
    clear() {
      stopWatch();
      pending = false;
      for (const set of sets) {
        set.replace([]);
        set.commit();
      }
    },
    show(visible) {
      for (const set of sets) set.show(visible);
    },
    destroy() {
      stopWatch();
      for (const set of sets) set.destroy();
    },
  };
}

/**
 * The layer's renderer parts on `engine`: `{ lifecycle: { methods },
 * namedMarkers, rendering, selection }` (../index.js assigns them to its
 * parts).
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 * @param {{ state: object, services: object, parts: object, source: object,
 *   overlayHost: object }} context The layer's state, services, parts,
 *   source and the shared overlay that paints its titles.
 */
export function createInstallationsDisplay(
  engine,
  { state, services, parts, source, overlayHost },
) {
  const { governorRequestRender } = services.render;
  const {
    clearSelectedEntityContextForLayer,
    getSelectedEntityContext,
    registerEntityContext,
    removeEntityContextsForLayer,
    selectEntityContext,
  } = services.context.forEngine?.(engine) ?? services.context;
  const namedMarkers = createNamedMarkers(engine, {
    state,
    services,
    parts,
    overlayHost: bindOverlayHost(overlayHost, () => engine),
  });

  let initialized = false;
  let visible = false;
  // Bumped when the renderer detaches: late floor work stops there.
  let generation = 0;
  let normal = null,
    selected = null,
    outlines = null,
    fill = null;
  let fillDrape = null,
    fillKey = null;
  let outlineSignature = '';
  // Record id → { key, record, position, heightM, context handle fields }.
  const handles = new Map();
  let drawn = [];
  let removeClick = null,
    removeContextListeners = null;

  const colorOf = (record) => parts.model.colorFor(record);
  const positionAt = (record, heightM) =>
    geo.cartesian3.fromDegrees(record.longitude, record.latitude, heightM);

  function syncPlacesCredit(records) {
    const usesPlaces = records.some((record) =>
      record.sources?.some((item) => item.name === 'Google Maps Places'),
    );
    if (usesPlaces)
      services.credits?.showGooglePlacesCredit?.(engine, LAYER_ID);
    else services.credits?.hideGooglePlacesCredit?.(engine, LAYER_ID);
  }

  /** The OSM credit while a loaded record comes from OpenStreetMap. */
  function syncOsmCredit(records) {
    if (
      records.some((record) =>
        record.sources?.some((item) => item.name === 'OpenStreetMap'),
      )
    )
      services.credits?.showOsmCredit?.(engine, LAYER_ID, {
        openMapTiles: records.some((record) =>
          record.sources?.some(
            (item) =>
              item.name === 'OpenStreetMap' && item.id?.startsWith('tile:'),
          ),
        ),
      });
    else services.credits?.hideOsmCredit?.(engine, LAYER_ID);
  }

  function createMarkerSet(id, sizePx, capacity, order) {
    return engine.movers.createSet({
      id,
      kind: 'point',
      capacity,
      order,
      depthTest: 'always',
      pickable: true,
      point: {
        sizePx,
        outlinePx: MARKER_OUTLINE_PX,
        outlineColor: MARKER_OUTLINE_COLOR,
      },
    });
  }

  /** The discs of the drawn sites; none while the layer is hidden. */
  function paintMarkers() {
    if (!initialized) return;
    let count = 0;
    let chosen = null;
    if (visible)
      for (const handle of drawn) {
        const { record } = handle;
        if (record.namedArea) continue;
        if (record.id === state.selectedId) {
          chosen = handle;
          continue;
        }
        normal.set(count++, {
          position: handle.position,
          color: colorOf(record).rgba(),
          pickId: record.id,
        });
      }
    normal.setCount(count);
    writeSelectedMarker(
      selected,
      chosen
        ? {
            position: chosen.position,
            color: SELECTED_MARKER_COLOR,
            pickId: chosen.record.id,
          }
        : null,
    );
    normal.commit();
    selected.commit();
  }

  /** The drawn sites' outlines, rebuilt only when one of them changed. */
  function paintOutlines() {
    const signature = drawn
      .map((handle) => `${handle.record.id}#${handle.key}`)
      .join('\n');
    if (signature === outlineSignature) return;
    outlineSignature = signature;
    const items = [];
    for (const { record } of drawn) {
      const color = colorOf(record).withAlpha(OUTLINE_ALPHA).rgba();
      for (const line of outlinesOf(record))
        items.push({
          positions: line,
          color,
          widthPx: OUTLINE_WIDTH_PX,
          pickId: record.id,
        });
    }
    outlines.replace(items);
  }

  function clearSelectionFill() {
    if (fill && fillKey !== null) {
      fill.replace([]);
      fill.commit();
    }
    fillKey = null;
  }

  /**
   * The selected site's footprints, draped on the 3D tiles while they show
   * (the globe is hidden then), else on terrain and tiles.
   */
  function syncSelectionFill() {
    const record =
      initialized && state.enabled && state.recordById.get(state.selectedId);
    if (!record) {
      clearSelectionFill();
      return;
    }
    const drape = engine.maps.photorealActive() ? 'tiles' : 'both';
    const key = `${record.id}|${installationRenderKey(record)}|${drape}`;
    if (key === fillKey) return;
    clearSelectionFill();
    fillKey = key;
    if (!fill || fillDrape !== drape) {
      fill?.destroy();
      fill = engine.ground.createSet({
        id: SELECTION_FILL_SET_ID,
        kind: 'polygon',
        order: SELECTION_FILL_ORDER,
        pickable: true,
        drape,
      });
      fillDrape = drape;
    }
    const color = colorOf(record).withAlpha(SELECTION_FILL_ALPHA).rgba();
    fill.replace(
      footprintsOf(record).map((rings) => ({
        rings,
        fill: color,
        pickId: record.id,
      })),
    );
    fill.commit();
    governorRequestRender('installation-selection-fill', engine);
  }

  function clearRendered() {
    clearSelectionFill();
    handles.clear();
    drawn = [];
    outlineSignature = '';
    if (initialized) {
      paintMarkers();
      outlines.clear();
    }
    removeEntityContextsForLayer(LAYER_ID);
  }

  /**
   * The records drawn this paint: the nearest `MAX_RENDERED`, plus the
   * selected one when it falls outside that window.
   *
   * Context navigation walks the FULL nearby cohort, which is not bounded by
   * the render cap, so an item past it had no handle at all: the camera flew,
   * the selection was silently dropped, and the Context subject stayed stale
   * so NEXT offered the same installation forever. One extra handle keeps
   * every cohort item selectable and the cohort count honest.
   * @returns {Array<object>} Records to render this paint.
   */
  function renderableRecords() {
    const rendered = state.records
      .filter((r) => !r.pointOnly)
      .slice(0, MAX_RENDERED);
    if (!state.selectedId) return rendered;
    if (rendered.some((record) => record.id === state.selectedId))
      return rendered;
    const chosen = state.recordById.get(state.selectedId);
    return chosen ? [...rendered, chosen] : rendered;
  }

  function contextOf(record) {
    return {
      id: record.id,
      layerId: LAYER_ID,
      layerName:
        record.kind === 'place_candidate'
          ? 'Military Site Search Candidates'
          : 'Mapped Military Installations',
      source: parts.model.installationSourceLabel(record),
      label: record.name,
      latitude: record.latitude,
      longitude: record.longitude,
      properties: {
        class: record.class,
        memberNames: record.memberNames || [],
        primaryType: record.primaryType || null,
        placeTypes: Array.isArray(record.placeTypes) ? record.placeTypes : [],
        validation: record.validation,
        retrievedAt: record.retrievedAt,
      },
    };
  }

  /** A drawn site's context handle, with what the readouts read of it. */
  function createHandle(record, key, heightM) {
    const handle = {
      id: record.id,
      key,
      record,
      heightM,
      position: positionAt(record, heightM),
      gevTrackedId: `installations:${record.id}`,
      gevLabelModel: {
        title: installationTitle(record.name) || t('MAPPED INSTALLATION'),
        details: [
          installationClassLabel(record.class),
          ...(record.memberNames || []).slice(0, 3),
        ],
        accent: installationAccent(record),
      },
    };
    handle.gevDisplayPosition = () => handle.position;
    registerEntityContext(handle, contextOf(record));
    return handle;
  }

  function renderRecords({ claimSelection = false } = {}) {
    if (!initialized) return;
    // Context navigation can select another layer without a canvas click.
    // A delayed floor/data repaint must not steal that newer selection back.
    selection.reconcile({ claimSelection });
    let migratedSelection = false;
    if (state.selectedId && !state.recordById.has(state.selectedId)) {
      const replacement = state.records.find((record) =>
        record.aliasIds?.includes(state.selectedId),
      );
      if (replacement) {
        state.selectedId = replacement.id;
        migratedSelection = true;
      }
    }
    // Post-moveEnd debounced fetches commit after the camera settles; the
    // rebuilt sets need one frame in idle mode.
    governorRequestRender('installations-render', engine);
    syncOsmCredit(state.records);
    syncPlacesCredit(state.records);
    const records = renderableRecords();
    const keys = new Map(
      records.map((record) => [record.id, installationRenderKey(record)]),
    );
    for (const [id, handle] of [...handles])
      if (keys.get(id) !== handle.key) handles.delete(id);
    drawn = records.map((record) => {
      const heightM = parts.model.installationSurfaceHeightM(record);
      const handle = handles.get(record.id);
      if (!handle) {
        const created = createHandle(record, keys.get(record.id), heightM);
        handles.set(record.id, created);
        return created;
      }
      // Same geometry: the disc moves to its floor in place.
      handle.record = record;
      if (handle.heightM !== heightM) {
        handle.heightM = heightM;
        handle.position = positionAt(record, heightM);
      }
      return handle;
    });
    paintMarkers();
    paintOutlines();
    const chosen = state.selectedId ? handles.get(state.selectedId) : null;
    if (chosen && (claimSelection || migratedSelection))
      selectEntityContext(chosen);
    else if (!chosen) state.selectedId = null;
    // Re-register rebuilt geometry and migrate aliases before pruning old context.
    removeEntityContextsForLayer(LAYER_ID, { retainIds: new Set(keys.keys()) });
    namedMarkers.sync(state.records);
    syncSelectionFill();
  }

  /**
   * Second paint for floors that missed the bounded pre-render deadline.
   *
   * `resolveGroundFloorCellsBounded` gives up after FLOOR_RESOLVE_DEADLINE_MS so
   * a cold DEM can never hold the dots hostage, but the resolve keeps running
   * and lands seconds later; without this the records it covers stay pinned
   * at ellipsoid height 0, visibly under the 3D tiles.
   *
   * The trigger is whether a cell that was COLD AT PAINT TIME is warm now,
   * not whether this batch warmed it: the bounded resolve is still running
   * against the same cells and usually wins the race. Still terminating: a
   * set that is wholly cold afterwards re-renders zero times and the next
   * camera-driven load retries.
   * @param {Array<object>} records Records just rendered.
   * @returns {void}
   */
  function warmInstallationFloors(records) {
    const { cachedGroundFloor } = services.ground;
    const cold = records
      .filter(
        (record) =>
          cachedGroundFloor(record.latitude, record.longitude) == null,
      )
      .map((record) => ({ lat: record.latitude, lon: record.longitude }));
    if (!cold.length) return;
    const epoch = generation;
    services.anchors.warmFireAnchorFloors(cold).then(() => {
      if (!state.enabled || !initialized || epoch !== generation) return;
      if (
        !cold.some((point) => cachedGroundFloor(point.lat, point.lon) != null)
      )
        return;
      renderRecords();
    });
  }

  function syncContextSelection(event) {
    if (!state.enabled) return;
    // Tracking layers publish this event before replacing the shared context.
    const current =
      event?.type === 'gev:awareness-subject-selected'
        ? event.detail
        : getSelectedEntityContext();
    const next =
      current?.layerId === LAYER_ID && state.recordById.has(current.id)
        ? current.id
        : null;
    if (next === state.selectedId) return;
    state.selectedId = next;
    renderRecords();
  }

  function selectRecord(id) {
    if (!state.recordById.has(id) || !initialized) return false;
    state.selectedId = id;
    renderRecords({ claimSelection: true });
    // renderRecords drops selectedId when the record got no handle.
    return state.selectedId === id;
  }

  const selection = createSelectionKeeper({
    state,
    getSelectedEntityContext,
    selectRecord,
    clearSelection() {
      state.selectedId = null;
      clearSelectedEntityContextForLayer(LAYER_ID);
      renderRecords();
    },
  });
  const onClick = selection.onClick;

  function installInteraction() {
    if (removeClick) return;
    for (const type of CONTEXT_EVENTS)
      globalThis.window?.addEventListener?.(type, syncContextSelection);
    removeContextListeners = () => {
      for (const type of CONTEXT_EVENTS)
        globalThis.window?.removeEventListener?.(type, syncContextSelection);
    };
    removeClick = engine.input.on('click', onClick, { pick: true });
  }

  function destroyInteraction() {
    removeContextListeners?.();
    removeContextListeners = null;
    removeClick?.();
    removeClick = null;
  }

  function setVisible(next) {
    visible = next;
    paintMarkers();
    outlines?.show(next);
  }

  const methods = {
    init() {
      if (initialized)
        throw new Error('Installations display is already initialized');
      state.engine = engine;
      normal = createMarkerSet(
        MARKER_SET_ID,
        MARKER_SIZE_PX,
        MAX_RENDERED + 1,
        MARKER_ORDER,
      );
      selected = createMarkerSet(
        SELECTED_MARKER_SET_ID,
        SELECTED_MARKER_SIZE_PX,
        1,
        SELECTED_MARKER_ORDER,
      );
      outlines = createSteadyGroundSet(engine, {
        id: OUTLINE_SET_ID,
        kind: 'corridor',
        order: OUTLINE_ORDER,
        pickable: true,
      });
      outlines.show(false);
      initialized = true;
      const cameraChanged = () => {
        if (!state.contextAnchor) parts.viewport.scheduleLoad();
      };
      state.moveEndRemove =
        engine.camera.moveEnd.addEventListener(cameraChanged);
      state.changedRemove =
        engine.camera.changed.addEventListener(cameraChanged);
      installInteraction();
    },

    enable() {
      state.enabled = true;
      state.surfaceChangedRemove ||=
        services.maps?.subscribeMapStack(syncSelectionFill);
      // Cached markers and geometry become visible before the next fetch.
      if (
        state.records?.some((r) =>
          r.sources?.some((s) => s.name === 'OpenStreetMap'),
        )
      )
        syncOsmCredit(state.records);
      namedMarkers.enable();
      namedMarkers.sync(state.records || []);
      claimCameraSensitivity(engine, LAYER_ID, 0.01);
      services.picking.registerPickOwner(
        LAYER_ID,
        (id) => state.recordById.has(id),
        engine,
      );
      setVisible(true);
      // The layer manager calls update() right after enable(), which owns
      // the first fetch. A second, aborting request here would race it.
    },

    disable() {
      state.enabled = false;
      services.credits?.hideOsmCredit?.(engine, LAYER_ID);
      services.credits?.hideGooglePlacesCredit?.(engine, LAYER_ID);
      namedMarkers.hide();
      releaseCameraSensitivity(engine, LAYER_ID);
      state.contextAnchor = null;
      state.contextPosition = null;
      state.coverage = { kind: 'viewport' };
      state.cameraLoadKey = null;
      state.cameraLoadOwner = null;
      services.picking.unregisterPickOwner(LAYER_ID, engine);
      parts.viewport.clearUnavailableRetry();
      clearTimeout(state.timer);
      state.abort?.abort();
      state.abort = null;
      state.loading = false;
      setVisible(false);
      clearSelectedEntityContextForLayer(LAYER_ID);
      state.selectedId = null;
      clearSelectionFill();
      state.surfaceChangedRemove?.();
      state.surfaceChangedRemove = null;
      state.failureReason = null;
      parts.ingestion.setInstallationStatus('idle');
    },

    destroy() {
      source.destroy?.();
      this.disable();
      this.detach();
    },

    detach() {
      services.credits?.hideOsmCredit?.(engine, LAYER_ID);
      services.credits?.hideGooglePlacesCredit?.(engine, LAYER_ID);
      services.picking.unregisterPickOwner(LAYER_ID, engine);
      releaseCameraSensitivity(engine, LAYER_ID);
      state.surfaceChangedRemove?.();
      state.surfaceChangedRemove = null;
      state.moveEndRemove?.();
      state.changedRemove?.();
      state.moveEndRemove = state.changedRemove = null;
      destroyInteraction();
      namedMarkers.destroy();
      clearRendered();
      generation++;
      if (initialized) {
        normal.destroy();
        selected.destroy();
        outlines.destroy();
        fill?.destroy();
      }
      normal = selected = outlines = fill = null;
      fillDrape = null;
      initialized = false;
      visible = false;
      state.engine = null;
    },
  };

  return {
    ...methods,
    namedMarkers,
    installationSurfaceHeightM: parts.model.installationSurfaceHeightM,
    clearSelectionFill,
    syncSelectionFill,
    clearRendered,
    renderableRecords,
    renderRecords,
    warmInstallationFloors,
    selectRecord,
    installInteraction,
    destroyInteraction,
  };
}
