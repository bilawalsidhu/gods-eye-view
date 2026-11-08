import { temeToPseudoFixed } from '../../geo/celestial.js';
import {
  MISSION_ORBIT_PATTERN_GROUPS,
  MISSION_ORBIT_DASHES_PER_GROUP,
} from './policy.js';

/** Pattern cells' width in the mission orbit image, pixels. */
const CELL_PX = 8;
/** The pattern image's height: the line's width, across. */
const PATTERN_HEIGHT_PX = 16;

const smoothstep = (edge0, edge1, x) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/**
 * The selected-orbit tactical pattern, one group of it: a compact round dot
 * followed by one hundred short dashes, in `css` (`#rrggbb`) at `alpha`.
 * Lit as the line drew it: the dot glows brighter than the dashes. Along
 * the image is along the line; across is across its width.
 */
function drawMissionOrbitPattern(canvas, css, alpha) {
  const cells = MISSION_ORBIT_DASHES_PER_GROUP + 1;
  const width = cells * CELL_PX;
  const height = PATTERN_HEIGHT_PX;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext?.('2d');
  // A canvas that cannot draw (no 2D context) stays blank.
  if (typeof context?.createImageData !== 'function') return;
  const image = context.createImageData(width, height);
  const n = Number.parseInt(css.slice(1), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  // Antialiased across a pixel, as the pattern's edges were.
  const edge = 1 / CELL_PX;
  for (let px = 0; px < width; px++) {
    const markPosition = (px + 0.5) / CELL_PX;
    const markIndex = Math.floor(markPosition);
    const local = markPosition - markIndex;
    const isDot = markIndex === 0;
    const centerDistance = Math.abs(local - 0.5);
    const dashAlong =
      1 - smoothstep(0.27 - edge * 1.35, 0.27 + edge * 1.35, centerDistance);
    const dotAlong = (local - 0.5) / 0.32;
    const glow = 1 + (isDot ? 0.65 : 0.07);
    for (let py = 0; py < height; py++) {
      const t = (py + 0.5) / height;
      let visible;
      if (isDot) {
        const across = (t - 0.5) / 0.5;
        visible = 1 - smoothstep(0.78, 1, Math.hypot(dotAlong, across));
      } else {
        const dashAcross = 1 - smoothstep(0.12, 0.24, Math.abs(t - 0.5));
        visible = dashAlong * dashAcross;
      }
      const at = (py * width + px) * 4;
      image.data[at] = Math.min(255, rgb[0] * glow);
      image.data[at + 1] = Math.min(255, rgb[1] * glow);
      image.data[at + 2] = Math.min(255, rgb[2] * glow);
      image.data[at + 3] = Math.round(
        255 * alpha * visible * (isDot ? 1 : 0.58),
      );
    }
  }
  context.putImageData(image, 0, 0);
}

/**
 * The sidereal angle the inertial frame is turned by at `ms`, radians:
 * a point there is drawn at that angle less around the Earth's axis.
 */
function siderealAngle(ms) {
  const frame = temeToPseudoFixed(ms);
  return Math.atan2(-frame.x.y, frame.x.x);
}

/** `p` turned by `angle` about the Earth's axis. */
function turned(p, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: c * p.x - s * p.y, y: s * p.x + c * p.y, z: p.z };
}

export function createOrbitRendering({
  state: layerState,
  services,
  parts,
  source,
}) {
  /** Pattern images by colour. */
  const patterns = new Map();

  /**
   * The mission orbit's line style: the tactical pattern in `css` (at
   * 0.95 alpha), repeated in groups along the whole orbit.
   */
  function missionOrbitPatternStyle(css) {
    let canvas = patterns.get(css);
    if (!canvas) {
      canvas = globalThis.document?.createElement?.('canvas') ?? null;
      if (canvas) drawMissionOrbitPattern(canvas, css, 0.95);
      patterns.set(css, canvas);
    }
    return {
      kind: 'pattern',
      image: { canvas, key: `rocket-mission-orbit:${css}` },
      repeat: MISSION_ORBIT_PATTERN_GROUPS,
    };
  }

  function missionOrbitPrimitiveVisible(launchId) {
    return Boolean(
      layerState._enabled &&
      parts.rendering.missionsShown() &&
      (!layerState._selectedLaunchId ||
        layerState._selectedLaunchId === launchId),
    );
  }

  /** Show each live ring as its mission's selection allows. */
  function syncMissionOrbitPrimitiveVisibility() {
    const set = layerState._missionSets?.orbits;
    if (!set) return;
    const changed = [];
    for (const [launchId, path] of layerState._missionOrbitPrimitives) {
      const show = missionOrbitPrimitiveVisible(launchId);
      if (path.item.show === show) continue;
      path.item = { ...path.item, show };
      changed.push(path.item);
    }
    if (changed.length) set.upsert(changed);
  }

  function removeMissionOrbitPrimitives() {
    layerState._missionSets?.orbits.clear();
    layerState._missionOrbitPrimitives.clear();
  }

  /**
   * Where a point of a live ring, baked in ECEF at the ring's GMST, is
   * drawn at `ms`: the ring turns with the sky as its line does.
   */
  function drawnRingPoint(path, bakePosition, ms) {
    return turned(turned(bakePosition, path.gmstAtBake), -siderealAngle(ms));
  }

  /** Move the live rings' labels with their rings, at `nowMs`. */
  function updateMissionOrbitPrimitiveFrames(nowMs = Date.now()) {
    for (const [launchId, path] of layerState._missionOrbitPrimitives) {
      if (!missionOrbitPrimitiveVisible(launchId)) continue;
      if (path.labelBakePosition)
        path.labelPosition = drawnRingPoint(
          path,
          path.labelBakePosition,
          nowMs,
        );
    }
  }

  /**
   * A live satellite's ring, baked in ECEF at its track's GMST, in the
   * inertial frame, for the caller to write to the `orbits` set. Returns
   * its record, or null when the track has no bake (the ring is then an
   * ordinary mission line).
   */
  function addMissionOrbitPrimitive(launch, orbitPath, satelliteTrack) {
    const set = layerState._missionSets?.orbits;
    if (!set || !satelliteTrack || !Number.isFinite(satelliteTrack.gmstAtBake))
      return null;
    const positions = new Float64Array(orbitPath.length * 3);
    orbitPath.forEach((point, i) => {
      const p = turned(point, satelliteTrack.gmstAtBake);
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
    });
    const item = {
      id: `rocket-orbit:${launch.id}`,
      positions,
      widthPx: 3,
      mode: '3d',
      frame: 'inertial',
      style: missionOrbitPatternStyle('#22e6e6'),
      show: missionOrbitPrimitiveVisible(launch.id),
    };
    const path = { item, gmstAtBake: satelliteTrack.gmstAtBake };
    layerState._missionOrbitPrimitives.set(launch.id, path);
    return path;
  }

  return {
    missionOrbitPatternStyle,
    missionOrbitPrimitiveVisible,
    syncMissionOrbitPrimitiveVisibility,
    removeMissionOrbitPrimitives,
    updateMissionOrbitPrimitiveFrames,
    addMissionOrbitPrimitive,
    drawnRingPoint,
  };
}
