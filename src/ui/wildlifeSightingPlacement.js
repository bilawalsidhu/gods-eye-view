import * as Cesium from 'cesium';
import { WORLD_OVERLAY_OCCLUDER_SELECTORS } from '../overlays/worldOverlayChrome.js';

// DOM cards also avoid the HUD edges and responsive sheet containers.
export const WILDLIFE_CARD_CHROME_SELECTORS = Object.freeze([
  ...WORLD_OVERLAY_OCCLUDER_SELECTORS,
  '.hud-left-edge',
  '.hud-right-edge',
  '#right-panel-stack',
  '.gev-panel-rail',
  '#location-bar',
  '#control-panel',
  '#param-slider-panel',
  '#cockpit-hud .cockpit-topline',
  '[data-mobile-sheet]',
]);
const GAP = 12;
const EDGE = 6;
export const WILDLIFE_SELECTED_CARD_WIDTH = 258;

const overlaps = (a, b) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const contains = (r, p) =>
  p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const rectAt = (left, top, width, height) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
});

/** Read visible chrome rectangles inside the viewer's usable screen area. */
export function readWildlifeCardSafeArea({
  documentRef,
  viewer,
  windowRef = globalThis.window,
}) {
  const canvasRect = viewer?.scene?.canvas?.getBoundingClientRect?.();
  const width =
    windowRef?.innerWidth || documentRef.documentElement.clientWidth;
  const height =
    windowRef?.innerHeight || documentRef.documentElement.clientHeight;
  const left = Math.max(0, canvasRect?.left || 0) + EDGE;
  const top = Math.max(0, canvasRect?.top || 0) + EDGE;
  const right =
    Math.min(width, canvasRect?.width > 0 ? canvasRect.right : width) - EDGE;
  const bottom =
    Math.min(height, canvasRect?.height > 0 ? canvasRect.bottom : height) -
    EDGE;
  const bounds = rectAt(
    left,
    top,
    Math.max(0, right - left),
    Math.max(0, bottom - top),
  );
  const obstacles = [];
  const elements = [
    ...documentRef.querySelectorAll(WILDLIFE_CARD_CHROME_SELECTORS.join(',')),
  ];
  for (const element of elements) {
    let hidden = false;
    for (
      let node = element;
      node && node !== documentRef.body;
      node = node.parentElement
    ) {
      const style = windowRef?.getComputedStyle?.(node);
      if (
        node.hidden ||
        style?.display === 'none' ||
        style?.visibility === 'hidden' ||
        style?.opacity === '0'
      ) {
        hidden = true;
        break;
      }
    }
    if (hidden) continue;
    const rect = element.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0) || !overlaps(rect, bounds))
      continue;
    obstacles.push(
      rectAt(
        rect.left - EDGE,
        rect.top - EDGE,
        rect.width + EDGE * 2,
        rect.height + EDGE * 2,
      ),
    );
  }
  return { bounds, obstacles, elements };
}

function nearestSafeAnchor(point, { bounds, obstacles }) {
  const xs = [clamp(point.x, bounds.left + GAP, bounds.right - GAP)];
  const ys = [clamp(point.y, bounds.top + GAP, bounds.bottom - GAP)];
  for (const rect of obstacles) {
    xs.push(
      clamp(rect.left - GAP, bounds.left + GAP, bounds.right - GAP),
      clamp(rect.right + GAP, bounds.left + GAP, bounds.right - GAP),
    );
    ys.push(
      clamp(rect.top - GAP, bounds.top + GAP, bounds.bottom - GAP),
      clamp(rect.bottom + GAP, bounds.top + GAP, bounds.bottom - GAP),
    );
  }
  return (
    xs
      .flatMap((x) => ys.map((y) => ({ x, y })))
      .filter(
        (p) => contains(bounds, p) && !obstacles.some((r) => contains(r, p)),
      )
      .sort(
        (a, b) =>
          Math.hypot(a.x - point.x, a.y - point.y) -
          Math.hypot(b.x - point.x, b.y - point.y),
      )[0] || null
  );
}

/** Four anchored placements, clamped along their free axis. Chrome is a set of
 * actual DOM rectangles, so corner HUDs do not erase otherwise clear lanes. */
