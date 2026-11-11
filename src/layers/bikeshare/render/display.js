import { writeSelectedMarker } from '../../shared/selectionKeeper.js';
// The bikeshare stations on the globe contract (engine.movers, engine.input,
// engine.camera, engine.surface), the same on every engine:
// - rendering: one point per station in one point set, sized by capacity
//   and coloured by availability, scaled and faded with distance, on top
//   only within 2.5 km of the camera;
// - selection: a click on a station hides its point under a 14 px cyan
//   highlight (a one-point set drawn over everything) and publishes its
//   card; a click elsewhere or Escape clears it;
// - viewport: the camera's altitude and view centre for the city range
//   check, rerun after camera changes;
// - lifecycle: what init, enable, show, disable, detach and destroy own.
// The layer (index.js) merges these into its parts.

import { createSurfacePoints } from '../../../globe/surfacePlacement.js';
import * as geo from '../../../geo/index.js';
import { isPointerFree } from '../../../data/inputOwnership.js';
import {
  claimCameraSensitivity,
  releaseCameraSensitivity,
} from '../../../data/cameraSensitivity.js';
import { SPRITE_LAYER_ORDER } from '../../../data/spriteOrder.js';
import { viewRectangleCenter } from '../../shared/viewRectangle.js';
import { GBFS_CITY_REGISTRY } from '../registry.js';
import {
  BIKESHARE_SELECTED_OVERLAY_SOURCE_ID,
  BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS,
  COLOR_NEUTRAL,
  MAX_TOTAL_POINTS,
  POINT_HEIGHT_OFFSET_M,
} from '../policy.js';
import { createBikeshareSelectedOverlayEntry } from '../selectionModel.js';
import { createStationPoints } from '../stationPoints.js';
import { createViewport } from '../viewport.js';
import {
  SELECTED_COLOR,
  SELECTED_POINT,
  SELECTED_SET_ID,
  STATION_DEPTH_TEST,
  STATION_POINT,
  STATION_SET_ID,
} from './style.js';

const LAYER_ID = 'bikeshare';
// The station points take the layer's place among the contact sprites; the
// highlight draws over the layer's own points.
const STATION_ORDER = SPRITE_LAYER_ORDER.indexOf(LAYER_ID);
const SELECTED_ORDER = STATION_ORDER + 0.5;

/**
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 * @param {{ state: object, services: object, parts: object, source: object }} context
 * @returns {{ rendering: object, selection: object, viewport: object, lifecycle: { methods: object } }}
 */
