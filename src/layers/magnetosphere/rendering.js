/**
 * Draw-port binding for the magnetosphere layer.
 *
 * Two line sets: the field-line filaments, and the magnetopause cage. Depth testing stays on so the globe occludes the far side — that
 * occlusion is most of what makes the structure read as surrounding the
 * planet rather than drawn over it.
 *
 * @module layers/magnetosphere/rendering
 */
import { clipToBoundary, magnetopauseWireframe } from './geometry.js';
import { EARTH_RADIUS_KM } from './trace.js';
import { findDraw, findFrame } from '../../render/rendererOf.js';

const KM_TO_M = 1000;
let renderings = 0;

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
 * `createLines` is injected so a unit test can see the line sets without a
 * renderer; by default they are the draw port's.
 */
export function createMagnetosphereRendering({
  viewer,
  createLines = (id) => findDraw(viewer).lines({ id }),
} = {}) {
  const requestRender = () => findFrame(viewer)?.requestRender('magnetosphere');
  const prefix = `magnetosphere:${(renderings += 1)}`;
  let filaments = null;
  let boundary = null;
  let opacity = 0.75;
  let lastLines = [];
  let lastBoundary = null;

  function ensure() {
    filaments ??= createLines(`${prefix}:filaments`);
    boundary ??= createLines(`${prefix}:boundary`);
  }

  function toPositions(points) {
    const flat = new Float64Array(points.length * 3);
    points.forEach((p, i) => {
      flat[i * 3] = p.x * KM_TO_M;
      flat[i * 3 + 1] = p.y * KM_TO_M;
      flat[i * 3 + 2] = p.z * KM_TO_M;
    });
    return flat;
  }

  // A CSS colour keeps the sRGB bytes exact; the contract reads a tuple as
  // linear.
  const colorOf = ([r, g, b], alpha) => `rgba(${r}, ${g}, ${b}, ${alpha})`;
  const line = (id, points, color, widthPx) => ({
    id,
    positions: toPositions(points),
    widthPx,
    mode: '3d',
    style: { kind: 'solid', color },
    pickable: false,
  });

  return {
    /**
     * Draw traced filaments. Lines are clipped where they leave the boundary:
     * a line that crosses the magnetopause is open, and drawing it closed
     * would contradict the cage drawn in the same frame.
     */
    setFilaments(lines, { parameters = null, sunDirection = null } = {}) {
      ensure();
      lastLines = lines;
      const items = [];
      lines.forEach((traced, index) => {
        const { segments } =
          parameters && sunDirection
            ? clipToBoundary(traced.points, parameters, sunDirection)
            : { segments: [traced.points] };
        const color = colorOf(filamentColorFor(apexRe(traced.points)), opacity);
        segments.forEach((points, part) => {
          if (!points || points.length < 2) return;
          items.push(line(`f${index}:${part}`, points, color, 1.5));
        });
      });
      filaments.set(items);
      requestRender();
    },
    setBoundary(parameters, sunDirection) {
      ensure();
      lastBoundary = { parameters, sunDirection };
      const wireframe =
        parameters && sunDirection
          ? magnetopauseWireframe(parameters, sunDirection)
          : null;
      if (!wireframe) {
        boundary.clear();
        requestRender();
        return;
      }
      const color = (alpha) => colorOf([150, 210, 255], alpha);
      boundary.set([
        ...wireframe.meridians.map((points, i) =>
          line(`m${i}`, points, color(opacity * 0.8), 1.5),
        ),
        ...wireframe.rings.map((points, i) =>
          line(`r${i}`, points, color(opacity * 0.5), 1),
        ),
      ]);
      requestRender();
    },
    setOpacity(next) {
      opacity = next;
      if (lastLines.length) this.setFilaments(lastLines, lastBoundary || {});
      if (lastBoundary)
        this.setBoundary(lastBoundary.parameters, lastBoundary.sunDirection);
    },
    clear() {
      filaments?.clear();
      boundary?.clear();
      lastLines = [];
      lastBoundary = null;
      requestRender();
    },
    destroy() {
      filaments?.dispose();
      boundary?.dispose();
      filaments = null;
      boundary = null;
      lastLines = [];
      lastBoundary = null;
      requestRender();
    },
    getDiagnostics() {
      return {
        filaments: lastLines.length,
        boundary: Boolean(lastBoundary?.parameters),
      };
    },
  };
}
