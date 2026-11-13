import { ref } from 'vue';

// How far out Context looks for what is "nearby": one distance for every
// nearby block (flights, vessels, hazards, alerts, other loaded items). The
// control in the Context panel steps through a few distances; the choice is
// kept for the next visit.
const KEY = 'gev.contextRadiusKm';

/** The distances the control steps through, in km. */
export const CONTEXT_RADIUS_STEPS = Object.freeze([25, 50, 100, 250, 500, 1000, 2500]);
export const DEFAULT_CONTEXT_RADIUS_KM = 250;

/** The step closest to a distance; the default for anything unusable. */
export function nearestRadiusStep(km) {
  const value = Number(km);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_CONTEXT_RADIUS_KM;
  return CONTEXT_RADIUS_STEPS.reduce((best, step) =>
    Math.abs(step - value) < Math.abs(best - value) ? step : best,
  );
}

function read() {
  try {
    const saved = globalThis.localStorage?.getItem(KEY);
    return saved === null || saved === undefined
      ? DEFAULT_CONTEXT_RADIUS_KM
      : nearestRadiusStep(saved);
  } catch {
    return DEFAULT_CONTEXT_RADIUS_KM;
  }
}

/** The radius every nearby block uses, in km. */
export const contextRadiusKm = ref(read());

export function setContextRadiusKm(km) {
  contextRadiusKm.value = nearestRadiusStep(km);
  try {
    globalThis.localStorage?.setItem(KEY, String(contextRadiusKm.value));
  } catch {
    // Without storage the choice lasts for this visit.
  }
}