export function createBikeshareDisplay(engine, context) {
  const { state, services, parts } = context;
  const { registerPickOwner, unregisterPickOwner } = services.picking ?? {};
  let stations = null;
  let highlight = null;
  let visible = false;
  let destroyed = false;
  let removeClick = null;
  let removeCamera = null;

  // Both sets, made with the first station or selection.
  function ensureSets() {
    if (stations || destroyed) return Boolean(stations);
    stations = engine.movers.createSet({
      id: STATION_SET_ID,
      kind: 'point',
      capacity: MAX_TOTAL_POINTS,
      order: STATION_ORDER,
      pickable: true,
      sharpen: true,
      depthTest: STATION_DEPTH_TEST,
      point: STATION_POINT,
    });
    highlight = engine.movers.createSet({
      id: SELECTED_SET_ID,
      kind: 'point',
      capacity: 1,
      order: SELECTED_ORDER,
      pickable: true,
      sharpen: true,
      depthTest: 'always',
      point: SELECTED_POINT,
    });
    return true;
  }
  function destroySets() {
    stations?.destroy();
    highlight?.destroy();
    stations = highlight = null;
  }

  // A station's point as stationPoints keeps it: position, pixelSize,
  // colour and show.
  function writePoint(record) {
    if (!stations) return;
    stations.set(record.index, {
      position: record.point.position,
      color: record.point.color.rgba(),
      scale: record.point.pixelSize / STATION_POINT.sizePx,
      show: record.point.show,
      pickId: record.key,
    });
  }
  function reindex() {
    let index = 0;
    for (const record of state._stationRenderMap.values()) {
      record.index = index++;
      writePoint(record);
    }
  }
  function commitStations() {
    if (!stations) return;
    stations.setCount(visible ? state._stationRenderMap.size : 0);
    stations.commit();
  }
  function commitHighlight() {
    if (!highlight) return;
    const key = state._selectedKey;
    const record = key ? state._stationRenderMap.get(key) : null;
    const shown = Boolean(record?.point?.position);
    writeSelectedMarker(
      highlight,
      shown
        ? {
            position: record.point.position,
            color: SELECTED_COLOR.rgba(),
            scale: 1,
            show: true,
            pickId: key,
          }
        : null,
    );
    highlight.commit();
  }
  // The stations show and hide together; the highlight goes with the
  // selection.
  function setVisible(next) {
    if (visible === next) return;
    visible = next;
    commitStations();
  }

  const surface = createSurfacePoints(engine, {
    groups: () => [
      {
        points: [...state._stationRenderMap.values()].map(
          (record) => record.point.surface,
        ),
        exclude: [stations, highlight].filter(Boolean),
        set: stations && {
          set(index, fields) {
            const record = [...state._stationRenderMap.values()][index];
            record.point.position = fields.position;
            stations.set(index, fields);
          },
          commit() {
            stations.commit();
            commitHighlight();
            selection.refreshSelectedCard();
          },
        },
      },
    ],
    prefer: 'scene',
    estimateGround: true,
    heightOffset: POINT_HEIGHT_OFFSET_M,
    request: () => engine.render.request(LAYER_ID),
  });
  function placeStations() {
    commitStations();
    surface.place();
  }

  const rendering = createStationPoints(context, {
    // On the rendered surface where it answers, a small height otherwise.
    position(station) {
      const lon = Number(station?.lon);
      const lat = Number(station?.lat);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      ensureSets();
      return geo.cartesian3.fromDegrees(lon, lat, POINT_HEIGHT_OFFSET_M);
    },
    create(record, { position, pixelSize }) {
      ensureSets();
      record.index = state._stationRenderMap.size;
      record.point = {
        position,
        surface: {
          position,
          cartographic: geo.cartographic.fromCartesian(position),
          get show() {
            return visible;
          },
        },
        pixelSize,
        color: COLOR_NEUTRAL,
        show: true,
      };
      writePoint(record);
      return record.point;
    },
    afterAdd: placeStations,
    afterRemove() {
      reindex();
      commitStations();
    },
    update: writePoint,
    afterUpdate: placeStations,
  });

  const selection = {
    /** Clears the selection: the station's point returns, the card goes. */
    _clearSelection() {
      const record = state._selectedKey
        ? state._stationRenderMap.get(state._selectedKey)
        : null;
      if (record?.point) {
        record.point.show = true;
        writePoint(record);
        commitStations();
      }
      state._selectedKey = null;
      commitHighlight();
      state._overlayHost.clearSource(BIKESHARE_SELECTED_OVERLAY_SOURCE_ID);
    },
    /** Selects a station: its point hides under the highlight and its card. */
    _selectStation(key) {
      selection._clearSelection();
      const record = state._stationRenderMap.get(key);
      if (!record || !record.point?.position || !ensureSets()) return;
      state._selectedKey = key;
      record.point.show = false;
      writePoint(record);
      commitStations();
      commitHighlight();
      selection.refreshSelectedCard();
    },
    refreshSelectedCard() {
      const key = state._selectedKey;
      const record = state._stationRenderMap.get(key);
      if (!record) return;
      const entry = createBikeshareSelectedOverlayEntry(key, record);
      if (entry)
        state._overlayHost.setEntries(
          BIKESHARE_SELECTED_OVERLAY_SOURCE_ID,
          [entry],
          BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS,
        );
    },
    /**
     * A click on a station selects it, one on the highlight changes nothing
     * and any other clears the selection; Escape clears it too. Once.
     */
    _installClickHandler() {
      if (removeClick) return;
      const remove = engine.input.on('click', selection._onClick, {
        pick: true,
      });
      globalThis.document?.addEventListener?.('keydown', selection._onKeyDown);
      removeClick = () => {
        remove();
        globalThis.document?.removeEventListener?.(
          'keydown',
          selection._onKeyDown,
        );
      };
    },
    _uninstallClickHandler() {
      removeClick?.();
      removeClick = null;
    },
    _onClick(event) {
      // A tool owns the pointer (src/data/inputOwnership.js): yield the click.
      if (!isPointerFree()) return;
      const picked = event.picked;
      if (picked) {
        if (picked.owner === SELECTED_SET_ID) return;
        if (
          typeof picked.id === 'string' &&
          state._stationRenderMap.has(picked.id)
        ) {
          selection._selectStation(picked.id);
          return;
        }
      }
      if (state._selectedKey) selection._clearSelection();
    },
    _onKeyDown(event) {
      if (event.key === 'Escape' && state._selectedKey)
        selection._clearSelection();
    },
  };

  const viewport = createViewport({
    ...context,
    camera: {
      getCameraAltitude: () => engine.camera.height(),
      // The view rectangle's centre, else the point under the camera.
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

  // camera.changed through the shared sensitivity ledger: every layer's
  // listener shares the one number (src/data/cameraSensitivity.js).
  function attachCamera() {
    if (state._cameraChangedAttached) return;
    removeCamera = engine.camera.changed.addEventListener(
      parts.display.onCameraChanged,
    );
    claimCameraSensitivity(engine, LAYER_ID, 0.05);
    state._cameraChangedAttached = true;
  }
  function detachCamera() {
    if (!state._cameraChangedAttached) return;
    removeCamera?.();
    removeCamera = null;
    releaseCameraSensitivity(engine, LAYER_ID);
    state._cameraChangedAttached = false;
  }
  function releaseInput() {
    parts.display._uninstallClickHandler();
    unregisterPickOwner?.(LAYER_ID, engine);
  }

  const methods = {
    /** Builds the sets, hidden until show(). */
    init() {
      if (destroyed) throw new Error('Bikeshare renderer is destroyed');
      state._engine = engine;
      ensureSets();
      setVisible(false);
      state._overlayHost.setVisible(
        BIKESHARE_SELECTED_OVERLAY_SOURCE_ID,
        false,
      );
      console.log(
        `[Data:Bikeshare] Initialized with ${GBFS_CITY_REGISTRY.length} cities`,
      );
    },
    enable() {
      if (destroyed || state._enabled) return;
      state._enabled = true;
      state._failedCityIds.clear();
      methods.show();
    },
    /** Shows the points and card, takes clicks and follows the camera. */
    show() {
      setVisible(true);
      surface.place({ all: true });
      state._overlayHost.setVisible(BIKESHARE_SELECTED_OVERLAY_SOURCE_ID, true);
      parts.display._installClickHandler();
      // Pick ownership: station point ids are render-map keys.
      registerPickOwner?.(
        LAYER_ID,
        (pickedId) => state._stationRenderMap.has(pickedId),
        engine,
      );
      attachCamera();
      void parts.display.runProximityCheck();
    },
    /** Hides everything, stops every request and drops the cities. */
    disable() {
      if (destroyed) return;
      state._enabled = false;
      state._proximityGeneration++;
      state._altitudeGateEnabled = false;
      clearTimeout(state._cameraDebounceTimer);
      state._cameraDebounceTimer = null;
      parts.display._clearSelection();
      state._overlayHost.setVisible(
        BIKESHARE_SELECTED_OVERLAY_SOURCE_ID,
        false,
      );
      releaseInput();
      detachCamera();
      parts.ingestion.abortAllInFlight();
      parts.display.deactivateAllCities();
      state._cityRuntime.clear();
      setVisible(false);
      state._count = 0;
      state._loading = false;
      state._loadingOps = 0;
    },
    /** Leaves this globe; the caches stay for the next one. */
    detach() {
      parts.display._clearSelection();
      releaseInput();
      detachCamera();
      surface.destroy();
      destroySets();
      destroyed = true;
    },
    /** Releases the sets, listeners and caches for good. */
    destroy() {
      if (destroyed) return;
      clearTimeout(state._cameraDebounceTimer);
      state._cameraDebounceTimer = null;
      if (state._enabled) methods.disable();
      else {
        parts.display._clearSelection();
        state._overlayHost.setVisible(
          BIKESHARE_SELECTED_OVERLAY_SOURCE_ID,
          false,
        );
        releaseInput();
      }
      detachCamera();
      parts.ingestion.abortAllInFlight();
      surface.destroy();
      destroySets();
      destroyed = true;
      state._engine = null;
      state._stationInfoCache.clear();
      state._statusCache.clear();
    },
  };

  return { ...rendering, ...selection, ...viewport, ...methods };
}
