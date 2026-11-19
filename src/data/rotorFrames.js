/**
 * @module rotorFrames
 * @description Which rotor frame a helicopter icon shows at a time
 * (`aircraftIcon('helicopter', px, frame)`). The frames step at
 * {@link ROTOR_FPS}; each contact starts at its own phase, taken from its
 * id, so helicopters flying together do not change frame in step. The
 * rotor turns as the 3D model's does (`enginesTurn`): airborne, or on the
 * ground moving faster than 1 m/s; otherwise it holds the still frame.
 */

import { ROTOR_FRAMES, ROTOR_STILL_FRAME } from './aircraftIcons.js';
import { enginesTurn } from './modelPartDrivers.js';

export { ROTOR_FRAMES, ROTOR_STILL_FRAME };

/** Rotor frames shown per second. */
export const ROTOR_FPS = 10;

/** Phase by id: hashing each id once, as many as the helicopters seen. */
const phases = new Map();
const PHASES_MAX = 4096;

/**
 * A contact's phase, 0 (inclusive) to 1, the same for the same id every
 * time (FNV-1a over its characters, mixed).
 * @param {string} id
 * @returns {number}
 */
export function rotorPhase(id) {
  const key = String(id ?? '');
  let phase = phases.get(key);
  if (phase !== undefined) return phase;
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Mixed (MurmurHash3's finaliser), so ids differing in their last
  // characters, as ICAO addresses do, spread over the whole range.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  phase = (hash >>> 0) / 0x100000000;
  if (phases.size >= PHASES_MAX) phases.clear();
  phases.set(key, phase);
  return phase;
}

/**
 * Whether a helicopter's rotor turns: airborne, or taxiing (`enginesTurn`).
 * @param {{onGround?: boolean, speedMps?: number|null}} [state]
 * @returns {boolean}
 */
export function rotorTurns({ onGround = false, speedMps = null } = {}) {
  return enginesTurn({ onGround, speedMps });
}

/**
 * The rotor frame a helicopter shows at `nowMs`: the still frame while its
 * rotor does not turn ({@link rotorTurns}), else stepping through the frames
 * at `ROTOR_FPS` from its phase.
 * @param {string} id
 * @param {number} nowMs Epoch ms (any steady clock).
 * @param {{onGround?: boolean, speedMps?: number|null}} [state] Ground speed in m/s.
 * @returns {number} 0 to `ROTOR_FRAMES - 1`.
 */
export function rotorFrame(id, nowMs, state = {}) {
  if (!rotorTurns(state) || !Number.isFinite(nowMs)) return ROTOR_STILL_FRAME;
  const step = Math.floor(
    (nowMs / 1000) * ROTOR_FPS + rotorPhase(id) * ROTOR_FRAMES,
  );
  return ((step % ROTOR_FRAMES) + ROTOR_FRAMES) % ROTOR_FRAMES;
}
