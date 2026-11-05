import * as geo from '../../../geo/index.js';
import {
  bindTrackingClickGesture,
  isTrackingClickGesture,
} from '../../../data/trackingClickGesture.js';
import { createCctvNavaraMeshes } from './navaraMeshes.js';
import { createCctvNavaraLine } from './navaraLine.js';
import { createNavaraCctvGizmoRenderer } from './navaraGizmo.js';
import {
  CAMERA_ICON,
  IDLE_CAMERA_COLOR,
  IDLE_COVERAGE_COLOR,
} from '../policy.js';

export function createCctvNavaraRenderer(
  engine,
  { state, services, view, MeshDesc },
) {
  const meshes = createCctvNavaraMeshes(engine, { view, MeshDesc });
  const markers = [];
  const coverage = new Set();
  const planes = new Set();
  const gizmos = new Set();
  const removers = new Set();
  let initialized = false,
    destroyed = false,
    visible = true,
    dirty = false;
  let set = null,
    capacity = 0,
    credit = null;
  const request = () => engine.render.request('cctv');
  const markDirty = () => {
    if (dirty || destroyed) return;
    dirty = true;
    request();
  };
  function syncMarkers() {
    if (!dirty || !set || destroyed) return;
    dirty = false;
    set.setCount(markers.length);
    markers.forEach((marker, index) =>
      set.set(index, {
        position: marker.position,
        show: visible && marker.show,
        scale: marker.scale,
        color: marker.color.rgba(),
        cell: 'camera',
        pickId: marker.id,
      }),
    );
    set.commit();
  }
  function allocateMarkers(count) {
    if (set && capacity >= count) return;
    set?.destroy();
    capacity = Math.max(128, count, capacity * 2);
    set = engine.movers.createSet({
      id: 'cctv',
      kind: 'sprite',
      capacity,
      order: 50,
      pickable: true,
      depthTest: 'always',
      sharpen: true,
      sprite: {
        sizePx: 24,
        scaleByDistance: [350, 1.25, 4_000_000, 0.42],
        atlas: { url: CAMERA_ICON, cells: { camera: [0, 0, 1, 1] } },
      },
    });
    markDirty();
  }
  const ownListener = (remove) => {
    const release = () => {
      if (removers.delete(release)) remove();
    };
    removers.add(release);
    return release;
  };
  function pickedCameraId(picked) {
    if (!picked) return null;
    if (picked.owner === 'cctv' && state._recordById.has(picked.id))
      return picked.id;
    for (const entity of [...coverage, ...planes])
      if (picked.id === entity.id && picked.owner === entity.id && entity.show)
        return entity.cameraId;
    return null;
  }
  const removeMeshPicker = engine.picker.registerMeshPicker((at) => {
    const hit = meshes.pickPlane(engine.camera.pickRay(at));
    if (!hit) return [];
    // The rendered depth includes terrain, tiles and foreground models.
    const surface = engine.picker.pickPosition(at);
    if (
      surface &&
      geo.cartesian3.distance(engine.camera.livePosition, surface) + 0.1 <
        hit.distance
    )
      return [];
    return [
      {
        onTop: 0,
        order: 0,
        depth: hit.distance,
        result: { id: hit.plane.id, owner: hit.plane.id },
      },
    ];
  });
  const removeFrame = engine.frames.preRender.addEventListener(syncMarkers);
  const removePlane = (runtime) => {
    const plane = runtime?.planeEntity;
    if (planes.delete(plane)) plane.destroy();
    runtime?.planeMaterial?.dispose();
  };
  const points = (p) => [p.tl, p.tr, p.br, p.bl, p.tl];
  return {
    attach() {
      if (destroyed) throw new Error('CCTV renderer is destroyed');
      initialized = true;
    },
    get ready() {
      return initialized && !destroyed && !engine.isDestroyed();
    },
    cameraCartographic: () => engine.camera.pose().cartographic,
    following: () => Boolean(engine.camera.following()),
    globeVisible: () => !engine.maps.photorealActive(),
    tilesReady: () => engine.surface.tilesLoaded(),
    project: (position, result) =>
      engine.projector.worldToWindow(position, result),
    distance: (position) =>
      geo.cartesian3.distance(engine.camera.livePosition, position),
    horizonTest: () => (position) => engine.projector.horizonVisible(position),
    viewport: () => engine.host.size(),
    request,
    pick(position) {
      syncMarkers();
      return engine.picker.pick(position);
    },
    extractPickedCameraId: pickedCameraId,
    onMoveEnd: (fn) => ownListener(engine.camera.moveEnd.addEventListener(fn)),
    onMoveStart: (fn) =>
      ownListener(engine.camera.moveStart.addEventListener(fn)),
    bindClick(onClick, options = {}) {
      const removes = [];
      bindTrackingClickGesture(
        {
          setInputAction(fn, type) {
            removes.push(engine.input.on(type, fn));
          },
        },
        (event, gesture) => {
          if (isTrackingClickGesture(gesture)) onClick(event);
        },
        {
          ...options,
          eventTypes: {
            LEFT_DOWN: 'down',
            MOUSE_MOVE: 'move',
            LEFT_UP: 'up',
            LEFT_CLICK: 'click',
          },
        },
      );
      return ownListener(() => removes.forEach((remove) => remove()));
    },
    createGizmoRenderer() {
      const gizmo = createNavaraCctvGizmoRenderer(engine);
      gizmos.add(gizmo);
      return gizmo;
    },
    createMarkers() {
      allocateMarkers(1);
      return set;
    },
    createMarker(camera, position) {
      const marker = { id: camera.id };
      for (const [key, initial] of Object.entries({
        position,
        color: IDLE_CAMERA_COLOR,
        scale: 1,
        show: true,
      })) {
        const copy = (item) => (key === 'position' ? { ...item } : item);
        const equal = (a, b) =>
          key === 'position'
            ? a.x === b.x && a.y === b.y && a.z === b.z
            : key === 'color'
              ? a.red === b.red &&
                a.green === b.green &&
                a.blue === b.blue &&
                a.alpha === b.alpha
              : a === b;
        let value = copy(initial);
        Object.defineProperty(marker, key, {
          enumerable: true,
          get: () => value,
          set(next) {
            if (!equal(next, value)) {
              value = copy(next);
              markDirty();
            }
          },
        });
      }
      markers.push(marker);
      allocateMarkers(markers.length);
      markDirty();
      return marker;
    },
    setMarkersVisible(value) {
      if (visible !== Boolean(value)) {
        visible = Boolean(value);
        markDirty();
      }
    },
    restoreOrder: syncMarkers,
    showCredit() {
      credit ??= engine.credits.addStatic(
        '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
      );
    },
    hideCredit() {
      credit?.();
      credit = null;
    },
    sampleMeshFloorCells: (p, options) =>
      services.mesh.sampleMeshFloorCells(engine, p, options),
    obstructionRay: (origin, direction, exclude, far) =>
      engine.surface.raycast({ origin, direction, exclude, far }),
    createPlaneMaterial: meshes.createMaterial,
    createTestPlaneMaterial: () => meshes.createMaterial(null),
    setPlaneImage: (runtime, image) => runtime.planeMaterial.setImage(image),
    createPlane(record, runtime, geometry, p, orientation) {
      const plane = meshes.createPlane(
        record.camera.id,
        runtime.planeMaterial,
        geometry,
        p,
        orientation,
      );
      planes.add(plane);
      return plane;
    },
    updatePlane: (runtime, geometry, p, orientation) =>
      meshes.updatePlane(runtime.planeEntity, geometry, p, orientation),
    setPlaneVisible(runtime, value) {
      if (runtime.planeEntity) runtime.planeEntity.show = value;
    },
    removePlane,
    createCoverage(cameraId, p) {
      const created = [];
      try {
        for (const [role, positions] of [
          ['ray-tl', [p.mount, p.tl]],
          ['ray-tr', [p.mount, p.tr]],
          ['ray-br', [p.mount, p.br]],
          ['ray-bl', [p.mount, p.bl]],
          ['cap', points(p)],
        ]) {
          const line = createCctvNavaraLine(
            engine,
            `cctv-${cameraId}-${role}`,
            { width: 1.2, tint: IDLE_COVERAGE_COLOR },
            positions,
          );
          line.cameraId = cameraId;
          line._coverageRole = role === 'cap' ? 'cap' : 'edge';
          coverage.add(line);
          created.push(line);
        }
        return created;
      } catch (error) {
        for (const line of created) {
          coverage.delete(line);
          line.destroy();
        }
        throw error;
      }
    },
    updateCoverage(record, p) {
      const lines = record.coverageEntities;
      if (!lines || lines.length < 5) return;
      ['tl', 'tr', 'br', 'bl'].forEach((role, i) => {
        lines[i].polyline.positions = [p.mount, p[role]];
      });
      lines[4].polyline.positions = points(p);
    },
    removeCoverageEntity(entity) {
      if (coverage.delete(entity)) entity.destroy();
    },
    styleLine: (entity, style) => entity.style(style),
    hideCoverage(record) {
      for (const entity of record.coverageEntities || []) entity.show = false;
    },
    removeCoverage(record) {
      for (const entity of record.coverageEntities || [])
        if (coverage.delete(entity)) entity.destroy();
    },
    createVolume: (record, tint) =>
      meshes.createVolume(record.frustumPositions, tint),
    removeVolume: (volume) => volume?.destroy(),
    focus(record, duration) {
      engine.camera.flyToSphere(
        {
          center: record.position,
          radius: Math.max(40, record.camera.rangeM * 0.36),
        },
        {
          heading: geo.math.toRadians(record.camera.headingDeg),
          pitch: geo.math.toRadians(-22),
          range: Math.max(280, record.camera.rangeM * 1.18),
          duration: Math.max(0.2, duration || 0),
          easing: 'cubicInOut',
        },
      );
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      initialized = false;
      removeFrame();
      removeMeshPicker();
      for (const remove of [...removers]) remove();
      for (const gizmo of gizmos) gizmo.destroy();
      for (const line of coverage) line.destroy();
      meshes.destroy();
      set?.destroy();
      set = null;
      credit?.();
      credit = null;
      markers.length = 0;
      coverage.clear();
      planes.clear();
      gizmos.clear();
    },
  };
}
