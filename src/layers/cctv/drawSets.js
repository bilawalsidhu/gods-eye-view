/**
 * @module layers/cctv/drawSets
 * @description The CCTV layer's draw sets: the frustum wireframes
 * (`coverage`, lines), the viewshed volumes (`viewshed`, meshes) and the
 * active camera's monitor plane (`plane`, a quad), made through the draw
 * port of the viewer the layer is on. They are made when first drawn into
 * and made again on another viewer. Item ids keep the layer's
 * `cctv-<cameraId>-<role>` scheme the shared pick registry reads, and each
 * line's and plane's `meta.cameraId` names its camera (volumes are never
 * picked and carry none).
 *
 * Coverage lines and the plane are written from handles the layer keeps
 * (a record's `coverageEntities`, a projection runtime's `plane`): plain
 * objects the layer changes and then writes, only what changed reaching
 * the set.
 *
 * Meshes and quads are capabilities: on a renderer without them there are
 * no viewshed volumes or monitor plane, and the lines still draw.
 */
import { drawOf } from '../../render/rendererOf.js';

/** Layer instances, for set ids unique to each. */
let instances = 0;

/** A line handle's item, or null for a handle that names no line yet. */
function lineItemOf(handle) {
  if (!handle?.id || !Array.isArray(handle.positions)) return null;
  const color = handle.color;
  return {
    id: handle.id,
    positions: handle.positions,
    widthPx: handle.widthPx,
    // As a polyline entity runs: along the ellipsoid between its positions.
    mode: 'geodesic',
    style: handle.dashed
      ? { kind: 'dash', color, length: 16, pattern16: 255 }
      : { kind: 'solid', color },
    depthFail: handle.depthFailColor
      ? { kind: 'solid', color: handle.depthFailColor }
      : null,
    meta: { cameraId: handle.cameraId },
    show: handle.show !== false,
  };
}

/** What a line item draws, as a key: an unchanged key is not written. */
const lineKey = (item) =>
  [
    item.positions.map((p) => `${p.x},${p.y},${p.z}`).join(';'),
    item.widthPx,
    item.style.kind,
    item.style.color.join(','),
    item.depthFail ? item.depthFail.color.join(',') : '',
    item.show,
  ].join('|');

/** The plane handle's quad item. */
function quadItemOf(plane) {
  return {
    id: plane.id,
    center: plane.center,
    orientation: plane.orientation,
    size: plane.size,
    source: plane.source,
    alpha: plane.alpha,
    outline: plane.outline,
    meta: { cameraId: plane.cameraId },
    show: plane.show === true,
  };
}

export function createDrawSets({ state: layerState }) {
  /** The live sets and the viewer they draw on, or null. */
  let current = null;
  /** Viewshed volumes written, ever (the QA harness checks for churn). */
  let volumeWrites = 0;

  /** The layer's sets on its viewer now, made if need be; null with none. */
  function sets() {
    const viewer = layerState._viewer;
    if (!viewer) return null;
    if (current?.viewer === viewer) return current;
    dispose();
    const draw = drawOf(viewer);
    const n = ++instances;
    current = {
      viewer,
      coverage: draw.lines({ id: `cctv:${n}:coverage` }),
      viewshed:
        draw.meshes?.({ id: `cctv:${n}:viewshed`, pickable: false }) ?? null,
      plane: draw.quads?.({ id: `cctv:${n}:plane` }) ?? null,
      // What each line item was last written as, by id.
      lineKeys: new Map(),
    };
    return current;
  }

  /** The live sets, without making them. */
  const live = () =>
    current && current.viewer === layerState._viewer ? current : null;

  /** Let the sets go (the layer leaves its viewer, or moves to another). */
  function dispose() {
    if (!current) return;
    for (const set of [current.coverage, current.viewshed, current.plane])
      try {
        set?.dispose();
      } catch {
        // Its viewer went first.
      }
    current = null;
  }

  /** The ids of the sets that draw the layer's lines and plane. */
  function pickableSetIds() {
    const s = live();
    if (!s) return [];
    return s.plane ? [s.coverage.id, s.plane.id] : [s.coverage.id];
  }

  /** Which of the layer's sets a set id is: 'coverage', 'plane' or null. */
  function roleOfSet(setId) {
    const s = live();
    if (!s) return null;
    if (setId === s.coverage.id) return 'coverage';
    if (setId === s.plane?.id) return 'plane';
    return null;
  }

  /** Write line handles that changed since they were last written. */
  function writeLines(handles) {
    if (!handles?.length) return;
    const s = handles.some((h) => h?.id) ? sets() : null;
    if (!s) return;
    const changed = [];
    for (const handle of handles) {
      const item = lineItemOf(handle);
      if (!item) continue;
      const key = lineKey(item);
      if (s.lineKeys.get(item.id) === key) continue;
      s.lineKeys.set(item.id, key);
      changed.push(item);
    }
    if (changed.length) s.coverage.upsert(changed);
  }

  /** Take every line out. */
  function clearLines() {
    const s = live();
    if (!s) return;
    s.coverage.clear();
    s.lineKeys.clear();
  }

  /** Write the plane handle as it is now. */
  function writePlane(plane) {
    if (!plane?.id) return;
    sets()?.plane?.upsert([quadItemOf(plane)]);
  }

  /** Take a plane out. */
  function removePlane(plane) {
    if (plane?.id) live()?.plane?.remove([plane.id]);
  }

  /** Write a viewshed volume. */
  function writeVolume(item) {
    const s = sets();
    if (!s?.viewshed) return;
    s.viewshed.upsert([item]);
    volumeWrites += 1;
  }

  /** Take a viewshed volume out. */
  function removeVolume(id) {
    if (id) live()?.viewshed?.remove([id]);
  }

  /** How many viewshed volumes were written, for the QA harness. */
  const volumeWritesForTest = () => volumeWrites;

  return {
    sets,
    dispose,
    pickableSetIds,
    roleOfSet,
    writeLines,
    clearLines,
    writePlane,
    removePlane,
    writeVolume,
    removeVolume,
    volumeWritesForTest,
  };
}
