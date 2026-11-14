import { createRecordPicker, recordsAtPixel } from './recordPicker.js';
import * as Cesium from 'cesium';
import { msg } from '../../i18n/marker.js';
import { selectInfraLod } from '../../data/localGeojsonLod.js';
import { validateCountView } from './countGrids.js';
import {
  createCountRenderer,
  wellMarkerImage,
  WELL_DETAIL_HEIGHT,
} from './countRenderer.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { getKeyholeGeometry } from '../../celestialRing.js';
import {
  wrapWellCardLine,
  wellCardColumns,
  wellRecordLabel,
  wellDisplayName,
  visibleWellWarnings,
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
import { validateWellPack, wellDetails } from './pack.js';
export { createWellPackSource } from './source.js';
export { validateWellPack, wellDetails, WELL_LIMITS } from './pack.js';

/** A portable, injected well layer with GEV's lifecycle and LOD policy. */
export function createUsGroundwaterLayer({
  source,
  onSelect = () => {},
  onStatus = () => {},
  recordUi = {},
  requestRender,
  overlays,
  validatePack = validateWellPack,
  describeWell = wellDetails,
  sourceLabel = source?.label ?? 'U.S. Geological Survey',
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('A well pack source is required');
  let viewer;
  let countRenderer;
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
  let selectedGroupCount = null;
  let incumbents = new Set();
  let viewController;
  let viewGeneration = 0;
  const countBudget = () => 4096;
  const detailPriority = (cell) => {
    const canvas = viewer.scene.canvas;
    const center = cell.center ?? [
      (cell.bounds[0] + cell.bounds[2]) / 2,
      (cell.bounds[1] + cell.bounds[3]) / 2,
    ];
    const point = viewer.scene.cartesianToCanvasCoordinates?.(
      Cesium.Cartesian3.fromDegrees(...center),
    );
    if (
      !canvas?.clientWidth ||
      !canvas?.clientHeight ||
      typeof viewer.scene.cartesianToCanvasCoordinates !== 'function'
    )
      return 0;
    if (
      !point ||
      point.x < 0 ||
      point.y < 0 ||
      point.x > canvas.clientWidth ||
      point.y > canvas.clientHeight
    )
      return Infinity;
    // Actual positions may coincide; visual spacing is not a data-admission veto.
    // Keep the outer display gate and let transport budgets bound local hydration.
    if (
      (viewer.camera.positionCartographic?.height ?? Infinity) >
      WELL_DETAIL_HEIGHT
    )
      return Infinity;
    const keyhole = getKeyholeGeometry(canvas.clientWidth, canvas.clientHeight);
    // The scope is visual, not a claim that data outside it does not exist.
    // Prioritize exact detail at its center; retain complete counts elsewhere.
    return (
      Math.hypot(point.x - keyhole.centerX, point.y - keyhole.centerY) /
      keyhole.radius
    );
  };
  const viewBounds = () => {
    const r = viewer.camera.computeViewRectangle();
    return r
      ? [r.west, r.south, r.east, r.north].map(Cesium.Math.toDegrees)
      : null;
  };
  async function refreshViewport() {
    if (!source.viewport) {
      draw();
      return;
    }
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
          countBudget: countBudget(),
          detailPriority,
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
    selectedGroupCount = null;
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
  const representedCount = () =>
    pack?.kind === 'gev-well-count-view'
      ? pack.cells.reduce((n, c) => n + c.count, 0) +
        (pack.detailPack?.records.length ?? 0)
      : (pack?.records.length ?? 0);
  const catalogCount = () =>
    pack?.kind === 'gev-well-count-view'
      ? pack.total
      : Number.isSafeInteger(pack?.catalogTotal) && pack.catalogTotal >= 0
        ? pack.catalogTotal
        : !source.viewport && pack
          ? pack.records.length
          : null;
  const stats = () => ({
    count: catalogCount() ?? 0,
    catalogCount: catalogCount(),
    // Intersecting whole cells are not an exact viewport count. OFF represents none.
    representedLocationCount: enabled && attached ? representedCount() : 0,
    visible,
    error,
    partial: true,
    coverage:
      pack?.kind === 'gev-well-count-view'
        ? 'Loaded source record positions plus remaining whole-cell counts; partial source coverage; empty areas unknown'
        : pack?.coverage.indexed
          ? pack.coverage.description
          : 'Bounded sample; not nationwide monitoring coverage',
    mode: 'snapshot',
    coverageComplete: false,
    acquisitions: pack?.acquisitions ?? pack?.detailPack?.acquisitions ?? [],
    selectedGroupCount,
    screenGroups: countRenderer?.getStats().groups ?? 0,
    lastCheckedAt,
    referenceRetrievedAt:
      pack?.referenceRetrievedAt ??
      pack?.acquisitions?.[0]?.retrievedAt ??
      null,
    displayMode:
      pack?.kind === 'gev-well-count-view'
        ? pack.detailPack?.records.length
          ? 'mixed'
          : 'limited-detail'
        : 'records',
    status:
      pack?.kind === 'gev-well-count-view' && pack.cells.length
        ? 'zoom-in'
        : undefined,
    statusMessage:
      enabled &&
      attached &&
      pack?.kind === 'gev-well-count-view' &&
      pack.cells.length
        ? msg('Detail limited; some records not shown')
        : undefined,
    loading: Boolean(pending || viewController || viewportTimer),
  });
  const status = () => onStatus(stats());
  function release() {
    recordPicker.close();
    if (recordsByEntity.has(viewer?.selectedEntity?.id))
      viewer.selectedEntity = undefined;
    countRenderer?.clear();
    selectedGroupCount = null;
    attached = false;
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
    incumbents.clear();
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
    const counted = pack.kind === 'gev-well-count-view';
    const detail = counted ? pack.detailPack : pack;
    if (counted && !detail?.records.length) {
      clearWellSelection();
      recordsByEntity.clear();
      incumbents.clear();
      if (hasContextHost()) removeEntityContextsForLayer('us-groundwater');
      countRenderer.draw(pack, dataSource);
      visible = 0;
      status();
      requestFrame('well-counts');
      return;
    }
    // Indexed views redraw immediately; retain and invalidate the group
    // selector so a keyboard user's focus survives the intermediate reset.
    countRenderer.clear(true);
    if (detail.coverage.indexed)
      countRenderer.describeDetails(detail.records.length);
    const rectangle = viewer.camera.computeViewRectangle();
    const position = viewer.camera.positionWC;
    const occluder = new Cesium.EllipsoidalOccluder(
      Cesium.Ellipsoid.WGS84,
      position,
    );
    const candidates = detail.records.map((record) => {
      const carto = Cesium.Cartographic.fromDegrees(
        record.longitude,
        record.latitude,
      );
      const world = Cesium.Cartesian3.fromRadians(
        carto.longitude,
        carto.latitude,
      );
      return {
        id: record.id,
        priority: 0,
        inView: Boolean(
          rectangle &&
          Cesium.Rectangle.contains(rectangle, carto) &&
          occluder.isPointVisible(world),
        ),
        distanceM: Cesium.Cartesian3.distance(position, world),
      };
    });
    const lod = detail.coverage.indexed
      ? { activeIds: candidates.filter((c) => c.inView).map((c) => c.id) }
      : selectInfraLod(candidates, {
          cameraHeightM: viewer.camera.positionCartographic.height,
          incumbentIds: incumbents,
        });
    incumbents = new Set(lod.activeIds);
    if (hasContextHost()) {
      removeEntityContextsForLayer('us-groundwater', {
        retainIds: new Set([...incumbents].map((id) => `us-groundwater:${id}`)),
      });
    }
    dataSource.entities.removeAll();
    recordsByEntity.clear();
    for (const record of detail.records) {
      if (!incumbents.has(record.id)) continue;
      const entity = dataSource.entities.add({
        id: `us-groundwater:${record.id}`,
        name: wellDisplayName(record),
        position: Cesium.Cartesian3.fromDegrees(
          record.longitude,
          record.latitude,
        ),
        // Explicit dimensions avoid pooled PointVisualizer billboards inheriting
        // the width of a previous aggregate symbol after a detail transition.
        billboard: {
          image: wellMarkerImage(
            record.readings.length > 0,
            record.source === 'USGWD',
          ),
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
      const details = describeWell(record);
      entity.gevLabelModel = {
        title: record.source === 'USGWD' ? msg('Water well record') : record.id,
        details: (record.source === 'USGWD'
          ? historicalWellCardLines(record)
          : [
              ...(record.source === 'USGWD' ? [] : [entity.name]),
              sourceLabel,
              ...visibleWellWarnings(record, details),
              msg('Historical snapshot; incomplete coverage'),
              msg('Source records; physical-well identity is unresolved.'),
              msg('Empty areas are unknown; no water availability inference.'),
              ...(detail.coverage.stateCode === '22'
                ? [detail.coverage.description]
                : []),
              `${msg('Horizontal accuracy')}: ${record.metadata.horizontal_positional_accuracy ?? msg('Unknown')}`,
              ...(details.readings?.length
                ? details.readings.flatMap((reading) => [
                    `${reading.label}: ${reading.value}`,
                    reading.reference,
                    `${msg('Observed')}: ${reading.observed}`,
                    `${msg('Retrieved')}: ${reading.retrieved}`,
                    `${msg('Approval')}: ${reading.approval}`,
                    `${msg('Qualifiers')}: ${reading.qualifiers}`,
                  ])
                : [msg('No water-level observations supplied')]),
              `${msg('Metadata retrieved')}: ${details.metadataRetrievedAt ?? msg('Unknown')}`,
              record.sourceUrl,
            ]
        ).flatMap((line) => wrapWellCardLine(line, cardColumns)),
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
    {
      countRenderer.draw(
        counted
          ? pack
          : {
              schemaVersion: 1,
              kind: 'gev-well-count-view',
              coverageComplete: false,
              cells: [],
              degrees: 0.03125,
              total: catalogCount() ?? detail.records.length,
              detailPack: detail,
            },
        dataSource,
        true,
      );
    }
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

      clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      let pressedFlag;
      clickHandler.setInputAction((event) => {
        pressedFlag =
          enabled && isPointerFree()
            ? overlays?.hitTestWorldOverlay?.(
                event.position.x,
                event.position.y,
                { sourceId: 'us-groundwater-counts' },
              )
            : null;
      }, Cesium.ScreenSpaceEventType.LEFT_DOWN);
      clickHandler.setInputAction((event) => {
        const downFlag = pressedFlag;
        pressedFlag = null;
        if (!enabled || !isPointerFree()) return;
        const flag = overlays?.hitTestWorldOverlay?.(
          event.position.x,
          event.position.y,
          { sourceId: 'us-groundwater-counts' },
        );
        // The shared overlay can fade while the pointer is held. Preserve the
        // original flag hit only for Cesium's click (not a drag) gesture.
        const clickedFlag = flag ?? downFlag;
        if (
          clickedFlag?.entryId?.startsWith('well-group:') &&
          clickedFlag.entry?.activate?.() === true
        )
          return;
        if (
          clickedFlag &&
          selectWell(dataSource.entities.getById(clickedFlag.entryId))
        )
          return;
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
      countRenderer = createCountRenderer(viewer, {
        overlays,
        onError: (failure) => {
          error = failure?.message ?? null;
          status();
        },
        onSelectGroup: (count) => {
          if (hasContextHost())
            clearSelectedEntityContextForLayer('us-groundwater');
          if (recordsByEntity.has(viewer.selectedEntity?.id))
            viewer.selectedEntity = undefined;
          onSelect(null);
          requestFrame('well-cluster-zoom');
          selectedGroupCount = count;
          status();
        },
        onSelectRecord: selectWell,
        publishRecords: recordUi.publishRecords,
      });
    },
    async enable() {
      if (!viewer || destroyed) throw new Error('Well layer is not available');
      enabled = true;
      // Reuse the shared sensitivity lease used by native transport layers.
      // This also lets Cesium split loaded screen clusters at 5% view changes,
      // rather than its otherwise coarse 50% default when wells are alone.
      if (source.viewport && !removeCameraChanged && viewer.camera.changed) {
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
                    return (
                      (!source.viewport && pack) ||
                      source.getSnapshot({
                        signal,
                        bounds: initialBounds,
                        countBudget: countBudget(),
                        detailPriority,
                      })
                    );
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
              source.viewport &&
              (revision !== initialRevision ||
                JSON.stringify(initialBounds) !== JSON.stringify(viewBounds()))
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
    update() {
      draw();
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
      return structuredClone(pack?.records ?? pack?.detailPack?.records ?? []);
    },
  };
  return layer;
}
