import * as geo from '../../../geo/index.js';
import { selectionDispatcherFor } from '../../../data/selectionDispatcher.js';
import { CYAN } from '../../shared/color.js';
import { viewRectangleCenter } from '../../shared/viewRectangle.js';
import { createViewport } from '../viewport.js';
import {
  BIKESHARE_SELECTED_OVERLAY_SOURCE_ID,
  BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS,
  COLOR_NEUTRAL,
  COLOR_OUTLINE,
  MAX_TOTAL_POINTS,
  POINT_HEIGHT_OFFSET_M,
} from '../policy.js';
import { capacityToPixelSize } from '../presentation.js';
import { createBikeshareSelectedOverlayEntry } from '../selectionModel.js';
import { createStationPoints } from '../stationPoints.js';

const LAYER_ID = 'bikeshare';

function pointSet(engine, { id, capacity, order, depthTest, point }) {
  return engine.movers.createSet({
    id,
    kind: 'point',
    capacity,
    order,
    pickable: true,
    sharpen: true,
    depthTest,
    point,
  });
}

export function createBikeshareNavaraRenderer(engine, context) {
  const { state, services, parts } = context;
  const normalSet = pointSet(engine, {
    id: LAYER_ID,
    capacity: MAX_TOTAL_POINTS,
    order: 30,
    point: {
      sizePx: 8,
      outlinePx: 1,
      outlineColor: COLOR_OUTLINE.rgba(),
      scaleByDistance: [200, 1.35, 130000, 0.4],
      translucencyByDistance: [200, 1, 180000, 0.15],
    },
    depthTest: { disableWithinM: 2500 },
  });
  const selectedSet = pointSet(engine, {
    id: `${LAYER_ID}-selected`,
    capacity: 1,
    order: 31,
    point: { sizePx: 14, outlinePx: 2, outlineColor: [0, 0, 0, 1] },
    depthTest: 'always',
  });
  let selectionRemove = null;
  let cameraRemove = null;
  let destroyed = false;

  const syncPoint = (record) => {
    const color = record.point.color;
    normalSet.set(record.index, {
      position: record.point.position,
      color: color.rgba(),
      scale: capacityToPixelSize(record.capacity) / 8,
      show: record.point.show,
      pickId: record.key,
    });
  };
  const resetNormalSet = () => {
    normalSet.setCount(state._stationRenderMap.size);
    let index = 0;
    for (const record of state._stationRenderMap.values()) {
      record.index = index++;
      syncPoint(record);
    }
    normalSet.commit();
    state._count = state._stationRenderMap.size;
  };
  const request = (reason) => services.render.governorRequestRender(reason);

  const rendering = createStationPoints(context, {
    position(station) {
      const lon = Number(station?.lon);
      const lat = Number(station?.lat);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const sampled = engine.surface.supported
        ? engine.surface.sampleHeight(geo.cartographic.fromDegrees(lon, lat), [
            normalSet,
            selectedSet,
          ])
        : undefined;
      const height =
        (Number.isFinite(sampled) ? sampled : 0) + POINT_HEIGHT_OFFSET_M;
      return geo.cartesian3.fromDegrees(lon, lat, height);
    },
    create(record, { position, pixelSize }) {
      record.index = state._stationRenderMap.size;
      record.point = { position, pixelSize, color: COLOR_NEUTRAL, show: true };
      syncPoint(record);
      return record.point;
    },
    afterAdd() {
      normalSet.setCount(state._stationRenderMap.size);
      normalSet.commit();
    },
    afterRemove: resetNormalSet,
    update: syncPoint,
    afterUpdate: () => normalSet.commit(),
  });

  const selection = {
    refreshSelectedCard() {
      const key = state._selectedKey;
      const record = state._stationRenderMap.get(key);
      if (!record) return;
      state._overlayHost.setEntries(
        BIKESHARE_SELECTED_OVERLAY_SOURCE_ID,
        [createBikeshareSelectedOverlayEntry(key, record)],
        BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS,
      );
    },
    _clearSelection() {
      if (state._selectedKey) {
        const record = state._stationRenderMap.get(state._selectedKey);
        if (record?.point) {
          record.point.show = true;
          syncPoint(record);
          normalSet.commit();
        }
      }
      state._selectedKey = null;
      state._selectedEntity = null;
      selectedSet.setCount(0);
      selectedSet.commit();
      state._overlayHost.clearSource(BIKESHARE_SELECTED_OVERLAY_SOURCE_ID);
      request('bikeshare-selection-clear');
    },
    _selectStation(key) {
      this._clearSelection();
      const record = state._stationRenderMap.get(key);
      if (!record || !record.point?.position) return;
      state._selectedKey = key;
      record.point.show = false;
      syncPoint(record);
      normalSet.commit();
      selectedSet.setCount(1);
      selectedSet.set(0, {
        position: record.point.position,
        color: CYAN.rgba(),
        scale: 1,
        show: true,
        pickId: key,
      });
      selectedSet.commit();
      const entry = createBikeshareSelectedOverlayEntry(key, record);
      if (entry) {
        state._overlayHost.setEntries(
          BIKESHARE_SELECTED_OVERLAY_SOURCE_ID,
          [entry],
          BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS,
        );
        state._overlayHost.setVisible(
          BIKESHARE_SELECTED_OVERLAY_SOURCE_ID,
          true,
        );
      }
      request('bikeshare-selection');
    },
  };

  const viewport = createViewport({
    ...context,
    camera: {
      getCameraAltitude: () => engine.camera.height(),
      getCameraCenterLatLon() {
        const rect = engine.camera.viewRectangle();
        if (rect) {
          const { latitude, longitude } = viewRectangleCenter(rect);
          return {
            lat: geo.math.toDegrees(latitude),
            lon: geo.math.toDegrees(longitude),
          };
        }
        const cartographic = engine.camera.pose()?.cartographic;
        return cartographic
          ? {
              lat: geo.math.toDegrees(cartographic.latitude),
              lon: geo.math.toDegrees(cartographic.longitude),
            }
          : null;
      },
    },
  });

  const lifecycle = {
    methods: {
      init() {
        if (destroyed) throw new Error('Bikeshare renderer is destroyed');
        state._engine = engine;
        state._viewer = null;
        normalSet.setCount(0);
        selectedSet.setCount(0);
        normalSet.commit();
        selectedSet.commit();
        state._overlayHost.setVisible(
          BIKESHARE_SELECTED_OVERLAY_SOURCE_ID,
          false,
        );
      },
      enable() {
        if (destroyed || state._enabled) return;
        state._enabled = true;
        state._error = null;
        this.show();
      },
      show() {
        state._overlayHost.setVisible(
          BIKESHARE_SELECTED_OVERLAY_SOURCE_ID,
          true,
        );
        selectionRemove = selectionDispatcherFor(engine).register(LAYER_ID, {
          owns: (id) => state._stationRenderMap.has(id),
          onSelect: (id) => selection._selectStation(id),
          onEmptyClick: () => selection._clearSelection(),
          onEscape: () => selection._clearSelection(),
        });
        cameraRemove = engine.camera.moveEnd.addEventListener(() =>
          viewport.onCameraChanged(),
        );
        state._cameraChangedAttached = true;
        void viewport.runProximityCheck();
      },
      disable() {
        if (destroyed) return;
        state._enabled = false;
        state._proximityGeneration++;
        state._altitudeGateEnabled = false;
        clearTimeout(state._cameraDebounceTimer);
        state._cameraDebounceTimer = null;
        selection._clearSelection();
        state._overlayHost.setVisible(
          BIKESHARE_SELECTED_OVERLAY_SOURCE_ID,
          false,
        );
        selectionRemove?.();
        selectionRemove = null;
        cameraRemove?.();
        cameraRemove = null;
        state._cameraChangedAttached = false;
        parts.ingestion.abortAllInFlight();
        viewport.deactivateAllCities();
        state._cityRuntime.clear();
        normalSet.setCount(0);
        selectedSet.setCount(0);
        normalSet.commit();
        selectedSet.commit();
        state._count = 0;
        state._loading = false;
        state._loadingOps = 0;
      },
      detach() {
        selection._clearSelection();
        selectionRemove?.();
        cameraRemove?.();
        state._cameraChangedAttached = false;
        normalSet.destroy();
        selectedSet.destroy();
        destroyed = true;
      },
      destroy() {
        if (destroyed) return;
        this.disable();
        parts.ingestion.abortAllInFlight();
        normalSet.destroy();
        selectedSet.destroy();
        state._stationInfoCache.clear();
        state._statusCache.clear();
        state._engine = null;
        state._viewer = null;
        destroyed = true;
      },
    },
  };

  return { rendering, selection, viewport, lifecycle };
}
