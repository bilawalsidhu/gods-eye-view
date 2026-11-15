import * as Cesium from 'cesium';
import { formatNumber, msg, t } from '../../i18n/index.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  claimCameraSensitivity,
  releaseCameraSensitivity,
} from '../../data/cameraSensitivity.js';
import {
  clearSelectedEntityContextForLayer,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
} from '../../data/contextStore.js';
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
 * { records, total, limited }.
 */
export function createUsGroundwaterLayer({
  source,
  picking,
  recordUi = {},
  requestRender,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('A well source is required');
  let viewer;
  let dataSource;
  let clickHandler;
  let enabled = false;
  let request; // the load in flight
  let timer; // a load scheduled while the camera moves
  let loaded = null; // { bounds, limited } of the last finished load
  let total = null; // records in the release
  let error = null;
  let lastUpdate = null;
  let cardColumns = 68;
  let listed = '';
  const records = new Map(); // entity id → record
  const listeners = [];

  const near = () =>
    (viewer?.camera.positionCartographic?.height ?? Infinity) <=
    WELL_DETAIL_HEIGHT;
  const render = (reason) =>
    typeof requestRender === 'function'
      ? requestRender(reason)
      : viewer?.scene?.requestRender?.();
  const isWell = (entity) => records.has(entity?.id);
  const viewBounds = () => {
    const r = viewer.camera.computeViewRectangle();
    return r
      ? [r.west, r.south, r.east, r.north].map(Cesium.Math.toDegrees)
      : null;
  };

  function clearSelection() {
    if (!isWell(viewer?.selectedEntity)) return;
    viewer.selectedEntity = undefined;
    clearSelectedEntityContextForLayer(WELL_LAYER_ID);
    render('well-clear-selection');
  }

  function select(entity) {
    if (!enabled || !isWell(entity) || !near()) return false;
    entity.gevAnchorToGround();
    viewer.selectedEntity = entity;
    selectEntityContext(entity);
    render('well-select');
    return true;
  }
  const picker = createRecordPicker(select, recordUi.publishChoices);

  /** Tell the keyboard record list which markers are on screen. */
  function publishList() {
    if (typeof recordUi.publishRecords !== 'function') return;
    const shown =
      enabled && near()
        ? recordsOnScreen(viewer, dataSource.entities.values)
        : [];
    const next = shown.map((entity) => entity.id).join('|');
    if (next === listed) return;
    listed = next;
    recordUi.publishRecords(
      shown.length
        ? {
            records: shown.map((entity) => ({
              id: entity.id,
              label: entity.name,
            })),
            focus(id, focused) {
              const entity = dataSource?.entities.getById(id);
              if (entity?.billboard) entity.billboard.scale = focused ? 1.8 : 1;
              render('well-focus');
            },
            focusMap() {
              const canvas = viewer.scene.canvas;
              if (typeof canvas?.focus !== 'function') return;
              canvas.tabIndex = 0;
              canvas.focus();
            },
            select(id) {
              select(dataSource?.entities.getById(id));
            },
          }
        : null,
    );
  }

  function addMarker(id, record) {
    const position = Cesium.Cartesian3.fromDegrees(
      record.longitude,
      record.latitude,
    );
    const entity = dataSource.entities.add({
      id,
      name: wellLabel(record),
      position,
      // Explicit size: a pooled billboard must not inherit another symbol's.
      billboard: {
        image: WELL_MARKER_IMAGE,
        width: 12,
        height: 12,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    // The card hangs from the ground under the marker, sampled on selection.
    // It is a visual anchor only, never a water level.
    let anchor = position;
    entity.gevDisplayPosition = () => anchor;
    entity.gevAnchorToGround = () => {
      const height = viewer.scene.globe?.getHeight?.(
        Cesium.Cartographic.fromDegrees(record.longitude, record.latitude),
      );
      anchor = Cesium.Cartesian3.fromDegrees(
        record.longitude,
        record.latitude,
        Number.isFinite(height) ? height : 0,
      );
    };
    // Built when read, so the card follows the UI language and canvas width.
    Object.defineProperty(entity, 'gevLabelModel', {
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
    registerEntityContext(entity, {
      id,
      layerId: WELL_LAYER_ID,
      // i18n-ignore -- context data; the panel translates the layer name.
      layerName: 'Water Wells',
      // i18n-ignore -- Provider brand.
      source: 'Rainfolk',
      dataSource,
      label: entity.name,
      properties: { ...record },
      latitude: record.latitude,
      longitude: record.longitude,
    });
    records.set(id, record);
  }

  /** Make the map show exactly `next`, keeping markers that are already there. */
  function show(next) {
    const keep = new Set();
    dataSource.entities.suspendEvents();
    for (const record of next) {
      const id = `${WELL_LAYER_ID}:${record.id}`;
      keep.add(id);
      if (!records.has(id)) addMarker(id, record);
    }
    let removed = false;
    for (const id of [...records.keys()]) {
      if (keep.has(id)) continue;
      if (viewer.selectedEntity?.id === id) viewer.selectedEntity = undefined;
      dataSource.entities.removeById(id);
      records.delete(id);
      removed = true;
    }
    dataSource.entities.resumeEvents();
    if (removed) {
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
    if (dataSource.show !== visible) {
      dataSource.show = visible;
      if (!visible) {
        clearSelection();
        picker.close();
      }
      publishList();
    }
    const columns = wellCardColumns(viewer.scene.canvas?.clientWidth);
    if (columns === cardColumns) return;
    cardColumns = columns;
    if (isWell(viewer.selectedEntity))
      selectEntityContext(viewer.selectedEntity);
  }

  function onClick(event) {
    if (!enabled || !isPointerFree()) return;
    const picked = viewer.scene.pick(event.position);
    const hit = picked?.id;
    // The ring is hollow, so a click on its middle picks nothing: also take
    // wells within a few pixels, but never over another layer's object.
    if (near() && (isWell(hit) || !picked)) {
      const candidates = recordsAtPixel(
        viewer,
        dataSource.entities.values,
        event.position,
      );
      if (candidates.length || isWell(hit)) {
        picker.choose(candidates.length ? candidates : [hit]);
        return;
      }
    }
    if (!picked) clearSelection();
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
      if (!dataSource) {
        dataSource = new Cesium.CustomDataSource(WELL_LAYER_ID);
        void viewer.dataSources.add(dataSource);
      }
      dataSource.show = near();
      cardColumns = wellCardColumns(viewer.scene.canvas?.clientWidth);
      // camera.changed fires at 5% view changes (Cesium's default is 50%), so
      // the view refreshes during a long move, not only when it ends.
      claimCameraSensitivity(viewer.camera, WELL_LAYER_ID, 0.05);
      listeners.push(
        viewer.camera.changed.addEventListener(() => {
          if (timer || request) return;
          timer = setTimeout(() => void refresh(), 200);
        }),
        viewer.camera.moveEnd.addEventListener(() => void refresh()),
        viewer.scene.preRender.addEventListener(beforeFrame),
      );
      // Own clicks on well markers, so a layer that treats an unowned pick as
      // empty space (a tracked flight) leaves the selection alone.
      picking?.registerPickOwner?.(WELL_LAYER_ID, (id) => records.has(id));
      clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      clickHandler.setInputAction(
        onClick,
        Cesium.ScreenSpaceEventType.LEFT_CLICK,
      );
      return true;
    },

    disable() {
      if (!enabled) return;
      enabled = false;
      request?.abort();
      request = undefined;
      clearTimeout(timer);
      timer = undefined;
      for (const remove of listeners.splice(0)) remove();
      releaseCameraSensitivity(viewer.camera, WELL_LAYER_ID);
      picking?.unregisterPickOwner?.(WELL_LAYER_ID);
      clickHandler?.destroy();
      clickHandler = undefined;
      picker.close();
      show([]);
      dataSource.show = false;
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
      if (dataSource) viewer.dataSources.remove(dataSource, true);
      dataSource = undefined;
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
        visible: enabled && near() ? records.size : 0,
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