export function placeWildlifeSightingCard(point, size, safeArea) {
  const { bounds, obstacles } = safeArea;
  const anchor =
    contains(bounds, point) && !obstacles.some((r) => contains(r, point))
      ? point
      : nearestSafeAnchor(point, safeArea);
  if (!anchor) return null;
  const width = Math.min(size.width, bounds.width);
  const height = Math.min(size.height, bounds.height);
  const centeredX = clamp(
    anchor.x - width / 2,
    bounds.left,
    bounds.right - width,
  );
  const centeredY = clamp(
    anchor.y - height / 2,
    bounds.top,
    bounds.bottom - height,
  );
  const candidates = [
    {
      placement: 'above',
      ...rectAt(centeredX, anchor.y - GAP - height, width, height),
    },
    { placement: 'below', ...rectAt(centeredX, anchor.y + GAP, width, height) },
    { placement: 'right', ...rectAt(anchor.x + GAP, centeredY, width, height) },
    {
      placement: 'left',
      ...rectAt(anchor.x - GAP - width, centeredY, width, height),
    },
  ];
  const fits = (rect) =>
    rect.left >= bounds.left &&
    rect.right <= bounds.right &&
    rect.top >= bounds.top &&
    rect.bottom <= bounds.bottom &&
    !obstacles.some((r) => overlaps(rect, r));
  let chosen = candidates.find(fits);
  if (!chosen) {
    // Crowded chrome may require sliding a side placement farther from its
    // anchor. Search only obstacle/bounds edges; no pixels or idle frame loop.
    const xs = [bounds.left, bounds.right - width, centeredX];
    const ys = [bounds.top, bounds.bottom - height, centeredY];
    for (const r of obstacles) {
      xs.push(r.left - width, r.right);
      ys.push(r.top - height, r.bottom);
    }
    const alternatives = xs
      .flatMap((x) =>
        ys.map((y) => ({
          placement:
            y + height <= anchor.y
              ? 'above'
              : y >= anchor.y
                ? 'below'
                : x >= anchor.x
                  ? 'right'
                  : 'left',
          ...rectAt(x, y, width, height),
        })),
      )
      .filter((r) => fits(r) && !contains(r, anchor));
    alternatives.sort(
      (a, b) =>
        Math.hypot(
          clamp(anchor.x, a.left, a.right) - anchor.x,
          clamp(anchor.y, a.top, a.bottom) - anchor.y,
        ) -
        Math.hypot(
          clamp(anchor.x, b.left, b.right) - anchor.x,
          clamp(anchor.y, b.top, b.bottom) - anchor.y,
        ),
    );
    chosen = alternatives[0];
  }
  return chosen
    ? {
        ...chosen,
        anchor,
        pan: { x: anchor.x - point.x, y: anchor.y - point.y },
      }
    : null;
}

/** Project a front-side sighting into viewport coordinates. */
export function projectWildlifeSighting(viewer, row, layer) {
  if (
    !viewer?.scene ||
    !Number.isFinite(row?.lat) ||
    !Number.isFinite(row?.lon)
  )
    return null;
  const position =
    layer?.getSightingPosition?.(row.stableId) ||
    Cesium.Cartesian3.fromDegrees(row.lon, row.lat);
  const ellipsoid = viewer.scene.globe?.ellipsoid || Cesium.Ellipsoid.WGS84;
  if (
    viewer.camera?.positionWC &&
    new Cesium.EllipsoidalOccluder(
      ellipsoid,
      viewer.camera.positionWC,
    ).isPointVisible(position) !== true
  )
    return null;
  const point = Cesium.SceneTransforms.worldToWindowCoordinates(
    viewer.scene,
    position,
  );
  if (!point) return null;
  const rect = viewer.scene.canvas?.getBoundingClientRect?.();
  return { x: point.x + (rect?.left || 0), y: point.y + (rect?.top || 0) };
}

/** Translate the camera by the smallest screen correction and preserve its
 * altitude/orientation. A card must never zoom merely to reveal its anchor. */
export function panWildlifeSighting(viewer, from, to, reducedMotion = false) {
  const camera = viewer?.camera;
  if (!camera?.pickEllipsoid || !camera.flyTo) return false;
  const rect = viewer.scene.canvas.getBoundingClientRect();
  const local = (p) => new Cesium.Cartesian2(p.x - rect.left, p.y - rect.top);
  const ellipsoid = viewer.scene.globe?.ellipsoid || Cesium.Ellipsoid.WGS84;
  const start = camera.pickEllipsoid(local(from), ellipsoid);
  const finish = camera.pickEllipsoid(local(to), ellipsoid);
  if (!start || !finish || !camera.positionWC) return false;
  const delta = Cesium.Cartesian3.subtract(
    start,
    finish,
    new Cesium.Cartesian3(),
  );
  const destination = Cesium.Cartesian3.add(
    camera.positionWC,
    delta,
    new Cesium.Cartesian3(),
  );
  const cartographic = ellipsoid.cartesianToCartographic(destination);
  if (!cartographic) return false;
  cartographic.height = camera.positionCartographic.height;
  camera.flyTo({
    destination: ellipsoid.cartographicToCartesian(cartographic),
    orientation: {
      heading: camera.heading,
      pitch: camera.pitch,
      roll: camera.roll,
    },
    duration: reducedMotion ? 0 : 0.22,
    easingFunction: Cesium.EasingFunction.QUADRATIC_OUT,
  });
  return true;
}
