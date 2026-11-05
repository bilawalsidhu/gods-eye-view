import * as Cesium from 'cesium';
import { GIZMO_ID_PREFIX } from '../../../data/cctvGizmo.js';

/** Native handle resources and input, owned by exactly one viewer. */
export function createCesiumCctvGizmoRenderer(
  viewer,
  {
    createEventHandler = (canvas) => new Cesium.ScreenSpaceEventHandler(canvas),
  } = {},
) {
  const scene = viewer.scene;
  const handler = createEventHandler(scene.canvas);
  const entities = new Map();
  const removeCancelListeners = [];
  let destroyed = false;
  /** Adds (or re-adds) a gizmo entity, clearing any stale duplicate id. */
  function addEntity(part, options) {
    const id = `${GIZMO_ID_PREFIX}${part}`;
    const stale = viewer.entities.getById(id);
    if (stale && stale !== entities.get(part))
      throw new Error(`CCTV handle ID is already owned: ${id}`);
    if (stale) viewer.entities.remove(stale);
    const entity = viewer.entities.add({ id, show: false, ...options });
    entities.set(part, entity);
    return entity;
  }

  function createLine(part, color, width, arrow = false) {
    color = Cesium.Color.clone(color);
    return addEntity(part, {
      ...(arrow
        ? {
            position: Cesium.Cartesian3.ZERO,
            point: {
              pixelSize: 14,
              color,
              outlineColor: Cesium.Color.BLACK.withAlpha(0.7),
              outlineWidth: 2,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          }
        : {}),
      polyline: {
        positions: [],
        width,
        material: arrow
          ? new Cesium.PolylineArrowMaterialProperty(color)
          : color.withAlpha(0.9),
        // Standard gizmo convention: parts behind geometry stay clearly
        // visible, just dimmed (a street-level mount buries half the heading
        // ring in sloped photogrammetry tiles — smoke-tested 2026-07-05).
        depthFailMaterial: color.withAlpha(0.45),
      },
    });
  }

  function createPoint(part, color, pixelSize) {
    color = Cesium.Color.clone(color);
    return addEntity(part, {
      position: Cesium.Cartesian3.ZERO,
      point: {
        pixelSize,
        color,
        outlineColor: Cesium.Color.BLACK.withAlpha(0.7),
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  /** Extracts a gizmo part name from a pick result, or null. */
  function gizmoPartFrom(picked) {
    const id = picked?.id?.id ?? picked?.id;
    if (typeof id !== 'string' || !id.startsWith(GIZMO_ID_PREFIX)) return null;
    const part = id.slice(GIZMO_ID_PREFIX.length);
    const entity = entities.get(part);
    return entity &&
      viewer.entities.getById(id) === entity &&
      (picked.id === entity || picked.primitive?.id === entity)
      ? part
      : null;
  }

  function pickGizmoPart(windowPosition) {
    // Gizmo primitives render depth-test-free and should be the topmost pick.
    // Take the cheap single-result path first: a full drillPick can stall for
    // tens of seconds under software GL even when its first result is already
    // the gizmo. Retain drillPick for uncommon overlap/fallback cases.
    try {
      const picked = scene.pick(windowPosition, 14, 14);
      const part = gizmoPartFrom(picked);
      if (part && entities.get(part)?.show) return part;
    } catch (err) {
      if (typeof window !== 'undefined' && window.__gevGizmoDebug) {
        console.debug('[CCTV:gizmo] pick threw:', err?.message || err);
      }
    }

    let results = [];
    try {
      results = scene.drillPick(windowPosition, 6, 14, 14) || [];
    } catch (err) {
      if (typeof window !== 'undefined' && window.__gevGizmoDebug) {
        console.debug('[CCTV:gizmo] drillPick threw:', err?.message || err);
      }
      return null;
    }
    if (typeof window !== 'undefined' && window.__gevGizmoDebug) {
      console.debug(
        '[CCTV:gizmo] drillPick @',
        windowPosition?.x,
        windowPosition?.y,
        '→',
        JSON.stringify(
          results.map((r) =>
            String(r?.id?.id ?? r?.id ?? r?.primitive?.constructor?.name),
          ),
        ),
      );
    }
    for (const picked of results) {
      const part = gizmoPartFrom(picked);
      if (part && entities.get(part)?.show) return part;
    }
    return null;
  }

  function pickRay(windowPosition) {
    try {
      return viewer.camera.getPickRay(windowPosition) || null;
    } catch {
      return null;
    }
  }

  function setCursor(value) {
    if (scene.canvas?.style) scene.canvas.style.cursor = value;
  }

  return {
    createLine,
    createPoint,
    pickPart: pickGizmoPart,
    pickRay,
    setCursor,
    on(type, listener) {
      if (type === 'cancel') {
        for (const [target, event] of [
          [scene.canvas, 'pointercancel'],
          [scene.canvas.ownerDocument?.defaultView, 'blur'],
        ]) {
          if (!target?.addEventListener) continue;
          target.addEventListener(event, listener);
          removeCancelListeners.push(() =>
            target.removeEventListener(event, listener),
          );
        }
        return;
      }
      handler.setInputAction(
        listener,
        {
          down: Cesium.ScreenSpaceEventType.LEFT_DOWN,
          move: Cesium.ScreenSpaceEventType.MOUSE_MOVE,
          up: Cesium.ScreenSpaceEventType.LEFT_UP,
        }[type],
      );
    },
    suspendCameraInputs() {
      const controller = scene.screenSpaceCameraController;
      const previous = controller?.enableInputs;
      if (controller) controller.enableInputs = false;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (controller) controller.enableInputs = previous;
      };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      handler.destroy();
      for (const remove of removeCancelListeners) remove();
      removeCancelListeners.length = 0;
      for (const entity of entities.values())
        if (viewer.entities.getById(entity.id) === entity)
          viewer.entities.remove(entity);
      entities.clear();
      setCursor('');
    },
  };
}
