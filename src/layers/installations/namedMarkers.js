import { installationClassLabel, installationTitle } from './classLabel.js';
import {
  MILITARY_LABEL_CAP,
  MILITARY_POINT_CAP,
} from '../../data/militaryNames.js';
import { fromDegrees } from '../../geo/index.js';
import { horizonFrom } from '../../geo/horizon.js';
import {
  cameraOf,
  canvasOf,
  drawOf,
  findFrame,
  findQuery,
} from '../../render/rendererOf.js';
import {
  CAMERA_CHANGED_THRESHOLD,
  LAYER_ID,
  COLOR_BY_CLASS,
} from './policy.js';
import { createInfrastructureOverlayEntry } from '../../data/infrastructureOverlayEntry.js';

let instances = 0;

/**
 * A named marker's point item id. Not the bare record id: the shared pick
 * registry resolves a draw item's pick to its item id, and a point click has
 * never been this layer's for sibling layers' owner checks (a tracked
 * aircraft is released by it, as by a click on empty map). The click handler
 * reads the record id from the item's `meta`.
 */
export const namedPointId = (recordId) => `named:${recordId}`;

const samePlace = (a, b) =>
  Boolean(a) && a.x === b.x && a.y === b.y && a.z === b.z;

/** Bounded point markers; the shared overlay owns text projection and decluttering. */
export function createNamedMarkers({ state, services, parts, overlayHost }) {
  const setId = `${LAYER_ID}:${++instances}:names`;
  let points = null;
  let entries = [];
  const markers = new Map();
  let shownPoints = 0;
  /** Where each drawn point item is, by item id. */
  let drawn = new Map();
  let ordered = [];
  let lastPose = null;
  let width = 0,
    height = 0;
  let removeChanged = null,
    removeEnd = null,
    removeFrame = null;

  /** Whether the eye moved or the canvas resized since the last refresh. */
  function viewChanged(viewer, pose) {
    const same = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;
    return (
      !lastPose ||
      !same(pose.position, lastPose.position) ||
      !same(pose.direction, lastPose.direction) ||
      !same(pose.up, lastPose.up) ||
      width !== canvasOf(viewer).clientWidth ||
      height !== canvasOf(viewer).clientHeight
    );
  }

  // Reused projection buffers, grown to the marker count.
  let worldXyz = new Float64Array(0);
  let screenXy = new Float32Array(0);

  function refresh(pose = null) {
    const viewer = state.viewer;
    if (!state.enabled || !points) return;
    const canvas = canvasOf(viewer);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    pose ??= cameraOf(viewer).pose();
    lastPose = {
      position: { ...pose.position },
      direction: { ...pose.direction },
      up: { ...pose.up },
    };
    // The ellipsoid horizon from the eye, the test the draw set's own
    // horizon cull makes, so the count agrees with what is drawn.
    const horizon = horizonFrom(pose.position);
    if (worldXyz.length < ordered.length * 3) {
      worldXyz = new Float64Array(ordered.length * 3);
      screenXy = new Float32Array(ordered.length * 2);
    }
    let shown = 0;
    for (let index = 0; index < ordered.length; index++) {
      const marker = ordered[index];
      const point = marker.point;
      point.show = marker.named && horizon.isPointVisible(point.position);
      if (!point.show) continue;
      worldXyz[shown * 3] = point.position.x;
      worldXyz[shown * 3 + 1] = point.position.y;
      worldXyz[shown * 3 + 2] = point.position.z;
      shown++;
    }
    shownPoints = 0;
    const query = findQuery(viewer);
    if (!query || !shown) return;
    query.projectMany(
      worldXyz.subarray(0, shown * 3),
      screenXy.subarray(0, shown * 2),
    );
    for (let i = 0; i < shown; i++) {
      const x = screenXy[i * 2];
      const y = screenXy[i * 2 + 1];
      // NaN, behind the eye, fails every test.
      if (x >= 0 && y >= 0 && x < width && y < height) shownPoints++;
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
    if (!viewer || !points) return;
    const pose = cameraOf(viewer).pose();
    if (viewChanged(viewer, pose)) refresh(pose);
  }
  function enable() {
    const viewer = state.viewer;
    if (!viewer || removeChanged || removeEnd || removeFrame) return;
    const camera = cameraOf(viewer);
    // The sensitivity this layer claims for raw camera listeners while on.
    removeChanged = camera.on('changed', cameraChanged, {
      threshold: CAMERA_CHANGED_THRESHOLD,
    });
    removeEnd = camera.on('moveEnd', cameraChanged);
    removeFrame = findFrame(viewer)?.on('preRender', frame) ?? null;
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

  /** The point item a marker draws. */
  function pointItem(marker, record) {
    return {
      id: namedPointId(marker.recordId),
      pos: marker.point.position,
      pixelSize: 7,
      color: parts.model.colorFor(record),
      outlineColor: [0, 0, 0, 1],
      outlineWidth: 1,
      disableDepthTest: Infinity,
      show: marker.named,
      meta: { installationId: marker.recordId },
    };
  }

  function sync(records) {
    const viewer = state.viewer;
    if (!viewer) return;
    points ??= drawOf(viewer).points({ id: setId, horizonCull: true });
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
      marker.recordId = record.id;
      marker.entry.id = record.id;
      markers.set(record.id, marker);
    }
    for (const id of markers.keys()) if (!keep.has(id)) markers.delete(id);
    ordered = [];
    entries = [];
    const items = [];
    for (const record of named) {
      const position = fromDegrees(
        record.longitude,
        record.latitude,
        record.pointOnly
          ? 0
          : parts.rendering.installationSurfaceHeightM(record),
      );
      let marker = markers.get(record.id);
      if (!marker) {
        marker = {
          recordId: record.id,
          // What `visit` hands out: the marker's id, position and whether
          // it is on this side of the horizon.
          point: { id: { installationId: record.id }, position, show: false },
          entry: createInfrastructureOverlayEntry({
            id: record.id,
            source: LAYER_ID,
            position,
            title: installationTitle(record.name),
            priority: record.areaM2 || 0,
            accent: COLOR_BY_CLASS[record.class] || '#9ca6b0',
          }),
        };
        markers.set(record.id, marker);
      } else {
        marker.point.position = position;
      }
      marker.named = Boolean(record.namedArea);
      marker.entry.variant =
        record.id === state.selectedId ? 'selected' : 'card';
      marker.entry.selected = record.id === state.selectedId;
      marker.entry.details = marker.entry.selected
        ? [
            installationClassLabel(record.class),
            ...(record.memberNames || []).slice(0, 3),
          ]
        : [];
      marker.entry.position = position;
      marker.entry.title = installationTitle(record.name);
      marker.entry.priority = record.areaM2 || 0;
      entries.push(marker.entry);
      ordered.push(marker);
      items.push(pointItem(marker, record));
    }
    // Restyled points that keep their ids and places change in place; any
    // other change draws the set anew.
    if (
      items.length === drawn.size &&
      items.every((item) => samePlace(drawn.get(item.id), item.pos))
    )
      points.upsert(items);
    else points.set(items);
    drawn = new Map(items.map((item) => [item.id, { ...item.pos }]));
    if (state.enabled) publishLabels();
    refresh();
    services.render.governorRequestRender('installation-names');
  }
  return {
    sync,
    /** The draw set's id, for matching its click hits. */
    setId,
    visit(visitor) {
      for (let i = 0; i < ordered.length; i++) {
        const marker = ordered[i];
        visitor(marker.recordId, marker.point);
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
      points?.dispose();
      points = null;
      drawn = new Map();
      entries = [];
      markers.clear();
    },
  };
}
