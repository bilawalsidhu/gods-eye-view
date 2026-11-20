import { formatNumber, msg, t } from '../../i18n/index.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  clearSelectedEntityContextForLayer,
  getContextStore,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
} from '../../data/contextStore.js';
import { entityRecord } from '../../data/entityRecords.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { inputFor } from '../../input/dispatcher.js';
import { heightsOf } from '../../queries/heights.js';
import {
  canvasOf,
  drawOf,
  findCamera,
  findFrame,
  findQuery,
} from '../../render/rendererOf.js';
import {
  createRecordPicker,
  recordsAtPixel,
  recordsOnScreen,
} from './recordPicker.js';
import {
  wellCardColumns,
  wellCardLines,
  wellLabel,
  wrapWellCardLine,
} from './wellCard.js';
import { coversViewport } from './viewportCoverage.js';

export const WELL_LAYER_ID = 'us-groundwater';
/** Above this camera height nothing is loaded or drawn. */
export const WELL_DETAIL_HEIGHT = 50000;
const WELL_COLOR = '#f5b942';
/** Hollow amber ring: where a historical record says a well is, not a surveyed well. */
const WELL_MARKER_IMAGE =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill="none" stroke="${WELL_COLOR}" stroke-width="2"/></svg>`,
  );

/**
 * Water Wells: historical well records near the camera, from an injected
 * source whose getSnapshot({ signal, bounds }) resolves
 * { records, total, limited }. The markers are one renderer icon set, made
 * when the layer is first turned on.
 */
export function createUsGroundwaterLayer({
  source,
  picking,
  recordUi = {},
  requestRender,
  // The clicks on the globe: the application's input dispatcher.
  input = (viewer) => inputFor(viewer),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('A well source is required');
  let viewer;
  let markers; // the icon set, one item per record
  let enabled = false;
  let request; // the load in flight
  let timer; // a load scheduled while the camera moves
  let loaded = null; // { bounds, limited } of the last finished load
  let total = null; // records in the release
  let error = null;
  let lastUpdate = null;
  let cardColumns = 68;
  let listed = '';
  const wells = new Map(); // marker id → well
  const listeners = [];

  const near = () =>
    (findCamera(viewer)?.pose().height ?? Infinity) <= WELL_DETAIL_HEIGHT;
  const render = (reason) =>
    typeof requestRender === 'function'
      ? requestRender(reason)
      : findFrame(viewer)?.requestRender(reason);
  const viewBounds = () => {
    const r = findCamera(viewer)?.viewRectangle();
    return r ? [r.west, r.south, r.east, r.north] : null;
  };
  /**
   * Where a well's marker stands: on the terrain, where its height is loaded.
   * The marker is clamped to the ground, so a well placed on the ellipsoid
   * would be found some pixels away from its marker over high ground.
   */
  const groundOf = (well) => {
    const { longitude, latitude } = well.record;
    const height = heightsOf(viewer).now(
      { lon: longitude, lat: latitude },
      { against: 'terrain' },
    );
    return height === null
      ? well.position
      : fromDegrees(longitude, latitude, height);
  };
  /** Where a well's marker is on the canvas, or null off screen. */
  const project = (well) => findQuery(viewer)?.project(groundOf(well)) ?? null;
  /** The well the shared selection holds, if it holds one of ours. */
  const selectedWell = () => {
    const store = getContextStore();
    const selected = store.entities.get(store.selectedEntityId);
    return selected?.layerId === WELL_LAYER_ID ? selected.entity : null;
  };
  const markerOf = (well) => ({
    id: well.id,
    pos: well.position,
    image: WELL_MARKER_IMAGE,
    size: [12, 12],
    scale: well.focused ? 1.8 : 1,
    height: 'clampGround',
    disableDepthTest: Number.POSITIVE_INFINITY,
  });

  function clearSelection() {
    if (!selectedWell()) return;
    clearSelectedEntityContextForLayer(WELL_LAYER_ID);
    render('well-clear-selection');
  }

  function select(well) {
    if (!enabled || !wells.has(well?.id) || !near()) return false;
    // The card hangs from the ground under the marker, sampled on selection.
    // It is a visual anchor only, never a water level.
    well.anchor = groundOf(well);
    selectEntityContext(well);
    render('well-select');
    return true;
  }
  const picker = createRecordPicker(select, recordUi.publishChoices);

  /** Tell the keyboard record list which markers are on screen. */
  function publishList() {
    if (typeof recordUi.publishRecords !== 'function') return;
    const shown =
      enabled && near()
        ? recordsOnScreen(project, wells.values(), canvasOf(viewer))
        : [];
    const next = shown.map((well) => well.id).join('|');
    if (next === listed) return;
    listed = next;
    recordUi.publishRecords(
      shown.length
        ? {
            records: shown.map((well) => ({ id: well.id, label: well.name })),
            focus(id, focused) {
              const well = wells.get(id);
              if (well) {
                well.focused = focused;
                markers?.upsert([markerOf(well)]);
              }
              render('well-focus');
            },
            focusMap() {
              const canvas = canvasOf(viewer);
              if (typeof canvas?.focus !== 'function') return;
              canvas.tabIndex = 0;
              canvas.focus();
            },
            select(id) {
              select(wells.get(id));
            },
          }
        : null,
    );
  }

  function addWell(id, record) {
    const position = fromDegrees(record.longitude, record.latitude);
    const well = {
      id,
      name: wellLabel(record),
      record,
      position,
      anchor: position,
      focused: false,
    };
    const card = entityRecord(well);
    card.displayPosition = () => well.anchor;
    // Built when read, so the card follows the UI language and canvas width.
    Object.defineProperty(card, 'labelModel', {
      get: () => ({
        title: t('Water well record'),
        details: wellCardLines(record).flatMap((line) =>
          wrapWellCardLine(line, cardColumns),
        ),
        accent: WELL_COLOR,
        cardStyle: 'tactical',
        selected: true,
        verticalOnly: false,
        anchorRadiusPx: 5,
        anchorRadiusScale: null,
      }),
    });
    registerEntityContext(well, {
      id,
      layerId: WELL_LAYER_ID,
      // i18n-ignore -- context data; the panel translates the layer name.
      layerName: 'Water Wells',
      // i18n-ignore -- Provider brand.
      source: 'Rainfolk',
      // Hidden with the markers: the context store reads its `show`.
      dataSource: markers,
      label: well.name,
      properties: { ...record },
      latitude: record.latitude,
      longitude: record.longitude,
    });
    wells.set(id, well);
    return well;
  }

  /** Make the map show exactly `next`, keeping markers that are already there. */
  function show(next) {
    const keep = new Set();
    const added = [];
    for (const record of next) {
      const id = `${WELL_LAYER_ID}:${record.id}`;
      keep.add(id);
      if (!wells.has(id)) added.push(markerOf(addWell(id, record)));
    }
    const removed = [...wells.keys()].filter((id) => !keep.has(id));
    for (const id of removed) wells.delete(id);
    if (added.length) markers.upsert(added);
    if (removed.length) {
      markers.remove(removed);
      picker.close();
      // Also clears the shared selection when its record left the view.
      removeEntityContextsForLayer(WELL_LAYER_ID, { retainIds: keep });
    }
    publishList();
    render('well-draw');
  }

  /** Load the current view, unless what is loaded already covers it. */
  async function refresh() {
    clearTimeout(timer);
    timer = undefined;
    if (!enabled) return;
    // Above the gate nothing is drawn: fetch only the release total, once.
    if (!near() && total !== null) return;
    const bounds = near() ? viewBounds() : null;
    if (loaded && !loaded.limited && coversViewport(loaded.bounds, bounds)) {
      publishList();
      return;
    }
    request?.abort();
    const mine = new AbortController();
    request = mine;
    try {
      const snapshot = await source.getSnapshot({
        signal: mine.signal,
        bounds,
      });
      if (request !== mine || !enabled) return;
      total = snapshot.total;
      loaded = { bounds, limited: snapshot.limited };
      error = null;
      lastUpdate = Date.now();
      show(snapshot.limited ? [] : snapshot.records);
    } catch (failure) {
      if (request !== mine || !enabled) return;
      console.warn('[Data:WaterWells] Load failed:', failure);
      loaded = null;
      error =
        failure?.name === 'WellIntegrityError'
          ? msg('Water Wells data failed its integrity check')
          : msg('Water Wells data is unavailable');
    } finally {
      if (request === mine) {
        request = undefined;
        render('well-status');
      }
    }
  }

  /** Per frame: apply the height gate and re-wrap an open card on resize. */
  function beforeFrame() {
    const visible = near();
    if (markers.show !== visible) {
      // The card closes first: the selection of a hidden set reads as gone.
      if (!visible) {
        clearSelection();
        picker.close();
      }
      markers.show = visible;
      publishList();
    }
    const columns = wellCardColumns(canvasOf(viewer)?.clientWidth);
    if (columns === cardColumns) return;
    cardColumns = columns;
    const selected = selectedWell();
    if (selected) selectEntityContext(selected);
  }

  function onClick(click) {
    if (!enabled || !isPointerFree()) return;
    // Another layer's card painted on top takes the click.
    if (picking?.isUnderOtherCard?.(click)) return;
    const hit = click.topHit;
    const empty = !hit || hit.surface;
    const own =
      !empty && hit.set === markers.id ? wells.get(hit.id) : undefined;
    // The ring is hollow, so a click on its middle picks nothing: also take
    // wells within a few pixels, but never over another layer's object.
    if (near() && (own || empty)) {
      const candidates = recordsAtPixel(
        project,
        wells.values(),
        click.position,
      );
      if (candidates.length || own) {
        picker.choose(candidates.length ? candidates : [own]);
        return;
      }
    }
    if (empty) clearSelection();
  }

  /** The globe's clicks; a viewer with no renderer input bound takes none. */
  function clicks() {
    try {
      return input(viewer) ?? null;
    } catch {
      return null;
    }
  }

  const layer = {
    id: WELL_LAYER_ID,
    name: 'Water Wells',
    icon: '🪣',
    // i18n-ignore -- Provider brand.
    source: 'Rainfolk',
    updateInterval: 0,

    init(nextViewer) {
      if (viewer) throw new Error('Water Wells layer is already initialized');
      viewer = nextViewer;
    },

    enable() {
      if (!viewer) throw new Error('Water Wells layer is not initialized');
      if (enabled) return true;
      enabled = true;
      error = null;
      // Translucent: the ring's edge is antialiased. Explicit sizes per item.
      markers ??= drawOf(viewer).icons({
        id: `${WELL_LAYER_ID}:markers`,
        blend: 'translucent',
      });
      markers.show = near();
      cardColumns = wellCardColumns(canvasOf(viewer)?.clientWidth);
      const camera = findCamera(viewer);
      listeners.push(
        // Its own 5% threshold (the default is 50%), so the view refreshes
        // during a long move, not only when it ends.
        camera?.on(
          'changed',
          () => {
            if (timer || request) return;
            timer = setTimeout(() => void refresh(), 200);
          },
          { threshold: 0.05 },
        ),
        camera?.on('moveEnd', () => void refresh()),
        findFrame(viewer)?.on('preRender', beforeFrame),
        clicks()?.onClick(onClick),
      );
      // Own clicks on well markers, so a layer that treats an unowned pick as
      // empty space (a tracked flight) leaves the selection alone.
      picking?.registerPickOwner?.(WELL_LAYER_ID, (id) => wells.has(id));
      return true;
    },

    disable() {
      if (!enabled) return;
      enabled = false;
      request?.abort();
      request = undefined;
      clearTimeout(timer);
      timer = undefined;
      for (const remove of listeners.splice(0)) remove?.();
      picking?.unregisterPickOwner?.(WELL_LAYER_ID);
      picker.close();
      show([]);
      markers.show = false;
      loaded = null;
    },

    /** The manager's first load after enable(); camera moves load from then on. */
    async update() {
      if (!enabled) return false;
      await refresh();
      return enabled && !error;
    },

    destroy() {
      if (!viewer) return;
      layer.disable();
      markers?.dispose();
      markers = undefined;
      viewer = undefined;
    },

    getStats() {
      const zoomedOut = enabled && !near();
      const tooMany =
        enabled && !zoomedOut && Boolean(loaded?.limited && loaded.bounds);
      return {
        count: total ?? 0,
        // Millions of records: "12.5M" rather than the panel's "12452.3K".
        countLabel:
          total === null
            ? undefined
            : formatNumber(total, {
                notation: 'compact',
                maximumFractionDigits: 1,
              }),
        visible: enabled && near() ? wells.size : 0,
        error,
        lastUpdate,
        loading: Boolean(request || timer),
        status: zoomedOut || tooMany ? 'zoom-in' : undefined,
        statusMessage: zoomedOut
          ? msg('Zoom in to see wells')
          : tooMany
            ? msg('Too many wells in this view; zoom in closer')
            : undefined,
      };
    },
  };
  return layer;
}
