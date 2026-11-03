import {
  bindTrackingClickGesture,
  isTrackingSelectionGesture,
} from '../data/trackingClickGesture.js';
import * as Cesium from 'cesium';
import {
  getContextStore,
  getSelectedEntityContext,
} from '../data/contextStore.js';
import {
  findPickOwner,
  resolvePickId,
  pickContact,
} from '../data/pickRegistry.js';
import { isPointerFree } from '../data/inputOwnership.js';

/** Flatten source-supplied public metadata, keeping long/nested records readable. */
export function inspectionFields(properties) {
  const rows = [];
  function walk(value, label, depth) {
    if (rows.length >= 200 || value == null || typeof value === 'function')
      return;
    if (typeof value === 'object' && depth < 4) {
      for (const [key, entry] of Object.entries(value))
        walk(entry, label ? `${label} · ${key}` : key, depth + 1);
      return;
    }
    if (typeof value === 'object') value = JSON.stringify(value);
    rows.push({
      label: label.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' '),
      value: String(value).slice(0, 4000),
    });
  }
  walk(properties, '', 0);
  return rows;
}

/** Read one selection from the owning layer; never scan all live records each frame. */
export function readInspection(manager, target) {
  if (!target || !manager) return null;
  if (target.layerId !== 'map-object' && !manager.isEnabled?.(target.layerId))
    return null;
  const layer =
    manager.layers.get(target.layerId)?.module || (target.entity ? {} : null);
  if (!layer) return null;
  const selected = getSelectedEntityContext({ dataManager: manager });
  const context =
    selected?.layerId === target.layerId &&
    String(selected.id) === String(target.contextId)
      ? selected
      : null;
  let live =
    layer.getInspectionInfo?.() ??
    layer.getTrackedInfo?.() ??
    layer.getSelectedInfo?.();
  if (target.entity) {
    const entity = target.entity;
    if (
      entity.show === false ||
      entity.entityCollection?.owner?.show === false ||
      (entity.entityCollection && !entity.entityCollection.contains(entity))
    )
      return null;
    const now = Cesium.JulianDate.now();
    const position = entity.position?.getValue(now);
    if (!position) return null;
    const location = Cesium.Cartographic.fromCartesian(position);
    if (!location) return null;
    const properties = entity.properties?.getValue(now) || {};
    live = {
      id: String(entity.id),
      label: entity.name || properties.place || String(entity.id),
      latitude: Cesium.Math.toDegrees(location.latitude),
      longitude: Cesium.Math.toDegrees(location.longitude),
      altitudeM: location.height,
      properties,
    };
  }
  if (target.layerId === 'cctv') live = layer.getUIState?.().activeCamera;
  if (
    live &&
    String(live.id ?? live.icao24 ?? live.noradId ?? live.mmsi ?? target.id) !==
      String(target.id)
  )
    return null;
  if (!context && !live) return null;
  const latitude = live?.latitude ?? live?.lat ?? context?.latitude;
  const longitude = live?.longitude ?? live?.lon ?? context?.longitude;
  const details = {
    ...(context?.properties || {}),
    ...(live?.properties || {}),
    ...live,
  };
  for (const key of [
    'entity',
    'dataSource',
    'position',
    'properties',
    'id',
    'label',
    'latitude',
    'longitude',
    'lat',
    'lon',
  ])
    delete details[key];
  return {
    id: String(target.id),
    layerId: target.layerId,
    label: live?.label || live?.name || context?.label || String(target.id),
    source: context?.source || live?.source || layer.source || '',
    layerName: context?.layerName || layer.name || '',
    latitude,
    longitude,
    altitudeM: live?.altitudeM ?? live?.altitude ?? 0,
    fields: inspectionFields(details),
  };
}

