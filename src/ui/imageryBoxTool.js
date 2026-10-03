/**
 * Box selection for the Recent Imagery layer: press on the world, drag, and
 * release to hand the layer a degrees box. Follows the draw tool's ownership
 * rules — the pointer is claimed for the session, the viewer's own click
 * actions are borrowed and given back, and `destroy()` returns everything —
 * and freezes the camera only while a drag is in progress.
 */
import * as Cesium from 'cesium';
import { pickWorldFromScreen } from '../annotations/annotationResolver.js';
import {
  claimPointer,
  pointerOwner,
  releasePointer,
} from '../data/inputOwnership.js';
import { validateBox } from '../layers/recentImagery/model.js';

/** The id this tool claims the pointer under. */
export const IMAGERY_BOX_POINTER_OWNER = 'recent-imagery-box';

/**
 * Wire the box tool.
 * @param {{ viewer: object, onBox: (box: object) => void, onCancel?: (reason: string, message?: string, box?: object) => void, onActive?: (active: boolean) => void, onEscape?: () => boolean, cesium?: object, pickWorld?: Function, documentRef?: object }} deps
 *   `onEscape` runs before the tool cancels on Escape; returning `true` claims
 *   the key (it is still consumed) and leaves the tool armed.
 * @returns {{ start: () => boolean, cancel: (reason?: string) => void, isActive: () => boolean, destroy: () => Promise<void> } | null}
 */
