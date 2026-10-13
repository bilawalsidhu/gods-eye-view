import * as Cesium from 'cesium';
import {
  MILITARY_LABEL_CAP,
  MILITARY_POINT_CAP,
} from '../../data/militaryNames.js';
import { LAYER_ID, COLOR_BY_CLASS } from './policy.js';
import { createInfrastructureOverlayEntry } from '../../data/infrastructureOverlayEntry.js';

/** Bounded point markers; the shared overlay owns text projection and decluttering. */
export function createNamedMarkers({ state, services, parts, overlayHost }) {
  let points = null;
  let entries = [];
  const markers = new Map();
  const screen = new Cesium.Cartesian2();
  const occluder = new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84);
  let shownPoints = 0;
  let ordered = [];
  const viewMatrix = new Cesium.Matrix4();
  let width = 0,
    height = 0;
  let removeChanged = null,
    removeEnd = null,
    removeFrame = null;

  function refresh() {
    const viewer = state.viewer;
    if (!state.enabled || !points) return;
    width = viewer.scene.canvas.clientWidth;
    height = viewer.scene.canvas.clientHeight;
    if (viewer.camera.viewMatrix)
      Cesium.Matrix4.clone(viewer.camera.viewMatrix, viewMatrix);
    occluder.cameraPosition = viewer.camera.positionWC;
    shownPoints = 0;
    for (let index = 0; index < ordered.length; index++) {
      const marker = ordered[index];
      const point = marker.point;
      point.show = marker.named && occluder.isPointVisible(point.position);
      if (!point.show) continue;
      const projected = Cesium.SceneTransforms.worldToWindowCoordinates(
        viewer.scene,
        point.position,
        screen,
      );
      if (
        projected &&
        screen.x >= 0 &&
        screen.y >= 0 &&
        screen.x < width &&
        screen.y < height
      )
        shownPoints++;
    }
  }

  function publishLabels() {
    overlayHost.setEntries(LAYER_ID, entries, {
      // Keep the bounded point cohort available while Contacts owns the window.
      // The arbiter spends at most 24 slots on currently visible, separated titles.
      cohortLimit: MILITARY_POINT_CAP,
      collisionCapacity: MILITARY_LABEL_CAP,
      maxVisible: MILITARY_LABEL_CAP - (state.selectedId ? 1 : 0),
      moving: false,
      visible: state.enabled,
    });
  }

  function cameraChanged() {
    refresh();
    services.render.governorRequestRender('installation-names');
  }
  function frame() {
    const viewer = state.viewer;
    if (
      viewer?.camera.viewMatrix &&
      (!Cesium.Matrix4.equals(viewMatrix, viewer.camera.viewMatrix) ||
        width !== viewer.scene.canvas.clientWidth ||
        height !== viewer.scene.canvas.clientHeight)
    )
      refresh();
  }
  function enable() {
    const viewer = state.viewer;
    if (!viewer || removeChanged || removeEnd || removeFrame) return;
    removeChanged = viewer.camera.changed?.addEventListener(cameraChanged);
    removeEnd = viewer.camera.moveEnd?.addEventListener(cameraChanged);
    removeFrame = viewer.scene.preRender?.addEventListener(frame);
    if (points) points.show = true;
    publishLabels();
    overlayHost.setVisible(LAYER_ID, true);
    cameraChanged();
  }
  function hide() {
    removeChanged?.();
    removeEnd?.();
    removeFrame?.();
    removeChanged = removeEnd = removeFrame = null;
    if (points) points.show = false;
    overlayHost.clearSource(LAYER_ID);
    overlayHost.setVisible(LAYER_ID, false);
    shownPoints = 0;
  }

  function sync(records) {
    const viewer = state.viewer;
    if (!viewer?.scene?.primitives) return;
    if (!points) {
      points = viewer.scene.primitives.add(
        new Cesium.PointPrimitiveCollection(),
      );
    }
    points.show = state.enabled;
    const named = records
      .filter((r) => r.namedArea || r.id === state.selectedId)
      .sort(
        (a, b) =>
          Number(b.id === state.selectedId) -
            Number(a.id === state.selectedId) || b.areaM2 - a.areaM2,
      )
      .slice(0, MILITARY_POINT_CAP);
    const keep = new Set(named.map((r) => r.id));
    for (const record of named) {
      if (markers.has(record.id)) continue;
      const alias = record.aliasIds?.find(
        (id) => !keep.has(id) && markers.has(id),
      );
      if (!alias) continue;
      const marker = markers.get(alias);
      markers.delete(alias);
      marker.point.id = { installationId: record.id };
      marker.entry.id = record.id;
      markers.set(record.id, marker);
    }
    for (const [id, marker] of markers)
      if (!keep.has(id)) {
        points.remove(marker.point);
        markers.delete(id);
      }
    ordered = [];
    entries = [];
    for (const record of named) {
      const position = Cesium.Cartesian3.fromDegrees(
        record.longitude,
        record.latitude,
        record.pointOnly
          ? 0
          : parts.rendering.installationSurfaceHeightM(record),
      );
      let marker = markers.get(record.id);
      if (!marker) {
        const id = { installationId: record.id };
        marker = {
          point: points.add({
            id,
            position,
            pixelSize: 7,
            color: parts.model.colorFor(record),
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 1,
            disableDepthTestDistance: Infinity,
          }),
          entry: createInfrastructureOverlayEntry({
            id: record.id,
            source: LAYER_ID,
            position,
            title: record.name,
            priority: record.areaM2 || 0,
            accent: COLOR_BY_CLASS[record.class] || '#9ca6b0',
          }),
        };
        markers.set(record.id, marker);
      } else {
        marker.point.position = position;
      }
      marker.named = record.namedArea;
      marker.entry.variant =
        record.id === state.selectedId ? 'selected' : 'card';
      marker.entry.selected = record.id === state.selectedId;
      marker.entry.details = marker.entry.selected
        ? [
            String(record.class || 'installation')
              .replaceAll('_', ' ')
              .toUpperCase(),
            ...(record.memberNames || []).slice(0, 3),
          ]
        : [];
      marker.entry.position = position;
      marker.entry.title = record.name;
      marker.entry.priority = record.areaM2 || 0;
      entries.push(marker.entry);
      ordered.push(marker);
    }
    if (state.enabled) publishLabels();
    refresh();
    services.render.governorRequestRender('installation-names');
  }
  return {
    sync,
    visit(visitor) {
      for (let i = 0; i < ordered.length; i++) {
        const marker = ordered[i];
        visitor(marker.point.id.installationId, marker.point);
      }
    },
    refresh,
    enable,
    hide,
    stats: () => ({
      namedMarkers: markers.size,
      pointsOnScreen: shownPoints,
      labelsOnScreen: state.enabled
        ? overlayHost.getDiagnostics?.().paintedBySource[LAYER_ID] || 0
        : 0,
      labelCap: MILITARY_LABEL_CAP,
    }),
    destroy() {
      hide();
      ordered = [];
      if (points) state.viewer?.scene.primitives.remove(points);
      points = null;
      entries = [];
      markers.clear();
    },
  };
}
