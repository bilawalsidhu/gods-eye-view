import { HUD_LAYOUTS, LEGACY_SONAR_HUD_LAYOUTS } from './hudLayoutPolicy.js';
export { HUD_LAYOUTS, LEGACY_SONAR_HUD_LAYOUTS } from './hudLayoutPolicy.js';

/** Canonical HUD layouts shared by the UI, voice schema and HUD renderer. */

export const DEFAULT_HUD_LAYOUT = 'tactical';

const HUD_LAYOUT_SET = new Set(HUD_LAYOUTS);

/** @param {unknown} value */
export function isHudLayout(value) {
  return HUD_LAYOUT_SET.has(String(value ?? '').toLowerCase());
}

/** @param {unknown} value */
export function normalizeHudLayout(value) {
  const normalized = String(value ?? '').toLowerCase();
  return isHudLayout(normalized) ? normalized : DEFAULT_HUD_LAYOUT;
}

/**
 * Whether a layout name is a removed layout that now means "Sonar on".
 * @param {unknown} value
 */
export function isLegacySonarHudLayout(value) {
  return LEGACY_SONAR_HUD_LAYOUTS.includes(String(value ?? '').toLowerCase());
}