export function initImageryBoxTool({
  viewer,
  onBox,
  onCancel,
  onActive,
  onEscape,
  cesium = Cesium,
  pickWorld = pickWorldFromScreen,
  documentRef = globalThis.document,
} = {}) {
  if (!viewer?.scene || typeof onBox !== 'function') return null;

  let active = false;
  let destroyed = false;
  /** Drag corners in degrees; `anchor` is null while no drag is live. */
  let anchor = null;
  let corner = null;
  let handler = null;
  let lease = null;
  let savedSingleClick = null;
  let savedDoubleClick = null;
  let savedCameraInputs = null;

  const dragBox = () =>
    anchor && {
      west: Math.min(anchor.lon, corner.lon),
      south: Math.min(anchor.lat, corner.lat),
      east: Math.max(anchor.lon, corner.lon),
      north: Math.max(anchor.lat, corner.lat),
    };

  const dataSource = new cesium.CustomDataSource(
    'gev-recent-imagery-box-preview',
  );
  let attaching = Promise.resolve(viewer.dataSources.add(dataSource)).catch(
    () => null,
  );
  const stroke = cesium.Color.fromCssColorString('#8be9ff');
  const previewRectangle = () => {
    const box = dragBox();
    return box
      ? cesium.Rectangle.fromDegrees(box.west, box.south, box.east, box.north)
      : undefined;
  };
  const previewOutline = () => {
    const box = dragBox();
    if (!box) return [];
    return cesium.Cartesian3.fromDegreesArray([
      box.west,
      box.south,
      box.east,
      box.south,
      box.east,
      box.north,
      box.west,
      box.north,
      box.west,
      box.south,
    ]);
  };
  const fill = dataSource.entities.add({
    show: false,
    rectangle: {
      coordinates: new cesium.CallbackProperty(previewRectangle, false),
      material: stroke.withAlpha(0.12),
      classificationType: cesium.ClassificationType.BOTH,
    },
  });
  // A rectangle graphic cannot draw a dashed edge on the ground, so the
  // outline is its own draped polyline traced round the same corners.
  const outline = dataSource.entities.add({
    show: false,
    polyline: {
      positions: new cesium.CallbackProperty(previewOutline, false),
      width: 2,
      clampToGround: true,
      classificationType: cesium.ClassificationType.BOTH,
      material: new cesium.PolylineDashMaterialProperty({
        color: stroke.withAlpha(0.95),
        dashLength: 12,
      }),
    },
  });

  const requestRender = () => viewer.scene.requestRender?.();
  const setPreview = (visible) => {
    fill.show = visible;
    outline.show = visible;
    requestRender();
  };
  const worldAt = (position) => {
    if (!position) return null;
    const canvas = viewer.scene.canvas;
    const w = canvas?.clientWidth || canvas?.width || 1;
    const h = canvas?.clientHeight || canvas?.height || 1;
    const point = pickWorld(viewer, position.x / w, position.y / h);
    const lon = Number(point?.lon);
    const lat = Number(point?.lat);
    return Number.isFinite(lon) && Number.isFinite(lat) ? { lon, lat } : null;
  };
  const cameraController = () => viewer.scene.screenSpaceCameraController;

  function freezeCamera() {
    const controller = cameraController();
    if (!controller || savedCameraInputs !== null) return;
    savedCameraInputs = controller.enableInputs;
    controller.enableInputs = false;
  }
  function thawCamera() {
    const controller = cameraController();
    if (controller && savedCameraInputs !== null)
      controller.enableInputs = savedCameraInputs;
    savedCameraInputs = null;
  }

  function endDrag() {
    anchor = null;
    corner = null;
    thawCamera();
    setPreview(false);
  }

  const onDown = (event) => {
    if (!active || destroyed || anchor) return;
    const point = worldAt(event.position);
    if (!point) {
      onCancel?.('sky', 'Press on the ground, not the sky');
      return;
    }
    anchor = point;
    corner = point;
    freezeCamera();
    setPreview(true);
  };
  const onMove = (event) => {
    const point = anchor && !destroyed && worldAt(event.endPosition);
    if (!point) return;
    corner = point;
    requestRender();
  };
  const onUp = (event) => {
    if (!anchor || destroyed) return;
    corner = worldAt(event.position) || corner;
    const box = dragBox();
    const result = validateBox(box);
    if (result.reason === 'degenerate') result.message = 'Drag to size the box';
    endDrag();
    setActive(false);
    if (result.ok) onBox(result.box);
    else onCancel?.(result.reason, result.message, box);
  };
  // Escape is taken from a document capture listener, ahead of every other
  // handler, so the interceptor runs first: when it claims the key (the
  // panel exits a live comparison), the tool stays armed and the key still
  // goes no further; otherwise Escape cancels the session.
  const onKey = (event) => {
    if (!active || destroyed || event.key !== 'Escape') return;
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
    if (onEscape?.() === true) return;
    cancel('escape');
  };

  function bindScene() {
    if (handler) return;
    handler = new cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction(onDown, cesium.ScreenSpaceEventType.LEFT_DOWN);
    handler.setInputAction(onMove, cesium.ScreenSpaceEventType.MOUSE_MOVE);
    handler.setInputAction(onUp, cesium.ScreenSpaceEventType.LEFT_UP);
    const stock = viewer.screenSpaceEventHandler;
    if (stock) {
      savedSingleClick =
        stock.getInputAction(cesium.ScreenSpaceEventType.LEFT_CLICK) || null;
      savedDoubleClick =
        stock.getInputAction(cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK) ||
        null;
      stock.removeInputAction(cesium.ScreenSpaceEventType.LEFT_CLICK);
      stock.removeInputAction(cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    }
    documentRef?.addEventListener?.('keydown', onKey, true);
    documentRef?.body?.classList?.add?.('gev-imagery-box');
  }

  function releaseScene() {
    if (handler) {
      handler.destroy();
      handler = null;
    }
    const stock = viewer.screenSpaceEventHandler;
    if (stock && savedSingleClick) {
      stock.setInputAction(
        savedSingleClick,
        cesium.ScreenSpaceEventType.LEFT_CLICK,
      );
    }
    if (stock && savedDoubleClick) {
      stock.setInputAction(
        savedDoubleClick,
        cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
      );
    }
    savedSingleClick = null;
    savedDoubleClick = null;
    documentRef?.removeEventListener?.('keydown', onKey, true);
    documentRef?.body?.classList?.remove?.('gev-imagery-box');
  }

  function setActive(next) {
    if (next === active) return active;
    if (next) {
      lease = claimPointer(IMAGERY_BOX_POINTER_OWNER);
      if (!lease) {
        onCancel?.(
          'pointer-busy',
          `${pointerOwner()} is using the pointer — close it first`,
        );
        return active;
      }
      active = true;
      bindScene();
    } else {
      if (anchor) endDrag();
      releaseScene();
      releasePointer(lease);
      lease = null;
      active = false;
    }
    onActive?.(active);
    return active;
  }

  function cancel(reason = 'cancel') {
    if (!active || destroyed) return;
    setActive(false);
    onCancel?.(reason);
  }

  return {
    /** Begin a box session. False when the pointer is held elsewhere. */
    start() {
      return !destroyed && setActive(true);
    },
    cancel,
    isActive() {
      return active;
    },
    /** Returns everything; resolves once the preview is detached. */
    destroy() {
      if (destroyed) return attaching;
      if (active) setActive(false);
      destroyed = true;
      releaseScene();
      releasePointer(lease);
      lease = null;
      thawCamera();
      dataSource.entities.removeAll();
      attaching = attaching.then(() => {
        try {
          viewer.dataSources.remove(dataSource, true);
        } catch {
          /* viewer already disposed */
        }
      });
      return attaching;
    },
  };
}
