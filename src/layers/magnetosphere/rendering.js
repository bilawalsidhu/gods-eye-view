/**
 * Cesium binding for the magnetosphere layer.
 *
 * Two polyline collections: the field-line filaments, and the magnetopause
 * cage. Depth testing stays on so the globe occludes the far side — that
 * occlusion is most of what makes the structure read as surrounding the
 * planet rather than drawn over it.
 *
 * @module layers/magnetosphere/rendering
 */
import { clipToBoundary, magnetopauseWireframe } from './geometry.js';
import { EARTH_RADIUS_KM } from './trace.js';

const KM_TO_M = 1000;

/** Warm to cold with distance reached, so the eye reads altitude as colour. */
export const FILAMENT_STOPS = Object.freeze([
  { apexRe: 1.5, color: [120, 220, 255] },
  { apexRe: 3, color: [120, 255, 200] },
  { apexRe: 6, color: [220, 255, 140] },
  { apexRe: 10, color: [255, 190, 120] },
  { apexRe: 16, color: [255, 130, 190] },
]);

export function filamentColorFor(apexRe) {
  const stops = FILAMENT_STOPS;
  if (apexRe <= stops[0].apexRe) return stops[0].color;
  for (let i = 1; i < stops.length; i++) {
    if (apexRe > stops[i].apexRe) continue;
    const a = stops[i - 1];
    const b = stops[i];
    const t = (apexRe - a.apexRe) / (b.apexRe - a.apexRe);
    return a.color.map((c, j) => Math.round(c + (b.color[j] - c) * t));
  }
  return stops.at(-1).color;
}

export function apexRe(points) {
  let max = 0;
  for (const p of points) max = Math.max(max, Math.hypot(p.x, p.y, p.z));
  return max / EARTH_RADIUS_KM;
}

/**
 * Build the renderer.
 *
 * `createCollection` is injected for the same reason the aurora layer injects
 * its canvas: the collection wiring is the part a unit test can see, and a
 * headless test has no Cesium.
 */
export function createMagnetosphereRendering({
  viewer,
  cesium,
  createCollection = () => new cesium.PolylineCollection(),
} = {}) {
  const scene = viewer?.scene;
  let filaments = null;
  let boundary = null;
  let opacity = 0.75;
  let lastLines = [];
  let lastBoundary = null;

  function ensure() {
    if (!filaments) {
      filaments = createCollection();
      scene?.primitives?.add?.(filaments);
    }
    if (!boundary) {
      boundary = createCollection();
      scene?.primitives?.add?.(boundary);
    }
  }

  function toPositions(points) {
    const flat = [];
    for (const p of points) {
      flat.push(p.x * KM_TO_M, p.y * KM_TO_M, p.z * KM_TO_M);
    }
    return cesium.Cartesian3.unpackArray(flat);
  }

  function colorOf([r, g, b], alpha) {
    return cesium.Color.fromBytes(r, g, b, Math.round(alpha * 255));
  }

  return {
    /**
     * Draw traced filaments. Lines are clipped where they leave the boundary:
     * a line that crosses the magnetopause is open, and drawing it closed
     * would contradict the cage drawn in the same frame.
     */
    setFilaments(lines, { parameters = null, sunDirection = null } = {}) {
      ensure();
      lastLines = lines;
      filaments.removeAll();
      for (const line of lines) {
        const { points } =
          parameters && sunDirection
            ? clipToBoundary(line.points, parameters, sunDirection)
            : { points: line.points };
        if (!points || points.length < 2) continue;
        filaments.add({
          positions: toPositions(points),
          width: 1.5,
          material: cesium.Material.fromType('Color', {
            color: colorOf(filamentColorFor(apexRe(line.points)), opacity),
          }),
        });
      }
      scene?.requestRender?.();
    },
    setBoundary(parameters, sunDirection) {
      ensure();
      lastBoundary = { parameters, sunDirection };
      boundary.removeAll();
      const wireframe =
        parameters && sunDirection
          ? magnetopauseWireframe(parameters, sunDirection)
          : null;
      if (!wireframe) {
        scene?.requestRender?.();
        return;
      }
      const draw = (line, alpha, width) =>
        boundary.add({
          positions: toPositions(line),
          width,
          material: cesium.Material.fromType('Color', {
            color: colorOf([150, 210, 255], alpha),
          }),
        });
      for (const line of wireframe.meridians) draw(line, opacity * 0.8, 1.5);
      for (const line of wireframe.rings) draw(line, opacity * 0.5, 1);
      scene?.requestRender?.();
    },
    setOpacity(next) {
      opacity = next;
      if (lastLines.length) this.setFilaments(lastLines, lastBoundary || {});
      if (lastBoundary)
        this.setBoundary(lastBoundary.parameters, lastBoundary.sunDirection);
    },
    clear() {
      filaments?.removeAll();
      boundary?.removeAll();
      lastLines = [];
      lastBoundary = null;
      scene?.requestRender?.();
    },
    destroy() {
      for (const collection of [filaments, boundary]) {
        if (!collection) continue;
        // Removing from the collection releases its GPU buffers; Cesium
        // destroys the primitive on remove unless told otherwise.
        scene?.primitives?.remove?.(collection);
      }
      filaments = null;
      boundary = null;
      lastLines = [];
      lastBoundary = null;
      scene?.requestRender?.();
    },
    getDiagnostics() {
      return {
        filaments: lastLines.length,
        boundary: Boolean(lastBoundary?.parameters),
      };
    },
  };
}
