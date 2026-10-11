/** Explicit rendering budgets; time-based live motion and data remain independent. */
export const POWER_PROFILES = Object.freeze({
  battery: Object.freeze({ fps: 20, scale: 0.75, msaa: 1, overlayDpr: 1 }),
  balanced: Object.freeze({ fps: 30, scale: 0.9, msaa: 2, overlayDpr: 1.5 }),
  quality: Object.freeze({ fps: 60, scale: 1, msaa: 4, overlayDpr: Infinity }),
});

export function powerBudget(profile) {
  return POWER_PROFILES[profile] || POWER_PROFILES.battery;
}
