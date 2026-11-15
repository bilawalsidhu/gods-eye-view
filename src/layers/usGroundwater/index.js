import { createRecordPicker, recordsAtPixel } from './recordPicker.js';
import * as Cesium from 'cesium';
import { msg } from '../../i18n/marker.js';
import { validateCountView } from './countGrids.js';
import {
  createVisibleRecords,
  WELL_MARKER_IMAGE,
  WELL_DETAIL_HEIGHT,
} from './visibleRecords.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  wrapWellCardLine,
  wellCardColumns,
  wellRecordLabel,
  wellDisplayName,
  historicalWellCardLines,
} from './wellCard.js';
import { coversViewport } from './viewportCoverage.js';
import {
  claimCameraSensitivity,
  releaseCameraSensitivity,
} from '../../data/cameraSensitivity.js';
import {
  clearSelectedEntityContextForLayer,
  getContextStore,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
} from '../../data/contextStore.js';
import { validateWellPack } from './pack.js';
import { historicalWellDetails } from './historicalPack.mjs';

/** A portable, injected well layer using GEV's layer lifecycle. */
export function createUsGroundwaterLayer({
  source,
  onSelect = () => {},
  onStatus = () => {},
  recordUi = {},
  requestRender,
  picking,
  // Host number formatting (locale-aware in the app); the layer stays i18n-free.
  formatCount = (n) => String(n),
  validatePack = validateWellPack,
  describeWell = historicalWellDetails,
  sourceLabel = source?.label ?? 'Rainfolk',
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('A well pack source is required');
  let viewer;
  let visibleRecords;
  const validateView = (value) =>
    value?.kind === 'gev-well-count-view'
      ? validateCountView(value)
      : validatePack(value);
  const requestFrame =
    typeof requestRender === 'function'
      ? requestRender
      : () => viewer?.scene?.requestRender?.();
  let enabled = false;
  let destroyed = false;
  let controller;
  let pending;
  let initialRevision = 0;
  let initialRequest;
  let pack;
  let lastCheckedAt = null;
  let dataSource;
  let attached = false;
  let clickHandler;
  let removeCamera;
  let removeCameraChanged;
  let viewportTimer;
  let removeReadyFrame;
  let removePresentationFrame;
  let cardColumns = 68;
  let error = null;
  let visible = 0;
  let viewController;
  let viewGeneration = 0;
  const COUNT_BUDGET = 4096;
  const viewBounds = () => {
    const r = viewer.camera.computeViewRectangle();
    return r
      ? [r.west, r.south, r.east, r.north].map(Cesium.Math.toDegrees)
      : null;
  };
  async function refreshViewport() {
    if (!enabled || destroyed) return;
    const generation = ++viewGeneration;
    viewController?.abort();
    const active = new AbortController();
    viewController = active;
    const bounds = viewBounds();
    status();
    try {
      const next = validateView(
        await source.getSnapshot({
          signal: active.signal,
          bounds,
          countBudget: COUNT_BUDGET,
        }),
      );
      if (
        active.signal.aborted ||
        generation !== viewGeneration ||
        !coversViewport(bounds, viewBounds()) ||
        !enabled ||
        destroyed
      )
        return;
      pack = next;
      lastCheckedAt = Date.now();
      error = null;
      if (!attached) await attach();
      else draw();
    } catch (failure) {
      if (
        !active.signal.aborted &&
        generation === viewGeneration &&
        enabled &&
        !destroyed
      ) {
        error = failure?.message ?? msg('Source unavailable');
        clearWellSelection();
        status();
      }
    } finally {
      if (viewController === active) {
        viewController = undefined;
        status();
      }
    }
  }
  const recordsByEntity = new Map();
  function clearWellSelection() {
    if (!recordsByEntity.has(viewer?.selectedEntity?.id)) return;
    viewer.selectedEntity = undefined;
    if (hasContextHost()) clearSelectedEntityContextForLayer('us-groundwater');
    onSelect(null);
  }
  function selectWell(entity) {
    const record = recordsByEntity.get(entity?.id);
    if (
      !enabled ||
      !attached ||
      !record ||
      (viewer.camera.positionCartographic?.height ?? Infinity) >
        WELL_DETAIL_HEIGHT
    )
      return false;
    entity.gevUpdateWellAnchor();
    viewer.selectedEntity = entity;
    if (hasContextHost()) selectEntityContext(entity);
    onSelect(describeWell(record));
    status();
    requestFrame('well-select');
    return true;
  }
  const recordPicker = createRecordPicker(selectWell, recordUi.publishChoices);
  const hasContextHost = () => typeof window !== 'undefined';
  const counted = () => pack?.kind === 'gev-well-count-view';
  const representedCount = () =>
    counted()
      ? pack.cells.reduce((n, c) => n + c.count, 0)
      : (pack?.records.length ?? 0);
  const catalogCount = () =>
    counted()
      ? pack.total
      : Number.isSafeInteger(pack?.catalogTotal) && pack.catalogTotal >= 0
        ? pack.catalogTotal
        : null;
  const stats = () => ({
    count: catalogCount() ?? 0,
    catalogCount: catalogCount(),
    countLabel: Number.isSafeInteger(catalogCount())
      ? formatCount(catalogCount())
      : undefined,
    // Intersecting whole cells are not an exact viewport count. OFF represents none.
    representedLocationCount: enabled && attached ? representedCount() : 0,
    visible,
    error,
    // Incomplete coverage is a property of the data, not a failing feed.
    coverage: counted()
      ? 'Whole-cell record counts; partial source coverage; empty areas unknown'
      : (pack?.coverage.description ?? null),
    mode: 'snapshot',
    coverageComplete: false,
    acquisitions: pack?.acquisitions ?? [],
    lastCheckedAt,
    lastUpdate: lastCheckedAt,
    referenceRetrievedAt:
      pack?.referenceRetrievedAt ??
      pack?.acquisitions?.[0]?.retrievedAt ??
      null,
    displayMode: counted() ? 'limited-detail' : 'records',
    status: counted() && pack.cells.length ? 'zoom-in' : undefined,
    statusMessage:
      enabled && attached && counted() && pack.cells.length
        ? msg('Detail limited; some records not shown')
        : undefined,
    loading: Boolean(pending || viewController || viewportTimer),
  });
  const status = () => onStatus(stats());
  function release() {
    recordPicker.close();
    if (recordsByEntity.has(viewer?.selectedEntity?.id))
      viewer.selectedEntity = undefined;
    visibleRecords?.clear();
    attached = false;
    picking?.unregisterPickOwner?.('us-groundwater');
    removeReadyFrame?.();
    removeReadyFrame = undefined;
    removePresentationFrame?.();
    removePresentationFrame = undefined;
    removeCamera?.();
    removeCamera = undefined;
    removeCameraChanged?.();
    removeCameraChanged = undefined;
    clearTimeout(viewportTimer);
    viewportTimer = undefined;
    releaseCameraSensitivity(viewer?.camera, 'us-groundwater');
    clickHandler?.destroy();
    clickHandler = undefined;
    const owned = dataSource;
    dataSource = undefined;
    if (owned) viewer.dataSources.remove(owned, true);
    recordsByEntity.clear();
    visible = 0;
    if (hasContextHost()) {
      removeEntityContextsForLayer('us-groundwater');
      clearSelectedEntityContextForLayer('us-groundwater');
    }
    onSelect(null);
    requestFrame('well-release');
  }
  function draw() {
    if (!enabled || destroyed || !pack || !dataSource || !attached) return;
    cardColumns = wellCardColumns(viewer.scene.canvas?.clientWidth);
    recordPicker.close();
    // Capture the current owner at draw time: an intervening user selection
    // must never be replaced by the result of an older viewport request.
    if ((viewer.camera.positionCartographic?.height ?? 0) > WELL_DETAIL_HEIGHT)
      clearWellSelection();
    const viewerWellId = recordsByEntity.has(viewer.selectedEntity?.id)
      ? viewer.selectedEntity.id
      : null;
    const selectedId =
      viewerWellId &&
      (!hasContextHost() || getContextStore().selectedEntityId === viewerWellId)
        ? viewerWellId
        : null;
    if (viewerWellId && !selectedId) {
      viewer.selectedEntity = undefined;
      onSelect(null);
    }
    if (counted()) {
      // Too many records for this view: show none; the panel carries counts.
      clearWellSelection();
      visibleRecords.clear();
      dataSource.entities.removeAll();
      recordsByEntity.clear();
      if (hasContextHost()) removeEntityContextsForLayer('us-groundwater');
      visible = 0;
      status();
      requestFrame('well-counts');
      return;
    }
    // Keep the record list on screen (disabled) so keyboard focus survives the
    // rebuild; it is republished below.
    visibleRecords.clear(true);
    const rectangle = viewer.camera.computeViewRectangle();
    const occluder = new Cesium.EllipsoidalOccluder(
      Cesium.Ellipsoid.WGS84,
      viewer.camera.positionWC,
    );
    const inView = (record) => {
      const carto = Cesium.Cartographic.fromDegrees(
        record.longitude,
        record.latitude,
      );
      return Boolean(
        rectangle &&
        Cesium.Rectangle.contains(rectangle, carto) &&
        occluder.isPointVisible(
          Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude),
        ),
      );
    };
    const shown = pack.records.filter(inView);
    if (hasContextHost()) {
      removeEntityContextsForLayer('us-groundwater', {
        retainIds: new Set(shown.map((r) => `us-groundwater:${r.id}`)),
      });
    }
    dataSource.entities.removeAll();
    recordsByEntity.clear();
    for (const record of shown) {
      const entity = dataSource.entities.add({
        id: `us-groundwater:${record.id}`,
        name: wellDisplayName(record),
        position: Cesium.Cartesian3.fromDegrees(
          record.longitude,
          record.latitude,
        ),
        // Explicit dimensions stop a pooled billboard inheriting another
        // symbol's size.
        billboard: {
          image: WELL_MARKER_IMAGE,
          width: 12,
          height: 12,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      entity.gevWellRecordLabel = wellRecordLabel(record);
      recordsByEntity.set(entity.id, record);
      entity.__localLayerId = 'us-groundwater';
      // Supply the same presentation contract as selectable static ALPR sites.
      // This is a visual surface anchor, never a water-level elevation/datum.
      let displayPosition = Cesium.Cartesian3.fromDegrees(
        record.longitude,
        record.latitude,
      );
      entity.gevDisplayPosition = () => displayPosition;
      entity.gevUpdateWellAnchor = () => {
        const carto = Cesium.Cartographic.fromDegrees(
          record.longitude,
          record.latitude,
        );
        const height = viewer.scene.globe?.getHeight?.(carto);
        displayPosition = Cesium.Cartesian3.fromDegrees(
          record.longitude,
          record.latitude,
          Number.isFinite(height) ? height : 0,
        );
      };
      entity.gevLabelModel = {
        title: msg('Water well record'),
        details: historicalWellCardLines(record).flatMap((line) =>
          wrapWellCardLine(line, cardColumns),
        ),
        accent: '#00ffff',
        cardStyle: 'tactical',
        selected: true,
        verticalOnly: false,
        anchorRadiusPx: 5,
        anchorRadiusScale: null,
      };
      if (hasContextHost()) {
        registerEntityContext(entity, {
          id: entity.id,
          layerId: 'us-groundwater',
          layerName: 'U.S. Groundwater Wells',
          source: sourceLabel,
          dataSource,
          label: wellDisplayName(record),
          properties: { ...describeWell(record), metadata: record.metadata },
          latitude: record.latitude,
          longitude: record.longitude,
        });
      }
    }
    if (selectedId) {
      const replacement = dataSource.entities.getById(selectedId);
      if (replacement) selectWell(replacement);
      else {
        viewer.selectedEntity = undefined;
        if (hasContextHost())
          clearSelectedEntityContextForLayer('us-groundwater');
        onSelect(null);
      }
    }
    visibleRecords.track(dataSource);
    visible = dataSource.entities.values.length;
    status();
    // Cesium's entity visualizer may populate primitives during the first
    // frame after attachment. Request one more frame so idle scenes show them.
    removeReadyFrame?.();
    removeReadyFrame = viewer.scene.postRender?.addEventListener(() => {
      removeReadyFrame?.();
      removeReadyFrame = undefined;
      if (enabled && attached && !destroyed) requestFrame('well-ready');
    });
    requestFrame('well-draw');
  }
  async function attach() {
    if (!dataSource) {
      dataSource = new Cesium.CustomDataSource('us-groundwater');
      const owned = dataSource;
      await viewer.dataSources.add(owned);
      if (!enabled || destroyed || dataSource !== owned) {
        viewer.dataSources.remove(owned, true);
        return false;
      }
      attached = true;

      // Camera.setView and resize need not emit moveEnd. Enforce the detail
      // gate before painting, and reflow only when the column budget changes.
      let previousDetailView;
      removePresentationFrame = viewer.scene.preRender?.addEventListener(() => {
        if (!enabled || !attached || destroyed) return;
        const near =
          (viewer.camera.positionCartographic?.height ?? Infinity) <=
          WELL_DETAIL_HEIGHT;
        if (!near) {
          clearWellSelection();
          if (previousDetailView !== false) recordPicker.close();
        }
        previousDetailView = near;
        if (wellCardColumns(viewer.scene.canvas?.clientWidth) !== cardColumns)
          draw();
      });

      // Claim clicks on well markers so layers that treat an unowned pick as
      // empty space (e.g. a tracked flight) leave the selection alone.
      picking?.registerPickOwner?.('us-groundwater', (id) =>
        recordsByEntity.has(id),
      );
      clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      clickHandler.setInputAction((event) => {
        if (!enabled || !isPointerFree()) return;
        const picked = viewer.scene.pick(event.position);
        const entity = picked?.id;
        const detailVisible =
          dataSource.show &&
          viewer.camera.positionCartographic.height <= WELL_DETAIL_HEIGHT;
        // Hollow source-location symbols have transparent centers. Use the same
        // small pixel neighborhood as overlapping-record selection when the
        // scene pick misses, while respecting any other layer's picked object.
        if (detailVisible && (recordsByEntity.has(entity?.id) || !picked)) {
          const candidates = recordsAtPixel(
            viewer,
            dataSource.entities.values.filter((e) => recordsByEntity.has(e.id)),
            event.position,
          );
          if (candidates.length || recordsByEntity.has(entity?.id)) {
            recordPicker.choose(candidates.length ? candidates : [entity]);
            return;
          }
        }
        if (!selectWell(entity) && !picked) {
          if (recordsByEntity.has(viewer.selectedEntity?.id))
            viewer.selectedEntity = undefined;
          if (hasContextHost())
            clearSelectedEntityContextForLayer('us-groundwater');
          onSelect(null);
          requestFrame('well-clear-selection');
        }
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    }
    draw();
    return enabled && !destroyed;
  }
  const layer = {
    id: 'us-groundwater',
    name: 'U.S. Groundwater Wells',
    icon: '🪣',
    source: sourceLabel,
    updateInterval: 0,
    init(nextViewer) {
      if (viewer || destroyed)
        throw new Error('Well layer already initialized or destroyed');
      viewer = nextViewer;
      visibleRecords = createVisibleRecords(viewer, {
        onSelectRecord: selectWell,
        publishRecords: recordUi.publishRecords,
      });
    },
    async enable() {
      if (!viewer || destroyed) throw new Error('Well layer is not available');
      enabled = true;
      // Reuse the shared sensitivity lease used by native transport layers:
      // camera.changed then fires at 5% view changes (Cesium's default is 50%),
      // so the view refreshes during motion, not only at moveEnd.
      if (!removeCameraChanged && viewer.camera.changed) {
        claimCameraSensitivity(viewer.camera, 'us-groundwater', 0.05);
        removeCameraChanged = viewer.camera.changed.addEventListener(() => {
          if (pending || viewportTimer) return;
          // A throttle, not a reset-on-every-wheel debounce: sustained motion
          // gets current-view work too. Native marker reprojection is immediate.
          viewportTimer = setTimeout(() => {
            viewportTimer = undefined;
            void refreshViewport();
          }, 200);
          status();
        });
      }
      if (!removeCamera)
        removeCamera = viewer.camera.moveEnd.addEventListener(() => {
          if (
            (viewer.camera.positionCartographic?.height ?? 0) >
            WELL_DETAIL_HEIGHT
          )
            clearWellSelection();
          clearTimeout(viewportTimer);
          viewportTimer = undefined;
          if (pending) {
            initialRevision++;
            initialRequest?.abort();
          } else void refreshViewport();
        });
      if (pending) return pending;
      const active = new AbortController();
      controller = active;
      error = null;
      const work = (async () => {
        try {
          while (
            enabled &&
            !destroyed &&
            controller === active &&
            !active.signal.aborted
          ) {
            const revision = initialRevision;
            const initialBounds = viewBounds();
            const request = new AbortController();
            initialRequest = request;
            const signal = AbortSignal.any([active.signal, request.signal]);
            let candidate;
            try {
              candidate = await new Promise((resolve, reject) => {
                const abort = () =>
                  reject(
                    signal.reason ??
                      new DOMException('Cancelled', 'AbortError'),
                  );
                signal.addEventListener('abort', abort, { once: true });
                Promise.resolve()
                  .then(() => {
                    signal.throwIfAborted();
                    return source.getSnapshot({
                      signal,
                      bounds: initialBounds,
                      countBudget: COUNT_BUDGET,
                    });
                  })
                  .then(resolve, reject)
                  .finally(() => signal.removeEventListener('abort', abort));
              });
            } catch (failure) {
              if (revision !== initialRevision && !active.signal.aborted)
                continue;
              throw failure;
            }
            if (
              active.signal.aborted ||
              controller !== active ||
              !enabled ||
              destroyed
            )
              return false;
            if (
              revision !== initialRevision ||
              JSON.stringify(initialBounds) !== JSON.stringify(viewBounds())
            )
              continue;
            pack = validateView(candidate);
            lastCheckedAt = Date.now();
            const result = await attach();
            if (revision !== initialRevision) continue;
            return result;
          }
          return false;
        } catch (failure) {
          if (
            !active.signal.aborted &&
            controller === active &&
            enabled &&
            !destroyed
          ) {
            error = failure?.message ?? msg('Source unavailable');
            release();
            status();
          }
          return false;
        } finally {
          if (controller === active) {
            initialRequest = undefined;
            controller = undefined;
            pending = undefined;
          }
        }
      })();
      pending = work;
      return work;
    },
    disable() {
      enabled = false;
      viewGeneration++;
      viewController?.abort();
      viewController = undefined;
      source.cancel?.();
      initialRequest?.abort();
      initialRequest = undefined;
      controller?.abort();
      controller = undefined;
      pending = undefined;
      release();
      status();
    },
    // enable() and camera events already draw; update only reports readiness.
    update() {
      return Boolean(enabled && pack && dataSource && attached);
    },
    destroy() {
      if (destroyed) return;
      layer.disable();
      destroyed = true;
      pack = undefined;
    },
    getStats: stats,
    getRecords() {
      return structuredClone(pack?.records ?? []);
    },
  };
  return layer;
}
