/**
 * @module uiTextScale
 * @description Browser-free policy for the UI text-size preference. Every DOM
 * font size in the stylesheets is written as `calc(<size> * var(--gev-text-scale))`,
 * so one custom property on the root scales panel and HUD text without
 * changing spacing, panel widths or the 100% appearance.
 */

/** localStorage key for the chosen step. Per viewer; never part of share links. */
export const TEXT_SCALE_STORAGE_KEY = 'gev:text-scale:v1';

/** CSS custom property the stylesheets multiply font sizes by. */
export const TEXT_SCALE_PROPERTY = '--gev-text-scale';

/**
 * Supported steps. The largest step is bounded by the fixed-width panels
 * (272px Display, 312px Cyber rail): beyond 130% their mono labels stop
 * fitting on one line.
 */
export const TEXT_SCALE_OPTIONS = Object.freeze([
  Object.freeze({ id: 'default', scale: 1, label: 'Default' }),
  Object.freeze({ id: 'large', scale: 1.15, label: 'Large' }),
  Object.freeze({ id: 'larger', scale: 1.3, label: 'Larger' }),
]);

export const DEFAULT_TEXT_SCALE_ID = 'default';

const MIN_SCALE = TEXT_SCALE_OPTIONS[0].scale;
const MAX_SCALE = TEXT_SCALE_OPTIONS[TEXT_SCALE_OPTIONS.length - 1].scale;

/**
 * Resolve any stored or requested value to a supported step. Accepts a step id,
 * a scale factor (`1.15`) or a percentage (`'130%'`, `130`). Numbers are
 * clamped to the supported range and snapped to the nearest step; anything
 * unreadable falls back to the default.
 *
 * @param {unknown} value
 * @returns {{ id: string, scale: number, label: string }}
 */
export function normalizeTextScale(value) {
  const fallback = TEXT_SCALE_OPTIONS[0];
  if (value == null) return fallback;
  const text = String(value).trim().toLowerCase();
  const byId = TEXT_SCALE_OPTIONS.find((option) => option.id === text);
  if (byId) return byId;
  const percent = text.endsWith('%');
  let number = Number(percent ? text.slice(0, -1) : text);
  if (!text || !Number.isFinite(number) || number <= 0) return fallback;
  // Values above 4 can only be percentages (100, 130), not factors.
  if (percent || number > 4) number /= 100;
  const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, number));
  let nearest = fallback;
  for (const option of TEXT_SCALE_OPTIONS) {
    if (Math.abs(option.scale - clamped) < Math.abs(nearest.scale - clamped))
      nearest = option;
  }
  return nearest;
}

/**
 * Read the stored step. Storage that is missing, blocked or throwing yields
 * the default rather than an error.
 *
 * @param {Pick<Storage, 'getItem'>|null|undefined} storage
 * @returns {{ id: string, scale: number, label: string }}
 */
export function readStoredTextScale(storage) {
  try {
    return normalizeTextScale(storage?.getItem(TEXT_SCALE_STORAGE_KEY));
  } catch {
    return normalizeTextScale(null);
  }
}

/**
 * Persist a step. Best effort: a full or blocked store reports `false`, and the
 * choice still applies for the current page.
 *
 * @param {Pick<Storage, 'setItem'|'removeItem'>|null|undefined} storage
 * @param {unknown} value
 * @returns {boolean} Whether the value was written.
 */
export function writeStoredTextScale(storage, value) {
  const { id } = normalizeTextScale(value);
  try {
    if (!storage) return false;
    if (id === DEFAULT_TEXT_SCALE_ID)
      storage.removeItem(TEXT_SCALE_STORAGE_KEY);
    else storage.setItem(TEXT_SCALE_STORAGE_KEY, id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply a step to the document root: the custom property drives the CSS, and
 * `data-gev-text-scale` lets styles or QA probes key off the named step.
 *
 * @param {{ style?: { setProperty(name: string, value: string): void }, dataset?: object }|null|undefined} root
 * @param {unknown} value
 * @returns {{ id: string, scale: number, label: string }} The applied step.
 */
export function applyTextScale(root, value) {
  const option = normalizeTextScale(value);
  root?.style?.setProperty(TEXT_SCALE_PROPERTY, String(option.scale));
  if (root?.dataset) root.dataset.gevTextScale = option.id;
  return option;
}

/**
 * Read the scale factor currently applied to a root element, for layout code
 * that reserves room for text it cannot measure yet.
 *
 * @param {{ style?: { getPropertyValue(name: string): string } }|null|undefined} root
 * @returns {number} Applied factor, or 1 when none is set.
 */
export function readAppliedTextScale(root) {
  const raw = root?.style?.getPropertyValue?.(TEXT_SCALE_PROPERTY);
  return raw ? normalizeTextScale(raw).scale : 1;
}

/**
 * Scale a text-derived pixel metric (a fallback header height, a usable
 * panel floor). Invalid factors behave as 1.
 *
 * @param {number} px
 * @param {number} scale
 * @returns {number}
 */
export function scaleTextMetric(px, scale) {
  const factor = Number(scale);
  return (
    (Number(px) || 0) * (Number.isFinite(factor) && factor > 0 ? factor : 1)
  );
}
