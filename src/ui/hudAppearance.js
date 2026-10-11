/**
 * HUD appearance controls in the Display panel: the selection Target style and
 * the primary and secondary HUD colours.
 *
 * Target sets `data-hud-target` on the root element. `default` keeps each
 * layer's own selection styling; `lock` turns on the shared animated targeting
 * reticle (src/overlays/selectionReticle.js). Target sound
 * (`data-hud-lock-sound`: none, hud-lock by default, or sci-fi-click) is played
 * each time that reticle locks (src/overlays/lockSound.js).
 * Primary writes `--accent` and its derived `--accent-dim` / `--accent-glow`;
 * secondary writes `--secondary-accent`. Both are inline on the root element, so
 * they also win over a HUD theme's palette. Until the operator picks a primary
 * colour, the picker follows whatever `--accent` the active theme supplies.
 */

import { DEFAULT_LOCK_SOUND, LOCK_SOUND_IDS } from '../overlays/lockSound.js';

export const HUD_TARGET_MODES = Object.freeze(['default', 'lock']);
export const DEFAULT_HUD_TARGET = 'default';
export const HUD_TARGET_EVENT = 'gev:hud-target-changed';
export const HUD_LOCK_SOUND_MODES = LOCK_SOUND_IDS;
export const DEFAULT_HUD_LOCK_SOUND = DEFAULT_LOCK_SOUND;

/**
 * Choose the Lock target's acquisition sound
 * (src/overlays/lockSound.js reads `data-hud-lock-sound`).
 * @param {string} mode `none`, `hud-lock` or `sci-fi-click`.
 * @param {object} [options]
 * @param {Document} [options.documentRef]
 * @returns {string} The applied mode.
 */
