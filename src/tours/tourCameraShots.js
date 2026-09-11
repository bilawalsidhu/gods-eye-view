/**
 * Cinematic hold-shot palette for guided tours.
 * Playback overlay: shuffle on seek, cycle from the HUD. Not authored JSON modes.
 * @module tours/tourCameraShots
 */

/** Fixed HUD cycle order (not the shuffle deck). */
export const TOUR_SHOT_ORDER = Object.freeze([
  'orbit',
  'truck',
  'crane',
  'pushIn',
  'pullOut',
  'lockOff',
  'birdsEye',
  'lowAngle',
]);

const SHOT_LABELS = Object.freeze({
  orbit: 'Orbit',
  truck: 'Truck',
  crane: 'Crane',
  pushIn: 'Push in',
  pullOut: 'Pull out',
  lockOff: 'Lock-off',
  birdsEye: "Bird's eye",
  lowAngle: 'Low angle',
});

/** Shots that need close mesh; skipped when tiles are missing/sparse. */
const MESH_SENSITIVE = new Set(['lowAngle', 'pushIn']);

/** Preferred draws when mesh is weak. */
const MESH_SAFE = new Set(['birdsEye', 'pullOut', 'lockOff', 'orbit']);

export function shotLabel(shotId) {
  return SHOT_LABELS[shotId] || 'Camera';
}

export function createShotDeck() {
  return {
    deck: [],
    lastId: null,
  };
}

function shuffleInPlace(list) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = list[i];
    list[i] = list[j];
    list[j] = tmp;
  }
  return list;
}

function eligibleIds(meshQuality) {
  const sparse = meshQuality === 'missing' || meshQuality === 'sparse';
  if (!sparse) return [...TOUR_SHOT_ORDER];
  return TOUR_SHOT_ORDER.filter((id) => !MESH_SENSITIVE.has(id));
}

/**
 * Draw the next shot without replacement. Reshuffles when empty.
 * Avoids repeating the same id across a reshuffle boundary.
 */
export function pickShuffledShot(state, { meshQuality = 'ok' } = {}) {
  if (!state) return 'orbit';
  const pool = eligibleIds(meshQuality);
  if (!state.deck.length) {
    state.deck = shuffleInPlace([...pool]);
    if (state.lastId && state.deck.length > 1 && state.deck[0] === state.lastId) {
      const swap = state.deck.findIndex((id) => id !== state.lastId);
      if (swap > 0) {
        const tmp = state.deck[0];
        state.deck[0] = state.deck[swap];
        state.deck[swap] = tmp;
      }
    }
  }
  // Prefer mesh-safe ids when sparse by rotating a safe pick to front if present.
  const sparse = meshQuality === 'missing' || meshQuality === 'sparse';
  if (sparse && state.deck.length > 1) {
    const safeIdx = state.deck.findIndex((id) => MESH_SAFE.has(id));
    if (safeIdx > 0) {
      const [safe] = state.deck.splice(safeIdx, 1);
      state.deck.unshift(safe);
    }
  }
  const next = state.deck.shift() || 'orbit';
  state.lastId = next;
  return next;
}

/** Next id in fixed catalog order (HUD cycle). */
export function nextShotInOrder(currentId) {
  const idx = TOUR_SHOT_ORDER.indexOf(currentId);
  const next = TOUR_SHOT_ORDER[(idx + 1) % TOUR_SHOT_ORDER.length];
  return next || TOUR_SHOT_ORDER[0];
}

/**
 * Resolve framing offsets for a shot on top of authored hold framing.
 * @param {string} shotId
 * @param {{ rangeM: number, heading: number, pitch: number, buildingHeight: number }} base
 */
export function framingForShot(shotId, base) {
  const rangeM = Math.max(120, base.rangeM || 650);
  const heading = Number.isFinite(base.heading) ? base.heading : 0;
  const pitch = Number.isFinite(base.pitch) ? base.pitch : -26;
  const buildingHeight = Number.isFinite(base.buildingHeight) ? base.buildingHeight : 45;

  switch (shotId) {
    case 'truck':
      return {
        rangeM,
        heading: heading + (Math.random() < 0.5 ? -18 : 18),
        pitch,
        buildingHeight,
        motion: { motion: 'pan', direction: Math.random() < 0.5 ? 'left' : 'right', mode: 'continuous', speed: 'slow' },
      };
    case 'crane':
      return {
        rangeM: rangeM * 1.08,
        heading,
        pitch: Math.max(-70, pitch - 8),
        buildingHeight,
        motion: { motion: 'tilt', direction: Math.random() < 0.5 ? 'up' : 'down', mode: 'continuous', speed: 'slow' },
      };
    case 'pushIn':
      return {
        rangeM: Math.max(160, rangeM * 0.62),
        heading,
        pitch: Math.min(-12, pitch + 4),
        buildingHeight,
        motion: null,
        secondaryRange: Math.max(140, rangeM * 0.62),
      };
    case 'pullOut':
      return {
        rangeM: rangeM * 1.55,
        heading,
        pitch: Math.max(-48, pitch - 6),
        buildingHeight,
        motion: null,
      };
    case 'lockOff':
      return {
        rangeM,
        heading,
        pitch,
        buildingHeight,
        motion: null,
      };
    case 'birdsEye':
      return {
        rangeM: rangeM * 1.7,
        heading,
        pitch: -56,
        buildingHeight,
        motion: { motion: 'orbit', direction: 'right', mode: 'continuous', speed: 'slow' },
      };
    case 'lowAngle':
      return {
        rangeM: Math.max(180, rangeM * 0.78),
        heading,
        pitch: -14,
        buildingHeight,
        motion: { motion: 'orbit', direction: Math.random() < 0.5 ? 'left' : 'right', mode: 'continuous', speed: 'slow' },
      };
    case 'orbit':
    default:
      return {
        rangeM,
        heading,
        pitch,
        buildingHeight,
        motion: { motion: 'orbit', direction: 'right', mode: 'continuous', speed: 'slow' },
      };
  }
}
