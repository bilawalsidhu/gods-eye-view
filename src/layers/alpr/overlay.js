import * as geo from '../../geo/index.js';
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

let overlaySequence = 0;

/**
 * Canvas artwork for the nearest ALPR cameras over each engine's native
 * markers, with bounded surface refinement. The engine adapter owns marker
 * lookup and appearance, surface sampling, the camera pose and projection.
 * @param {object} options
 * @param {object} options.state Layer state.
 * @param {object} options.services Layer services.
 * @param {function(): void} [options.onSurfaceChange] Map stack changed.
 * @param {object} options.engine Globe engine.
 */
export function createAlprOverlayCore({
  state,
  services,
  onSurfaceChange = () => {},
  engine,
  markers,
  syncMarker,
  sampleHeight,
  terrainHeight,
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

  function canvasOwned(marker, owned) {
    if (marker.canvasOwned === owned) return;
    marker.canvasOwned = owned;
    syncMarker(marker);
  }

  function setShown(marker, shown) {
    if (marker.shown === shown) return;
    marker.shown = shown;
    syncMarker(marker);
  }

  function nativeVisible(marker, visible) {
    if (!marker) return;
    canvasOwned(marker, !visible);
    setShown(marker, visible);
  }

  function resetAnchors() {
    for (const marker of markers.values()) {
      marker.gevAlprCanvasPosition = null;
      marker.gevAlprWedge = null;
      marker.displayPosition = null;
      nativeVisible(marker, true);
    }
    state.lastAnchorSampleAt = 0;
    retryUntil = Date.now() + 15000;
    requestPaint();
  }

  function anchorFor(record, marker, budget) {
    if (marker.gevAlprCanvasPosition) return marker.gevAlprCanvasPosition;
    // A floor-placed marker anchors where its native badge sits; only a
    // marker still waiting for its floor samples the rendered surface, and
    // each paint samples a few at most.
    let height;
    const floor = services.groundFloor.cachedGroundFloor(
      record.latitude,
      record.longitude,
    );
    if (validAlprGroundHeight(floor)) height = floor + MARKER_FLOOR_LIFT_M;
    else if (engine.surface.supported) {
      if (budget.samples <= 0) return null;
      budget.samples -= 1;
      try {
        height = sampleHeight(record, marker);
      } catch {
        /* streaming tiles */
      }
    }
    if (!validAlprGroundHeight(height)) height = terrainHeight(record);
    if (!validAlprGroundHeight(height)) return null;
    setAnchor(record, marker, height);
    return marker.gevAlprCanvasPosition;
  }

  function floorHeightAt(latitude, longitude) {
    const floor = services.groundFloor.cachedGroundFloor(latitude, longitude);
    return validAlprGroundHeight(floor) ? floor + MARKER_FLOOR_LIFT_M : null;
  }

  function setAnchor(record, marker, height) {
    marker.gevAlprCanvasPosition = geo.cartesian3.fromDegrees(
      record.longitude,
      record.latitude,
      height,
    );
    marker.resolved = true;
    syncMarker(marker);
    marker.gevAlprWedge = directionWedgePositions(
      record,
      height,
      floorHeightAt,
    );
  }

  /**
   * Replace floor anchors with the rendered surface under each overlay camera.
   * Floors come from ~111 m cells, so on a slope a badge could float or sink
   * by tens of metres. Runs only while the camera is still and tiles have
   * settled, a few surface samples per paint, and each anchor at most once;
   * samples far outside the floor prior (a roof or a streaming tile) are
   * rejected. Returns whether anchors remain to check.
   */
  function refineAnchors(budget) {
    const camera = engine.camera.pose();
    const still =
      lastCamera &&
      camera.position &&
      geo.cartesian3.equalsEpsilon(
        camera.position,
        lastCamera.position,
        0,
        0.05,
      ) &&
      geo.cartesian3.equalsEpsilon(
        camera.direction,
        lastCamera.direction,
        0,
        1e-6,
      );
    if (camera.position && camera.direction)
      lastCamera = {
        position: geo.cartesian3.clone(camera.position),
        direction: geo.cartesian3.clone(camera.direction),
      };
    if (!engine.surface.supported) return false;
    let pending = false;
    for (const record of records) {
      const marker = markers.get(record.id);
      const anchor = marker?.gevAlprCanvasPosition;
      if (!anchor || marker.gevAlprSurfaceCheckedFor === anchor) continue;
      if (!still || !engine.surface.tilesLoaded() || budget.samples <= 0) {
        pending = true;
        continue;
      }
      budget.samples -= 1;
      let sample;
      try {
        sample = sampleHeight(record, marker);
      } catch {
        /* streaming tiles */
      }
      const current = geo.cartographic.fromCartesian(anchor).height;
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
        setAnchor(record, marker, sample + MARKER_FLOOR_LIFT_M);
      marker.gevAlprSurfaceCheckedFor = marker.gevAlprCanvasPosition;
      if (marker.id === state.selectedId)
        marker.displayPosition = marker.gevAlprCanvasPosition;
    }
    return pending;
  }

  function paint(frame) {
    const { ctx, width, height, keyhole } = frame;
    hits = [];
    if (!state.enabled || destroyed) return;
    const horizonVisible = (point) => engine.projector.horizonVisible(point);
    const matrix = frame.viewProjectionMatrix;
    function project({ x, y, z }) {
      const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
      if (!(w > 0)) return null;
      return {
        x:
          (((matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w +
            1) *
            width) /
          2,
        y:
          ((1 -
            (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w) *
            height) /
          2,
      };
    }
    let unresolved = false;
    const painted = [];
    const budget = { samples: ANCHOR_SAMPLES_PER_PAINT };
    for (const record of records) {
      const marker = markers.get(record.id);
      if (!marker) continue;
      const selected = record.id === state.selectedId;
      const image = images[selected ? 1 : 0];
      if (
        !image?.complete ||
        !image.naturalWidth ||
        (selected && !images[2]?.naturalWidth)
      ) {
        nativeVisible(marker, true);
        continue;
      }
      const anchor = anchorFor(record, marker, budget);
      if (!anchor) {
        nativeVisible(marker, true);
        unresolved = true;
        continue;
      }
      canvasOwned(marker, true);
      if (!horizonVisible(anchor)) {
        setShown(marker, false);
        continue;
      }
      const origin = project(anchor);
      if (!origin) {
        setShown(marker, false);
        continue;
      }
      const alpha =
        services.overlays.keyholeAlpha?.(origin.x, origin.y, keyhole) ?? 1;
      if (!(alpha > 0)) {
        setShown(marker, false);
        continue;
      }
      const wedge = marker.gevAlprWedge;
      if (wedge) {
        const left = project(wedge[1]);
        const right = project(wedge[2]);
        if (
          left &&
          right &&
          Math.max(origin.x, left.x, right.x) >= -3 &&
          Math.min(origin.x, left.x, right.x) <= width + 3 &&
          Math.max(origin.y, left.y, right.y) >= -3 &&
          Math.min(origin.y, left.y, right.y) <= height + 3
        ) {
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
        setShown(marker, false);
        continue;
      }
      setShown(marker, true);
      painted.push({
        record,
        origin,
        selected,
        image,
        alpha,
        scale: markerScale(
          geo.cartesian3.distance(engine.camera.livePosition, anchor),
        ),
      });
      if (selected) marker.displayPosition = anchor;
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
    const refining = refineAnchors({
      samples: Math.min(budget.samples, SURFACE_SAMPLES_PER_PAINT),
    });
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
        id: `alpr-${++overlaySequence}`,
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
      for (const record of records) nativeVisible(markers.get(record.id), true);
      const position = engine.camera.livePosition;
      records = visible
        .filter(
          (record) =>
            Number.isFinite(record.directionDeg) &&
            record.id !== state.selectedId,
        )
        .map((record) => ({
          record,
          distance: position
            ? geo.cartesian3.distanceSquared(
                position,
                geo.cartesian3.fromDegrees(record.longitude, record.latitude),
              )
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