export function applyHudLockSound(
  mode,
  { documentRef = globalThis.document } = {},
) {
  const applied = HUD_LOCK_SOUND_MODES.includes(mode)
    ? mode
    : DEFAULT_HUD_LOCK_SOUND;
  const root = documentRef?.documentElement;
  if (root) root.dataset.hudLockSound = applied;
  return applied;
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Normalise a CSS hex colour to `#rrggbb`, or return null.
 * @param {string} value
 * @returns {string|null}
 */
export function normalizeHexColor(value) {
  const text = String(value ?? '').trim();
  if (!HEX_COLOR.test(text)) return null;
  if (text.length === 7) return text.toLowerCase();
  const [r, g, b] = text.slice(1);
  return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
}

/**
 * `#rrggbb` → `rgba(r, g, b, alpha)`.
 * @param {string} hex Normalised colour.
 * @param {number} alpha
 * @returns {string}
 */
export function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * Apply the selection target style.
 * @param {string} mode `default` or `lock`.
 * @param {object} [options]
 * @param {Document} [options.documentRef]
 * @returns {string} The applied mode.
 */
export function applyHudTarget(
  mode,
  { documentRef = globalThis.document } = {},
) {
  const applied = HUD_TARGET_MODES.includes(mode) ? mode : DEFAULT_HUD_TARGET;
  const root = documentRef?.documentElement;
  if (root) root.dataset.hudTarget = applied;
  documentRef?.defaultView?.dispatchEvent?.(
    new documentRef.defaultView.CustomEvent(HUD_TARGET_EVENT, {
      detail: { mode: applied },
    }),
  );
  return applied;
}

/**
 * Set the primary HUD colour (`--accent` and its dim/glow companions).
 * @param {string} color Hex colour.
 * @param {object} [options]
 * @param {Document} [options.documentRef]
 * @returns {string|null} The applied colour, or null when invalid.
 */
export function applyHudPrimaryColor(
  color,
  { documentRef = globalThis.document } = {},
) {
  const hex = normalizeHexColor(color);
  const style = documentRef?.documentElement?.style;
  if (!hex || !style) return null;
  style.setProperty('--accent', hex);
  style.setProperty('--accent-dim', hexToRgba(hex, 0.15));
  style.setProperty('--accent-glow', hexToRgba(hex, 0.4));
  return hex;
}

/**
 * Set the secondary HUD colour (`--secondary-accent`).
 * @param {string} color Hex colour.
 * @param {object} [options]
 * @param {Document} [options.documentRef]
 * @returns {string|null} The applied colour, or null when invalid.
 */
export function applyHudSecondaryColor(
  color,
  { documentRef = globalThis.document } = {},
) {
  const hex = normalizeHexColor(color);
  const style = documentRef?.documentElement?.style;
  if (!hex || !style) return null;
  style.setProperty('--secondary-accent', hex);
  return hex;
}

function readRootColor(documentRef, name) {
  const root = documentRef?.documentElement;
  const view = documentRef?.defaultView;
  if (!root || typeof view?.getComputedStyle !== 'function') return null;
  return normalizeHexColor(view.getComputedStyle(root).getPropertyValue(name));
}

/**
 * Bind the HUD section of the Display panel.
 * @param {object} [options]
 * @param {Document} [options.documentRef]
 * @param {() => void} [options.onChange] Called after any applied change.
 * @returns {{ destroy(): void }}
 */
export function bindHudAppearanceControls({
  documentRef = globalThis.document,
  onChange = () => {},
} = {}) {
  const removers = [];
  const targetButtons = [
    ...(documentRef?.querySelectorAll?.('#hud-target-seg [data-hud-target]') ||
      []),
  ];
  const primaryInput = documentRef?.getElementById?.('hud-primary-color');
  const secondaryInput = documentRef?.getElementById?.('hud-secondary-color');
  const soundSelect = documentRef?.getElementById?.('hud-lock-sound-select');
  let primaryOverridden = false;

  const listen = (element, type, handler) => {
    if (!element) return;
    element.addEventListener(type, handler);
    removers.push(() => element.removeEventListener(type, handler));
  };

  const syncTargetButtons = (mode) => {
    for (const button of targetButtons) {
      const active = button.dataset.hudTarget === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', String(active));
    }
  };

  const syncSoundSelect = (mode) => {
    if (soundSelect) soundSelect.value = mode;
  };

  const syncPrimaryFromTheme = () => {
    if (primaryOverridden || !primaryInput) return;
    const accent = readRootColor(documentRef, '--accent');
    if (accent) primaryInput.value = accent;
  };

  const current = documentRef?.documentElement?.dataset?.hudTarget;
  syncTargetButtons(
    applyHudTarget(
      HUD_TARGET_MODES.includes(current) ? current : DEFAULT_HUD_TARGET,
      {
        documentRef,
      },
    ),
  );
  syncPrimaryFromTheme();
  const currentSound = documentRef?.documentElement?.dataset?.hudLockSound;
  syncSoundSelect(applyHudLockSound(currentSound, { documentRef }));
  const secondary = readRootColor(documentRef, '--secondary-accent');
  if (secondaryInput && secondary) secondaryInput.value = secondary;

  for (const button of targetButtons)
    listen(button, 'click', () => {
      syncTargetButtons(
        applyHudTarget(button.dataset.hudTarget, { documentRef }),
      );
      onChange();
    });
  listen(soundSelect, 'change', () => {
    syncSoundSelect(applyHudLockSound(soundSelect.value, { documentRef }));
    onChange();
  });
  listen(primaryInput, 'input', () => {
    if (applyHudPrimaryColor(primaryInput.value, { documentRef })) {
      primaryOverridden = true;
      onChange();
    }
  });
  listen(secondaryInput, 'input', () => {
    if (applyHudSecondaryColor(secondaryInput.value, { documentRef }))
      onChange();
  });

  // A HUD theme (Cyber) brings its own --accent; follow it until overridden.
  const Observer = documentRef?.defaultView?.MutationObserver;
  if (typeof Observer === 'function' && documentRef.documentElement) {
    const observer = new Observer(syncPrimaryFromTheme);
    observer.observe(documentRef.documentElement, {
      attributes: true,
      attributeFilter: ['data-ui-theme'],
    });
    removers.push(() => observer.disconnect());
  }

  return {
    destroy() {
      for (const remove of removers.splice(0)) remove();
    },
  };
}
