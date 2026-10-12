import * as Cesium from 'cesium';
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

/** Per-layer presentation on a caller-owned overlay; Cesium remains the fallback. */
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
    state.lastAnchorSampleAt = 0;
    retryUntil = Date.now() + 15000;
    requestPaint();
  }

  function anchorFor(record, entity, budget) {
    if (entity.gevAlprCanvasPosition) return entity.gevAlprCanvasPosition;
    const scene = state.viewer.scene;
    const location = Cesium.Cartographic.fromDegrees(
      record.longitude,
      record.latitude,
    );
    // A floor-placed marker anchors where its native badge sits; only a
    // marker still waiting for its floor samples the rendered surface, and
    // each paint samples a few at most (each sample is a depth render).
    let height;
    const floor = services.groundFloor.cachedGroundFloor(
      record.latitude,
      record.longitude,
    );
    if (validAlprGroundHeight(floor)) height = floor + MARKER_FLOOR_LIFT_M;
    else if (scene.sampleHeightSupported) {
      if (budget.samples <= 0) return null;
      budget.samples -= 1;
      try {
        height = scene.sampleHeight(location, [entity]);
      } catch {
        /* streaming tiles */
      }
    }
    if (!validAlprGroundHeight(height) && scene.globe.show)
      height = scene.globe.getHeight?.(location);
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
   * Replace floor anchors with the rendered surface under each overlay camera.
   * Floors come from ~111 m cells, so on a slope a badge could float or sink
   * by tens of metres. Runs only while the camera is still and tiles have
   * settled, a few depth samples per paint, and each anchor at most once;
   * samples far outside the floor prior (a roof or a streaming tile) are
   * rejected. Returns whether anchors remain to check.
   */
  function refineAnchors(budget) {
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
    if (!scene.sampleHeightSupported) return false;
    let pending = false;
    for (const record of records) {
      const entity = state.dataSource.entities.getById(record.id);
      const anchor = entity?.gevAlprCanvasPosition;
      if (!anchor || entity.gevAlprSurfaceCheckedFor === anchor) continue;
      if (!still || !surfaceSettled(scene) || budget.samples <= 0) {
        pending = true;
        continue;
      }
      budget.samples -= 1;
      let sample;
      try {
        sample = scene.sampleHeight(
          Cesium.Cartographic.fromDegrees(record.longitude, record.latitude),
          [entity],
        );
      } catch {
        /* streaming tiles */
      }
      const current = Cesium.Cartographic.fromCartesian(anchor).height;
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
        setAnchor(record, entity, sample + MARKER_FLOOR_LIFT_M);
      entity.gevAlprSurfaceCheckedFor = entity.gevAlprCanvasPosition;
      if (entity.id === state.selectedId)
        entity.gevAlprDisplayPosition = entity.gevAlprCanvasPosition;
    }
    return pending;
  }

  function paint({ ctx, width, height, keyhole, occluder }) {
    hits = [];
    if (!state.enabled || destroyed) return;
    let unresolved = false;
    const painted = [];
    const budget = { samples: ANCHOR_SAMPLES_PER_PAINT };
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
      const anchor = anchorFor(record, entity, budget);
      if (!anchor) {
        nativeVisible(entity, true);
        unresolved = true;
        continue;
      }
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
