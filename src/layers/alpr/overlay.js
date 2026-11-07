import {
  MAX_CANVAS_FRUSTUMS,
  MARKER_ICON_SIZE,
  SELECTED_MARKER_ICON_SIZE,
  MARKER_FLOOR_LIFT_M,
  ANCHOR_SAMPLES_PER_PAINT,
  SURFACE_BELOW_FLOOR_M,
  SURFACE_ABOVE_FLOOR_M,
  SURFACE_SAMPLES_PER_PAINT,
} from './policy.js';
import {
  MARKER_IMAGE,
  SELECTED_IMAGE,
  BRACKETS_IMAGE,
  directionWedgePositions,
  markerScale,
  paintDirectionWedge,
  validAlprGroundHeight,
} from './visuals.js';
import { alprMarkers } from './markerState.js';
import { distance, fromDegrees, toLonLatH } from '../../geo/index.js';
import { cameraOf, findQuery, rendererOf } from '../../render/rendererOf.js';

let lanes = 0;

/** Within `epsilon` on every axis. */
const near = (a, b, epsilon) =>
  Math.abs(a.x - b.x) <= epsilon &&
  Math.abs(a.y - b.y) <= epsilon &&
  Math.abs(a.z - b.z) <= epsilon;

/** Per-layer presentation on a caller-owned overlay; the icon set remains the fallback. */
export function createAlprOverlay({
  state,
  services,
  onSurfaceChange = () => {},
}) {
  let lane,
    removeMapListener,
    retryTimer,
    retryUntil = 0;
  let records = [],
    hits = [],
    images = [],
    destroyed = false,
    lastCamera = null;
  const requestPaint = () => {
    if (!destroyed && state.enabled) lane?.requestPaint();
  };

  const markers = state.markers;

  function nativeVisible(carrier, visible) {
    if (!carrier) return;
    canvasOwned(carrier, !visible);
    setShown(carrier, visible);
  }

  /**
   * Swap a marker between its native look and a faint canvas pick target.
   * The faint icon stays under the canvas badge, at its anchor, so sibling
   * layer handlers recognize ALPR ownership instead of treating the click
   * as empty.
   */
  function canvasOwned(carrier, owned) {
    const marker = alprMarkers.write(carrier);
    if (Boolean(marker.canvasOwned) === owned) return;
    marker.canvasOwned = owned;
    markers.changed(carrier);
  }

  // Changed only on change: the icon is sent again only when it draws
  // differently.
  function setShown(carrier, visible) {
    const marker = alprMarkers.write(carrier);
    if ((marker.shown ?? true) === visible) return;
    marker.shown = visible;
    markers.changed(carrier);
  }

  function resetAnchors() {
    for (const carrier of markers.values()) {
      const marker = alprMarkers.write(carrier);
      marker.canvasPosition = null;
      marker.wedge = null;
      marker.displayPosition = null;
      nativeVisible(carrier, true);
    }
    markers.flush();
    state.lastAnchorSampleAt = 0;
    retryUntil = Date.now() + 15000;
    requestPaint();
  }

  function anchorFor(record, carrier, budget) {
    const cached = alprMarkers.read(carrier)?.canvasPosition;
    if (cached) return cached;
    const query = findQuery(state.viewer);
    const point = { lon: record.longitude, lat: record.latitude };
    // A floor-placed marker anchors where its native badge sits; only a
    // marker still waiting for its floor samples the rendered surface, and
    // each paint samples a few at most (each sample is a depth render).
    let height;
    const floor = services.groundFloor.cachedGroundFloor(
      record.latitude,
      record.longitude,
    );
    if (validAlprGroundHeight(floor)) height = floor + MARKER_FLOOR_LIFT_M;
    else if (query) {
      if (budget.samples <= 0) return null;
      budget.samples -= 1;
      // A miss is tiles still streaming.
      height = query.sampleHeightNow(point, { exclude: [markers.icons?.id] });
    }
    if (!validAlprGroundHeight(height))
      height = query?.sampleHeightNow(point, { against: 'terrain' });
    if (!validAlprGroundHeight(height)) return null;
    setAnchor(record, carrier, height);
    return alprMarkers.read(carrier)?.canvasPosition;
  }

  function floorHeightAt(latitude, longitude) {
    const floor = services.groundFloor.cachedGroundFloor(latitude, longitude);
    return validAlprGroundHeight(floor) ? floor + MARKER_FLOOR_LIFT_M : null;
  }

  function setAnchor(record, carrier, height) {
    const marker = alprMarkers.write(carrier);
    marker.canvasPosition = fromDegrees(
      record.longitude,
      record.latitude,
      height,
    );
    marker.wedge = directionWedgePositions(record, height, floorHeightAt);
    if (marker.canvasOwned) markers.changed(carrier);
  }

  /** Whether the visible photoreal tiles (or globe) have finished streaming. */
  function surfaceSettled() {
    const globe = rendererOf(state.viewer)?.globe;
    // A viewer with no renderer of its own cannot say; its samples are
    // still checked against the floor.
    return !globe || (globe.isSettled('terrain') && globe.isSettled('tiles'));
  }

  /**
   * Replace floor anchors with the rendered surface under each overlay camera.
   * Floors come from ~111 m cells, so on a slope a badge could float or sink
   * by tens of metres. Runs only while the camera is still and tiles have
   * settled, a few depth samples per paint, and each anchor at most once;
   * samples far outside the floor prior (a roof or a streaming tile) are
   * rejected. Returns whether anchors remain to check.
   */
  function refineAnchors(budget, pose) {
    const still =
      lastCamera &&
      near(pose.position, lastCamera.position, 0.05) &&
      near(pose.direction, lastCamera.direction, 1e-6);
    lastCamera = {
      position: { ...pose.position },
      direction: { ...pose.direction },
    };
    const query = findQuery(state.viewer);
    if (!query) return false;
    let pending = false;
    for (const record of records) {
      const carrier = markers.get(record.id);
      const marker = alprMarkers.read(carrier);
      const anchor = marker?.canvasPosition;
      if (!anchor || marker.surfaceCheckedFor === anchor) continue;
      if (!still || !surfaceSettled() || budget.samples <= 0) {
        pending = true;
        continue;
      }
      budget.samples -= 1;
      // A miss is tiles still streaming.
      const sample = query.sampleHeightNow(
        { lon: record.longitude, lat: record.latitude },
        { exclude: [markers.icons?.id] },
      );
      const current = toLonLatH(anchor)?.height;
      const floor = services.groundFloor.cachedGroundFloor(
        record.latitude,
        record.longitude,
      );
      const accepted =
        validAlprGroundHeight(sample) &&
        (!validAlprGroundHeight(floor) ||
          (sample >= floor - SURFACE_BELOW_FLOOR_M &&
            sample <= floor + SURFACE_ABOVE_FLOOR_M));
      if (accepted && Math.abs(sample + MARKER_FLOOR_LIFT_M - current) > 1)
        setAnchor(record, carrier, sample + MARKER_FLOOR_LIFT_M);
      // setAnchor rewrote the same record, so this is the new anchor.
      marker.surfaceCheckedFor = marker.canvasPosition;
      if (carrier.id === state.selectedId)
        marker.displayPosition = marker.canvasPosition;
    }
    return pending;
  }

  function paint({ ctx, width, height, keyhole, occluder }) {
    hits = [];
    if (!state.enabled || destroyed) return;
    let unresolved = false;
    const painted = [];
    const budget = { samples: ANCHOR_SAMPLES_PER_PAINT };
    const pose = cameraOf(state.viewer).pose();
    const query = findQuery(state.viewer);
    for (const record of records) {
      const carrier = markers.get(record.id);
      if (!carrier) continue;
      const selected = record.id === state.selectedId;
      const image = images[selected ? 1 : 0];
      if (
        !image?.complete ||
        !image.naturalWidth ||
        (selected && !images[2]?.naturalWidth)
      ) {
        nativeVisible(carrier, true);
        continue;
      }
      const anchor = anchorFor(record, carrier, budget);
      if (!anchor) {
        nativeVisible(carrier, true);
        unresolved = true;
        continue;
      }
      canvasOwned(carrier, true);
      if (occluder && !occluder.isPointVisible(anchor)) {
        setShown(carrier, false);
        continue;
      }
      const origin = query?.project(anchor);
      if (!origin) {
        setShown(carrier, false);
        continue;
      }
      const alpha =
        services.overlays.keyholeAlpha?.(origin.x, origin.y, keyhole) ?? 1;
      if (!(alpha > 0)) {
        setShown(carrier, false);
        continue;
      }
      const wedge = alprMarkers.read(carrier)?.wedge;
      if (wedge) {
        const left = query.project(wedge[1]);
        const right = query.project(wedge[2]);
        if (left && right) {
          ctx.save();
          ctx.globalAlpha *= alpha;
          paintDirectionWedge(ctx, origin, left, right, selected);
          ctx.restore();
        }
      }
      if (
        origin.x < -60 ||
        origin.x > width + 60 ||
        origin.y < -60 ||
        origin.y > height + 60
      ) {
        setShown(carrier, false);
        continue;
      }
      setShown(carrier, true);
      painted.push({
        record,
        origin,
        selected,
        image,
        alpha,
        scale: markerScale(distance(pose.position, anchor)),
      });
      if (selected) alprMarkers.write(carrier).displayPosition = anchor;
    }
    // Paint all glyphs after the wedges so one camera's cone cannot wash out another.
    for (const { record, origin, selected, image, alpha, scale } of painted) {
      const size =
        (selected ? SELECTED_MARKER_ICON_SIZE : MARKER_ICON_SIZE) * scale;
      ctx.save();
      ctx.globalAlpha *= alpha;
      ctx.drawImage(
        image,
        origin.x - size / 2,
        origin.y - size / 2,
        size,
        size,
      );
      if (selected)
        ctx.drawImage(
          images[2],
          origin.x - size / 2,
          origin.y - size / 2,
          size,
          size,
        );
      ctx.restore();
      hits.push({ id: record.id, x: origin.x, y: origin.y, radius: size / 2 });
    }
    const refining = refineAnchors(
      { samples: Math.min(budget.samples, SURFACE_SAMPLES_PER_PAINT) },
      pose,
    );
    markers.flush();
    if ((unresolved || refining) && !retryTimer && Date.now() < retryUntil) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        requestPaint();
      }, 250);
    }
  }

  return {
    init() {
      destroyed = false;
      removeMapListener = services.overlays?.subscribeMapStack?.((event) => {
        if (event.detail?.status !== 'ready' || !state.enabled) return;
        // Same-regime provider changes also invalidate absolute placements.
        onSurfaceChange();
        resetAnchors();
      });
      if (!services.overlays?.registerPaintLane || typeof Image === 'undefined')
        return;
      lane = services.overlays.registerPaintLane('selected', paint, {
        id: `alpr-${++lanes}`,
        active: false,
      });
      images = [MARKER_IMAGE, SELECTED_IMAGE, BRACKETS_IMAGE].map((src) => {
        const image = new Image();
        image.onload = requestPaint;
        image.onerror = requestPaint;
        image.src = src;
        return image;
      });
    },
    sync(visible) {
      if (!lane) return;
      const previous = records;
      const position = cameraOf(state.viewer).pose().position;
      records = visible
        .filter(
          (record) =>
            Number.isFinite(record.directionDeg) &&
            record.id !== state.selectedId,
        )
        .map((record) => ({
          record,
          distance: position
            ? distance(
                position,
                fromDegrees(record.longitude, record.latitude),
              ) ** 2
            : 0,
        }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, MAX_CANVAS_FRUSTUMS)
        .map((item) => item.record);
      const selected = visible.find((record) => record.id === state.selectedId);
      if (selected) {
        if (records.length >= MAX_CANVAS_FRUSTUMS) records.pop();
        records.push(selected);
      }
      // Cameras that leave the cohort go native; those that stay keep the
      // canvas until the next paint, so their icons are not written twice.
      const kept = new Set(records.map((record) => record.id));
      for (const record of previous)
        if (!kept.has(record.id)) nativeVisible(markers.get(record.id), true);
      hits = [];
      retryUntil = Date.now() + 15000;
      lane.setActive(state.enabled && records.length > 0);
      requestPaint();
    },
    pick(position) {
      if (!state.enabled || !position) return null;
      let closest,
        distance = Infinity;
      for (const hit of hits) {
        const next = (hit.x - position.x) ** 2 + (hit.y - position.y) ** 2;
        if (next <= hit.radius ** 2 && next <= distance) {
          closest = hit.id;
          distance = next;
        }
      }
      return closest || null;
    },
    clear() {
      clearTimeout(retryTimer);
      retryTimer = null;
      for (const record of records) nativeVisible(markers.get(record.id), true);
      markers.flush();
      records = [];
      hits = [];
      lane?.setActive(false);
    },
    destroy() {
      this.clear();
      destroyed = true;
      removeMapListener?.();
      removeMapListener = null;
      lane?.unregister();
      lane = null;
      for (const image of images) {
        image.onload = null;
        image.onerror = null;
      }
      images = [];
    },
  };
}
