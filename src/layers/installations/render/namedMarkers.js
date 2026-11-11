// The named-area discs and titles of Mapped Installations on the globe
// contract (engine.movers, engine.camera, engine.frames, engine.projector),
// the same on every engine. The bounded cohort is the named areas, largest
// first, with the selected site first: a 7 px disc in its class colour with
// a 1 px black outline, always on top, hidden behind the globe's horizon
// and for a selected site that is not a named area. The shared overlay
// (overlayHost) projects and declutters the titles; a camera move only
// re-tests the discs.

import * as geo from '../../../geo/index.js';
import {
  MILITARY_LABEL_CAP,
  MILITARY_POINT_CAP,
} from '../../../data/militaryNames.js';
import { createInfrastructureOverlayEntry } from '../../../data/infrastructureOverlayEntry.js';
import { installationClassLabel, installationTitle } from '../classLabel.js';
import { LAYER_ID } from '../policy.js';
import {
  MARKER_OUTLINE_PX,
  NAMED_MARKER_ORDER,
  NAMED_MARKER_OUTLINE_COLOR,
  NAMED_MARKER_SIZE_PX,
  installationAccent,
} from './style.js';

export const NAMED_MARKER_SET_ID = `${LAYER_ID}-named`;

/**
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 * @param {{ state: object, services: object, parts: object,
 *   overlayHost: object }} context The layer's state, services and parts,
 *   and the shared overlay that paints the titles.
 */
export function createNamedMarkers(
  engine,
  { state, services, parts, overlayHost },
) {
  let points = null;
  let entries = [];
  const markers = new Map();
  let ordered = [];
  let shown = false;
  let shownPoints = 0;
  const screen = geo.cartesian2.create();
  const viewProjection = new Array(16).fill(0);
  const lastViewProjection = new Array(16).fill(Number.NaN);
  let width = 0,
    height = 0;
  let removeChanged = null,
    removeEnd = null,
    removeFrame = null;

  /** Writes each disc's visibility and counts those on screen. */
  function refresh() {
    if (!state.enabled || !points) return;
    ({ width, height } = engine.host.size());
    engine.projector.viewProjection(viewProjection);
    for (let i = 0; i < 16; i++) lastViewProjection[i] = viewProjection[i];
    shownPoints = 0;
    let changed = false;
    for (let index = 0; index < ordered.length; index++) {
      const marker = ordered[index];
      const show = Boolean(
        shown &&
        marker.named &&
        engine.projector.horizonVisible(marker.view.position),
      );
      if (marker.view.show !== show) {
        marker.view.show = show;
        points.set(index, { show });
        changed = true;
      }
      if (!show) continue;
      const projected = engine.projector.worldToWindow(
        marker.view.position,
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
    if (changed) points.commit();
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
    services.render.governorRequestRender('installation-names', engine);
  }

  // Small pose changes raise no camera event: test the discs before the
  // frame whose view or canvas changed.
  function frame() {
    engine.projector.viewProjection(viewProjection);
    const size = engine.host.size();
    let moved = size.width !== width || size.height !== height;
    for (let i = 0; i < 16 && !moved; i++)
      moved = viewProjection[i] !== lastViewProjection[i];
    if (moved) refresh();
  }

  function enable() {
    if (removeChanged || removeEnd || removeFrame) return;
    removeChanged = engine.camera.changed.addEventListener(cameraChanged);
    removeEnd = engine.camera.moveEnd.addEventListener(cameraChanged);
    removeFrame = engine.frames.preRender.addEventListener(frame);
    shown = true;
    publishLabels();
    overlayHost.setVisible(LAYER_ID, true);
    cameraChanged();
  }

  function hide() {
    removeChanged?.();
    removeEnd?.();
    removeFrame?.();
    removeChanged = removeEnd = removeFrame = null;
    shown = false;
    if (points) {
      for (let index = 0; index < ordered.length; index++) {
        ordered[index].view.show = false;
        points.set(index, { show: false });
      }
      points.commit();
    }
    overlayHost.clearSource(LAYER_ID);
    overlayHost.setVisible(LAYER_ID, false);
    shownPoints = 0;
  }

  function sync(records) {
    points ??= engine.movers.createSet({
      id: NAMED_MARKER_SET_ID,
      kind: 'point',
      capacity: MILITARY_POINT_CAP,
      order: NAMED_MARKER_ORDER,
      depthTest: 'always',
      pickable: true,
      point: {
        sizePx: NAMED_MARKER_SIZE_PX,
        outlinePx: MARKER_OUTLINE_PX,
        outlineColor: NAMED_MARKER_OUTLINE_COLOR,
      },
    });
    shown = state.enabled;
    const named = records
      .filter((r) => r.namedArea || r.id === state.selectedId)
      .sort(
        (a, b) =>
          Number(b.id === state.selectedId) -
            Number(a.id === state.selectedId) || b.areaM2 - a.areaM2,
      )
      .slice(0, MILITARY_POINT_CAP);
    const keep = new Set(named.map((r) => r.id));
    // A canonical record takes over its alias's disc and title.
    for (const record of named) {
      if (markers.has(record.id)) continue;
      const alias = record.aliasIds?.find(
        (id) => !keep.has(id) && markers.has(id),
      );
      if (!alias) continue;
      const marker = markers.get(alias);
      markers.delete(alias);
      marker.view.id = { installationId: record.id };
      marker.entry.id = record.id;
      markers.set(record.id, marker);
    }
    for (const id of [...markers.keys()]) if (!keep.has(id)) markers.delete(id);
    ordered = [];
    entries = [];
    for (const record of named) {
      const position = geo.cartesian3.fromDegrees(
        record.longitude,
        record.latitude,
        record.pointOnly ? 0 : parts.model.installationSurfaceHeightM(record),
      );
      let marker = markers.get(record.id);
      if (!marker) {
        marker = {
          view: { id: { installationId: record.id }, position, show: false },
          entry: createInfrastructureOverlayEntry({
            id: record.id,
            source: LAYER_ID,
            position,
            title: installationTitle(record.name),
            priority: record.areaM2 || 0,
            accent: installationAccent(record),
          }),
        };
        markers.set(record.id, marker);
      }
      marker.view.position = position;
      marker.named = record.namedArea;
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
      points.set(ordered.length, {
        position,
        color: parts.model.colorFor(record).rgba(),
        pickId: record.id,
        show: marker.view.show,
      });
      entries.push(marker.entry);
      ordered.push(marker);
    }
    points.setCount(ordered.length);
    points.commit();
    if (state.enabled) publishLabels();
    refresh();
    services.render.governorRequestRender('installation-names', engine);
  }

  return {
    sync,
    /** Each disc: its site id and `{ id, position, show }`. */
    visit(visitor) {
      for (let i = 0; i < ordered.length; i++) {
        const marker = ordered[i];
        visitor(marker.view.id.installationId, marker.view);
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
      points?.destroy();
      points = null;
      entries = [];
      markers.clear();
    },
  };
}