/** Own map inspection and explicit double-click focus, alongside layer click handlers. */
export function createObjectInspection({
  viewer,
  getManager,
  publish,
  reveal,
  focus,
  restore,
  handlerFactory = (canvas) => new Cesium.ScreenSpaceEventHandler(canvas),
  eventTarget = globalThis.window,
  schedule = (fn) => setTimeout(fn, 0),
}) {
  let target = null;
  let timer = null;
  let stopped = false;
  let generation = 0;
  let signature = '';
  const handler = handlerFactory(viewer.scene.canvas);
  const doubleType = Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK;
  const stock = viewer.screenSpaceEventHandler;
  const stockDouble = stock?.getInputAction(doubleType);
  stock?.removeInputAction(doubleType);
  function refresh() {
    if (stopped) return null;
    const model = readInspection(getManager(), target);
    const next = JSON.stringify(model);
    if (next !== signature) {
      signature = next;
      publish(model);
    }
    return model;
  }
  function watch() {
    clearTimeout(timer);
    if (target && !stopped)
      timer = setTimeout(() => {
        if (!refresh()) target = null;
        watch();
      }, 500);
  }
  function fromPick(picked) {
    const id = resolvePickId(picked);
    const entityContextId = picked?.id?.__gevContextId;
    const record = entityContextId
      ? getContextStore().entities.get(entityContextId)
      : getSelectedEntityContext({ dataManager: getManager() });
    const trackedOwner = picked?.id?.gevTrackedId?.split(':')[0];
    const cameraProperty = picked?.id?.properties?.cctvCameraId;
    const owner =
      trackedOwner ||
      (cameraProperty ? 'cctv' : null) ||
      findPickOwner(id) ||
      (entityContextId ? record?.layerId : null);
    if (!owner) {
      const entity = picked?.id;
      if (!entity?.position?.getValue || !entity?.properties) return null;
      const inferred = String(entity.id).startsWith('earthquake:')
        ? 'earthquakes'
        : entity.__localLayerId || 'map-object';
      return { layerId: inferred, id: String(entity.id), entity };
    }
    const layer = getManager()?.layers.get(owner)?.module;
    if (!layer) return null;
    const live =
      layer.getInspectionInfo?.() ??
      layer.getTrackedInfo?.() ??
      layer.getSelectedInfo?.();
    if (owner === 'cctv') {
      const camera = layer.getUIState?.().activeCamera;
      return camera ? { layerId: owner, id: camera.id, pickId: id } : null;
    }
    const context = record?.layerId === owner ? record : null;
    const selectedId =
      live?.id ?? live?.icao24 ?? live?.noradId ?? live?.mmsi ?? context?.id;
    return selectedId != null
      ? { layerId: owner, id: selectedId, contextId: context?.id, pickId: id }
      : null;
  }
  function choose(picked) {
    const next = fromPick(picked);
    target = next;
    const model = refresh();
    watch();
    if (model && model.layerId !== 'cctv') reveal();
    return model;
  }
  bindTrackingClickGesture(handler, (click, gesture) => {
    if (!isTrackingSelectionGesture(gesture) || !isPointerFree()) return;
    const picked = pickContact(viewer.scene, click.position);
    const current = ++generation;
    schedule(() => {
      if (!stopped && current === generation) choose(picked);
    });
  });
  handler.setInputAction((click) => {
    if (
      !isPointerFree() ||
      globalThis.document?.body.classList.contains('cockpit-mode')
    )
      return;
    const picked = pickContact(viewer.scene, click.position);
    const current = ++generation;
    schedule(() => {
      if (stopped || current !== generation) return;
      const model = choose(picked);
      if (model) focus(model);
    });
  }, doubleType);
  const selectionChanged = () => {
    schedule(() => {
      if (stopped) return;
      const context = getSelectedEntityContext({ dataManager: getManager() });
      if (!context) {
        refresh();
        return;
      }
      const layer = getManager()?.layers.get(context.layerId)?.module;
      const live =
        layer?.getInspectionInfo?.() ??
        layer?.getTrackedInfo?.() ??
        layer?.getSelectedInfo?.();
      target = {
        layerId: context.layerId,
        id:
          live?.id ?? live?.icao24 ?? live?.noradId ?? live?.mmsi ?? context.id,
        contextId: context.id,
      };
      const model = refresh();
      watch();
      if (model && model.layerId !== 'cctv') reveal();
    });
  };
  const events = [
    'gev:entity-selected',
    'gev:awareness-subject-selected',
    'gev:entity-selection-cleared',
    'gev:awareness-subject-cleared',
  ];
  for (const event of events)
    eventTarget?.addEventListener(event, selectionChanged);
  return {
    focus: () => {
      const model = refresh();
      return model ? focus(model) : false;
    },
    restore,
    destroy() {
      if (stopped) return;
      stopped = true;
      ++generation;
      clearTimeout(timer);
      handler.destroy();
      for (const event of events)
        eventTarget?.removeEventListener(event, selectionChanged);
      if (stockDouble && !stock?.isDestroyed?.())
        stock?.setInputAction(stockDouble, doubleType);
      publish(null);
    },
  };
}
