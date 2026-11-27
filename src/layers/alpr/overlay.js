import {
  MAX_CANVAS_FRUSTUMS,
  MARKER_ICON_SIZE,
  SELECTED_MARKER_ICON_SIZE,
  MARKER_FLOOR_LIFT_M,
  REMEMBERED_SURFACE_ANSWERS,
  SURFACE_BELOW_FLOOR_M,
  SURFACE_ABOVE_FLOOR_M,
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
import {
  cameraOf,
  findGlobe,
  findQuery,
  rendererOf,
} from '../../render/rendererOf.js';

const nextAnimationFrame = (step) =>
  typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(step)
    : setTimeout(step, 16);

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
  requestFrame = nextAnimationFrame,
}) {
  let lane,
    removeMapListener,
    retryTimer,
    retryUntil = 0;
  let records = [],
    hits = [],
    images = [],
    destroyed = false,
    lastCamera = null,
    sampling = false;
  // Depth-sample answers by camera id: they outlive the markers, which go
  // when a camera leaves the view or the layer is turned off.
  const surfaceAnswers = new Map();
  /** Cameras whose anchor sample missed: they wait for the others' turn. */
  const missed = new Set();
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

  function rememberSurface(record, height, checked) {
    surfaceAnswers.delete(record.id);
    surfaceAnswers.set(record.id, {
      latitude: record.latitude,
      longitude: record.longitude,
      height,
      checked,
    });
    if (surfaceAnswers.size > REMEMBERED_SURFACE_ANSWERS)
      surfaceAnswers.delete(surfaceAnswers.keys().next().value);
  }

  /**
   * Height under a camera now: its terrain, or a depth sample of the drawn
   * surface, which renders depth (and compiles shaders on first use). A miss
   * is tiles still streaming. The markers are no ground: a sample sees
   * through them.
   */
  function heightAt(record, against) {
    const query = findQuery(state.viewer);
    if (!query) return null;
    const point = { lon: record.longitude, lat: record.latitude };
    return against === 'terrain'
      ? query.sampleHeightNow(point, { against: 'terrain' })
      : query.sampleHeightNow(point, { exclude: [markers.icons?.id] });
  }

  function canReadSurface() {
    return (
      Boolean(findQuery(state.viewer)) && (globeShown() || canSampleHeight())
    );
  }

  /** A cached, remembered, floor or terrain anchor (no depth sample), or null. */
  function anchorFor(record, carrier) {
    const cached = alprMarkers.read(carrier)?.canvasPosition;
    if (cached) return cached;
    const floor = floorHeightAt(record.latitude, record.longitude);
    const answer = surfaceAnswers.get(record.id);
    if (
      answer?.latitude === record.latitude &&
      answer.longitude === record.longitude
    ) {
      surfaceAnswers.delete(record.id);
      // An unchecked answer stands in only until the floor resolves, a
      // checked one only within the floor window.
      if (
        answer.checked
          ? withinFloorWindow(answer.height - MARKER_FLOOR_LIFT_M, record)
          : floor === null
      ) {
        surfaceAnswers.set(record.id, answer);
        setAnchor(record, carrier, answer.height);
        const marker = alprMarkers.write(carrier);
        if (answer.checked) marker.surfaceCheckedFor = marker.canvasPosition;
        return marker.canvasPosition;
      }
    }
    // A floor-placed marker anchors where its native badge sits. A marker
    // still waiting for its floor reads the globe's terrain while the globe
    // is drawn (hidden under photoreal tiles, its height is not what shows),
    // or waits for a depth sample in sampleAnchors().
    const height = floor ?? (globeShown() ? heightAt(record, 'terrain') : null);
    if (!validAlprGroundHeight(height)) return null;
    setAnchor(record, carrier, height);
    return alprMarkers.read(carrier)?.canvasPosition;
  }

  /**
   * Whether the renderer can depth-sample the drawn surface (Cesium needs
   * depth textures).
   */
  function canSampleHeight() {
    const capabilities = rendererOf(state.viewer)?.capabilities;
    return !capabilities || capabilities.has('sampleHeight');
  }

  /** Whether the globe port says its surface is drawn; undefined if it cannot. */
  function globeVisible() {
    return findGlobe(state.viewer)?.isGlobeVisible?.();
  }

  /** Whether the globe surface is drawn; true where the renderer cannot say. */
  function globeShown() {
    return globeVisible() !== false;
  }

  /**
   * Whether the drawn surface is depth-sampled: photoreal tiles, or a scene
   * that cannot say whether it draws a globe.
   */
  function depthSampled() {
    return globeVisible() !== true && canSampleHeight();
  }

  function floorHeightAt(latitude, longitude) {
    const floor = services.groundFloor.cachedGroundFloor(latitude, longitude);
    return validAlprGroundHeight(floor) ? floor + MARKER_FLOOR_LIFT_M : null;
  }

  /**
   * Whether a surface height is within the floor window; any height is
   * while the floor is unknown.
   */
  function withinFloorWindow(surface, record) {
    const floor = services.groundFloor.cachedGroundFloor(
      record.latitude,
      record.longitude,
    );
    return (
      !validAlprGroundHeight(floor) ||
      (surface >= floor - SURFACE_BELOW_FLOOR_M &&
        surface <= floor + SURFACE_ABOVE_FLOOR_M)
    );
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
    const globe = findGlobe(state.viewer);
    // The globe's terrain while it is shown, otherwise the shown 3D tiles.
    // A viewer with no globe port cannot say; its samples are still checked
    // against the floor.
    return !globe || globe.isSettled('surface');
  }

  /**
   * Sample the rendered surface for the overlay cameras, outside the paint.
   *
   * A camera with no floor yet gets its anchor from a depth sample. An
   * anchored one is checked against the surface once: floors come from
   * ~111 m cells, so on a slope a badge could float or sink by tens of
   * metres. Checks run only while the camera is still and tiles have
   * settled, and a sample far outside the floor window (a roof or a
   * streaming tile) puts the badge on its floor. Each frame takes one
   * sample, so no frame carries the whole cohort; a camera whose sample
   * missed waits until the others have had theirs.
   */
  function sampleAnchors() {
    sampling = false;
    if (destroyed || !state.enabled) return;
    const pose = cameraOf(state.viewer).pose();
    const still =
      lastCamera &&
      near(pose.position, lastCamera.position, 0.05) &&
      near(pose.direction, lastCamera.direction, 1e-6);
    lastCamera = {
      position: { ...pose.position },
      direction: { ...pose.direction },
    };
    const canSample = canReadSurface();
    const depth = depthSampled();
    let sampled = false,
      pending = false,
      progressed = false,
      moved = false;
    // Cameras with no anchor come first: they are not on the overlay yet.
    for (const record of records) {
      const carrier = markers.get(record.id);
      if (!carrier || alprMarkers.read(carrier)?.canvasPosition) continue;
      // The floor may have resolved since the paint that found none.
      if (anchorFor(record, carrier)) moved = true;
      else if (!depth || sampled || missed.has(record.id)) pending = true;
      else {
        sampled = true;
        const sample = heightAt(record);
        if (validAlprGroundHeight(sample)) {
          setAnchor(record, carrier, sample);
          rememberSurface(record, sample, false);
          moved = progressed = true;
        } else {
          missed.add(record.id);
          pending = true;
        }
      }
    }
    for (const record of records) {
      const carrier = markers.get(record.id);
      const marker = alprMarkers.read(carrier);
      const anchor = marker?.canvasPosition;
      if (!anchor || !canSample || marker.surfaceCheckedFor === anchor)
        continue;
      if (sampled || !still || !surfaceSettled()) {
        pending = true;
        continue;
      }
      sampled = progressed = true;
      let sample = depth ? heightAt(record) : null;
      const fromDepth = validAlprGroundHeight(sample);
      if (!fromDepth && globeShown()) sample = heightAt(record, 'terrain');
      let height = toLonLatH(anchor)?.height;
      const target = !validAlprGroundHeight(sample)
        ? height
        : withinFloorWindow(sample, record)
          ? sample + MARKER_FLOOR_LIFT_M
          : floorHeightAt(record.latitude, record.longitude);
      if (Math.abs(target - height) > 1) {
        height = target;
        setAnchor(record, carrier, height);
        moved = true;
      }
      // setAnchor rewrote the same record, so this is the new anchor.
      marker.surfaceCheckedFor = marker.canvasPosition;
      // Only depth answers are kept: a drawn globe's terrain is read again,
      // as finer tiles load. One that did not answer is asked after a rebuild.
      if (fromDepth) rememberSurface(record, height, true);
      if (carrier.id === state.selectedId)
        marker.displayPosition = marker.canvasPosition;
    }
    // Every waiting camera has had its turn: those that missed go again.
    if (!sampled) missed.clear();
    if (moved) requestPaint();
    if (!pending) return;
    // The next sample on the next frame; when nothing could be sampled
    // (camera moving, tiles streaming, no floor yet) look again in 250 ms,
    // for 15 s after the view changed. A later paint still queues one.
    if (progressed) scheduleSampling();
    else if (!retryTimer && Date.now() < retryUntil)
      retryTimer = setTimeout(() => {
        retryTimer = null;
        scheduleSampling();
      }, 250);
  }

  function scheduleSampling() {
    if (sampling) return;
    sampling = true;
    requestFrame(sampleAnchors);
  }

  function paint({ ctx, width, height, keyhole, occluder }) {
    hits = [];
    if (!state.enabled || destroyed) return;
    let waiting = false;
    const painted = [];
    const canSample = canReadSurface();
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
      const anchor = anchorFor(record, carrier);
      if (!anchor) {
        nativeVisible(carrier, true);
        waiting = true;
        continue;
      }
      if (canSample && alprMarkers.read(carrier)?.surfaceCheckedFor !== anchor)
        waiting = true;
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
    markers.flush();
    // Unfound or unchecked anchors are sampled after the paint, never in it.
    if (waiting && !retryTimer) scheduleSampling();
  }

  return {
    init() {
      destroyed = false;
      removeMapListener = services.overlays?.subscribeMapStack?.((event) => {
        if (event.detail?.status !== 'ready') return;
        // The old surface's answers go even while the layer is off.
        surfaceAnswers.clear();
        if (!state.enabled) return;
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
