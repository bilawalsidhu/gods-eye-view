import * as Cesium from 'cesium';
import {
  MAX_CANVAS_FRUSTUMS,
  MARKER_ICON_SIZE,
  SELECTED_MARKER_ICON_SIZE,
  MARKER_FLOOR_LIFT_M,
  REMEMBERED_ANCHORS,
  SURFACE_BELOW_FLOOR_M,
  SURFACE_ABOVE_FLOOR_M,
  SURFACE_SAMPLES_PER_FRAME,
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

const nextAnimationFrame = (step) =>
  typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(step)
    : setTimeout(step, 16);

/** Per-layer presentation on a caller-owned overlay; Cesium remains the fallback. */
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
  // Rendered-surface answers by camera id. Entities are rebuilt by a refresh
  // and by turning the layer off and on; keeping the answers on them meant
  // every rebuild sampled the same cameras again.
  const surfaceAnswers = new Map();
  const requestPaint = () => {
    if (!destroyed && state.enabled) lane?.requestPaint();
  };

  function nativeVisible(entity, visible) {
    if (!entity) return;
    canvasOwned(entity, !visible);
    setShown(entity, visible);
  }

  /** Swap a marker between its native look and a faint canvas pick target. */
  function canvasOwned(entity, owned) {
    const visible = !owned;
    const billboard = entity.billboard;
    // Keep a faint native pick target under the canvas badge so sibling layer
    // handlers recognize ALPR ownership instead of treating the click as empty.
    if (!visible && !entity.gevAlprNativeAppearance) {
      entity.gevAlprNativeAppearance = {
        position: entity.position,
        heightReference: billboard.heightReference,
        scaleByDistance: billboard.scaleByDistance,
        color: billboard.color,
      };
      entity.position = entity.gevAlprCanvasPosition;
      entity.gevAlprPickPosition = entity.position;
      billboard.heightReference = Cesium.HeightReference.NONE;
      billboard.scaleByDistance = undefined;
      billboard.color = Cesium.Color.WHITE.withAlpha(0.01);
    } else if (visible && entity.gevAlprNativeAppearance) {
      const saved = entity.gevAlprNativeAppearance;
      if (entity.position === entity.gevAlprPickPosition)
        entity.position = saved.position;
      billboard.heightReference = saved.heightReference;
      billboard.scaleByDistance = saved.scaleByDistance;
      billboard.color = saved.color;
      entity.gevAlprNativeAppearance = null;
      entity.gevAlprPickPosition = null;
    }
  }

  // Assign only on change: each Entity property write mints a new property
  // and raises definitionChanged, which paint used to do for every overlay
  // camera on every frame.
  function setShown(entity, visible) {
    if (entity.gevAlprShown === visible) return;
    entity.gevAlprShown = visible;
    entity.billboard.show = visible;
    if (entity.polyline) entity.polyline.show = visible;
    if (entity.polygon) entity.polygon.show = visible;
  }

  function resetAnchors() {
    for (const entity of state.dataSource.entities.values) {
      entity.gevAlprCanvasPosition = null;
      entity.gevAlprWedge = null;
      entity.gevAlprDisplayPosition = null;
      nativeVisible(entity, true);
    }
    surfaceAnswers.clear();
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
    if (surfaceAnswers.size > REMEMBERED_ANCHORS)
      surfaceAnswers.delete(surfaceAnswers.keys().next().value);
  }

  /**
   * Rendered surface height under a camera. A terrain globe answers from its
   * loaded mesh; only photoreal tiles need `sampleHeight`, which renders depth
   * and compiles its shaders on first use (a freeze of up to 1.9 s at load).
   */
  function surfaceHeight(record, entity) {
    const scene = state.viewer.scene;
    const location = Cesium.Cartographic.fromDegrees(
      record.longitude,
      record.latitude,
    );
    if (scene.globe?.show) return scene.globe.getHeight?.(location);
    if (!scene.sampleHeightSupported) return undefined;
    try {
      return scene.sampleHeight(location, [entity]);
    } catch {
      /* streaming tiles */
      return undefined;
    }
  }

  /** The anchor a paint can have without sampling, or null while it waits for one. */
  function anchorFor(record, entity) {
    if (entity.gevAlprCanvasPosition) return entity.gevAlprCanvasPosition;
    const scene = state.viewer.scene;
    const answer = surfaceAnswers.get(record.id);
    if (
      answer?.latitude === record.latitude &&
      answer.longitude === record.longitude
    ) {
      setAnchor(record, entity, answer.height);
      if (answer.checked)
        entity.gevAlprSurfaceCheckedFor = entity.gevAlprCanvasPosition;
      return entity.gevAlprCanvasPosition;
    }
    // A floor-placed marker anchors where its native badge sits. A marker
    // still waiting for its floor reads the terrain globe, or on photoreal
    // tiles waits for sampleAnchors().
    let height;
    const floor = services.groundFloor.cachedGroundFloor(
      record.latitude,
      record.longitude,
    );
    if (validAlprGroundHeight(floor)) height = floor + MARKER_FLOOR_LIFT_M;
    else if (scene.globe.show)
      height = scene.globe.getHeight?.(
        Cesium.Cartographic.fromDegrees(record.longitude, record.latitude),
      );
    if (!validAlprGroundHeight(height)) return null;
    setAnchor(record, entity, height);
    return entity.gevAlprCanvasPosition;
  }

  function floorHeightAt(latitude, longitude) {
    const floor = services.groundFloor.cachedGroundFloor(latitude, longitude);
    return validAlprGroundHeight(floor) ? floor + MARKER_FLOOR_LIFT_M : null;
  }

  function setAnchor(record, entity, height) {
    entity.gevAlprCanvasPosition = Cesium.Cartesian3.fromDegrees(
      record.longitude,
      record.latitude,
      height,
    );
    entity.gevAlprWedge = directionWedgePositions(
      record,
      height,
      floorHeightAt,
    );
  }

  /** Whether the visible photoreal tiles (or globe) have finished streaming. */
  function surfaceSettled(scene) {
    if (scene.globe?.show) return scene.globe.tilesLoaded !== false;
    for (let i = 0; i < (scene.primitives?.length || 0); i++) {
      const primitive = scene.primitives.get(i);
      if (primitive?.show && primitive.tilesLoaded === false) return false;
    }
    return true;
  }

  /**
   * Sample the rendered surface for the overlay cameras, outside the paint.
   *
   * A camera with no floor yet gets its anchor from a sample. An anchored one
   * is checked against the surface once: floors come from ~111 m cells, so on
   * a slope a badge could float or sink by tens of metres. Checks run only
   * while the camera is still and tiles have settled, and samples far outside
   * the floor prior (a roof or a streaming tile) are rejected. Each frame
   * takes SURFACE_SAMPLES_PER_FRAME samples, so no frame carries the whole
   * cohort; sampling inside paint() put up to six depth renders in one frame.
   */
  function sampleAnchors() {
    sampling = false;
    if (destroyed || !state.enabled) return;
    const camera = state.viewer.camera;
    const scene = state.viewer.scene;
    const still =
      lastCamera &&
      camera.positionWC &&
      Cesium.Cartesian3.equalsEpsilon(
        camera.positionWC,
        lastCamera.position,
        0,
        0.05,
      ) &&
      Cesium.Cartesian3.equalsEpsilon(
        camera.directionWC,
        lastCamera.direction,
        0,
        1e-6,
      );
    if (camera.positionWC && camera.directionWC)
      lastCamera = {
        position: Cesium.Cartesian3.clone(camera.positionWC),
        direction: Cesium.Cartesian3.clone(camera.directionWC),
      };
    const canSample = scene.globe?.show || scene.sampleHeightSupported;
    let samples = SURFACE_SAMPLES_PER_FRAME,
      pending = false,
      progressed = false,
      moved = false;
    // Cameras with no anchor come first: they are not on the overlay yet.
    for (const record of records) {
      const entity = state.dataSource.entities.getById(record.id);
      if (!entity || entity.gevAlprCanvasPosition) continue;
      // The floor may have resolved since the paint that found none.
      if (anchorFor(record, entity)) moved = true;
      else if (!canSample || samples <= 0) pending = true;
      else {
        samples -= 1;
        const sample = surfaceHeight(record, entity);
        if (validAlprGroundHeight(sample)) {
          setAnchor(record, entity, sample);
          rememberSurface(record, sample, false);
          moved = progressed = true;
        } else pending = true;
      }
    }
    for (const record of records) {
      const entity = state.dataSource.entities.getById(record.id);
      const anchor = entity?.gevAlprCanvasPosition;
      if (!anchor || !canSample || entity.gevAlprSurfaceCheckedFor === anchor)
        continue;
      if (!still || !surfaceSettled(scene) || samples <= 0) {
        pending = true;
        continue;
      }
      samples -= 1;
      progressed = true;
      const sample = surfaceHeight(record, entity);
      let height = Cesium.Cartographic.fromCartesian(anchor).height;
      const floor = services.groundFloor.cachedGroundFloor(
        record.latitude,
        record.longitude,
      );
      const accepted =
        validAlprGroundHeight(sample) &&
        (!validAlprGroundHeight(floor) ||
          (sample >= floor - SURFACE_BELOW_FLOOR_M &&
            sample <= floor + SURFACE_ABOVE_FLOOR_M));
      if (accepted && Math.abs(sample + MARKER_FLOOR_LIFT_M - height) > 1) {
        height = sample + MARKER_FLOOR_LIFT_M;
        setAnchor(record, entity, height);
        moved = true;
      }
      entity.gevAlprSurfaceCheckedFor = entity.gevAlprCanvasPosition;
      // A surface that did not answer is asked again after a rebuild.
      if (validAlprGroundHeight(sample)) rememberSurface(record, height, true);
      if (entity.id === state.selectedId)
        entity.gevAlprDisplayPosition = entity.gevAlprCanvasPosition;
    }
    if (moved) requestPaint();
    if (!pending || Date.now() >= retryUntil) return;
    // Take the next ration on the next frame; when nothing could be sampled
    // (camera moving, tiles streaming, no floor yet) look again in 250 ms.
    if (progressed) scheduleSampling();
    else if (!retryTimer)
      retryTimer = setTimeout(() => {
        retryTimer = null;
        scheduleSampling();
      }, 250);
  }

  function scheduleSampling() {
    if (sampling || destroyed) return;
    sampling = true;
    requestFrame(sampleAnchors);
  }

  function paint({ ctx, width, height, keyhole, occluder }) {
    hits = [];
    if (!state.enabled || destroyed) return;
    let waiting = false;
    const painted = [];
    const canSample =
      state.viewer.scene.globe?.show ||
      state.viewer.scene.sampleHeightSupported;
    for (const record of records) {
      const entity = state.dataSource.entities.getById(record.id);
      if (!entity) continue;
      const selected = record.id === state.selectedId;
      const image = images[selected ? 1 : 0];
      if (
        !image?.complete ||
        !image.naturalWidth ||
        (selected && !images[2]?.naturalWidth)
      ) {
        nativeVisible(entity, true);
        continue;
      }
      const anchor = anchorFor(record, entity);
      if (!anchor) {
        nativeVisible(entity, true);
        waiting = true;
        continue;
      }
      if (canSample && entity.gevAlprSurfaceCheckedFor !== anchor)
        waiting = true;
      canvasOwned(entity, true);
      if (occluder && !occluder.isPointVisible(anchor)) {
        setShown(entity, false);
        continue;
      }
      const scene = state.viewer.scene;
      const origin = Cesium.SceneTransforms.worldToWindowCoordinates(
        scene,
        anchor,
      );
      if (!origin) {
        setShown(entity, false);
        continue;
      }
      const alpha =
        services.overlays.keyholeAlpha?.(origin.x, origin.y, keyhole) ?? 1;
      if (!(alpha > 0)) {
        setShown(entity, false);
        continue;
      }
      const wedge = entity.gevAlprWedge;
      if (wedge) {
        const left = Cesium.SceneTransforms.worldToWindowCoordinates(
          scene,
          wedge[1],
        );
        const right = Cesium.SceneTransforms.worldToWindowCoordinates(
          scene,
          wedge[2],
        );
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
        setShown(entity, false);
        continue;
      }
      setShown(entity, true);
      painted.push({
        record,
        origin,
        selected,
        image,
        alpha,
        scale: markerScale(
          Cesium.Cartesian3.distance(state.viewer.camera.positionWC, anchor),
        ),
      });
      if (selected) entity.gevAlprDisplayPosition = anchor;
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
    // Anchors still to find or to check are sampled after this paint, a few
    // per frame, never inside it.
    if (waiting && !retryTimer && Date.now() < retryUntil) scheduleSampling();
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
        id: `alpr-${Cesium.createGuid()}`,
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
      for (const record of records)
        nativeVisible(state.dataSource.entities.getById(record.id), true);
      const position = state.viewer.camera.positionWC;
      records = visible
        .filter(
          (record) =>
            Number.isFinite(record.directionDeg) &&
            record.id !== state.selectedId,
        )
        .map((record) => ({
          record,
          distance: position
            ? Cesium.Cartesian3.distanceSquared(
                position,
                Cesium.Cartesian3.fromDegrees(
                  record.longitude,
                  record.latitude,
                ),
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
      for (const record of records)
        nativeVisible(state.dataSource?.entities.getById(record.id), true);
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
