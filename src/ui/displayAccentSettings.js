import { msg } from '../i18n/index.js';

/** Accent presets available to every HUD template in Display. */
export const DISPLAY_ACCENTS = Object.freeze(
  [
    { id: 'purple', color: '#7d4fae', label: msg('Purple') },
    { id: 'red', color: '#c45454', label: msg('Red') },
    { id: 'cyan', color: '#69cbd1', label: msg('Cyan') },
    { id: 'amber', color: '#e89d4e', label: msg('Amber') },
    { id: 'green', color: '#4ec98a', label: msg('Green') },
  ].map((accent) => Object.freeze(accent)),
);

export const DEFAULT_DISPLAY_ACCENT = Object.freeze({
  id: 'purple',
  color: '#7d4fae',
  customColor: '#7d4fae',
});

const DISPLAY_ACCENT_BY_ID = new Map(
  DISPLAY_ACCENTS.map((accent) => [accent.id, accent]),
);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** @param {unknown} value */
function normalizeHexColor(value) {
  const text = String(value ?? '').trim();
  return HEX_COLOR.test(text) ? text.toLowerCase() : null;
}

/**
 * Accept either a preset id or `{ id, customColor }`, retaining the last custom
 * color so the picker remains useful after a preset is selected.
 * Invalid input uses the template default: automatic colors or Cyber purple.
 * @param {unknown} value
 * @param {'tactical'|'minimal'|'cyber'} [layout]
 */
export function normalizeDisplayAccent(value, layout = 'cyber') {
  const rawId = String(value?.id ?? value ?? '')
    .trim()
    .toLowerCase();
  const preset = DISPLAY_ACCENT_BY_ID.get(rawId);
  const customColor =
    normalizeHexColor(value?.customColor) ?? DEFAULT_DISPLAY_ACCENT.customColor;
  if (preset)
    return Object.freeze({ id: preset.id, color: preset.color, customColor });
  if (rawId !== 'custom') {
    return layout === 'cyber'
      ? DEFAULT_DISPLAY_ACCENT
      : Object.freeze({ id: 'auto', color: null, customColor });
  }
  const custom = normalizeHexColor(value?.color) ?? customColor;
  return Object.freeze({ id: 'custom', color: custom, customColor: custom });
}

/** Read per-template preferences, migrating the former Cyber-only setting. */
export function readDisplayAccentPreferences(raw, legacyCyberRaw = null) {
  let stored = null;
  try {
    stored = JSON.parse(raw || 'null');
  } catch {
    /* invalid storage uses the template defaults */
  }
  let legacy = null;
  if (!raw) {
    try {
      legacy = JSON.parse(legacyCyberRaw || 'null');
    } catch {
      /* invalid legacy storage uses Cyber's default */
    }
  }
  return Object.fromEntries(
    ['tactical', 'minimal', 'cyber'].map((layout) => [
      layout,
      normalizeDisplayAccent(
        stored?.[layout] ?? (layout === 'cyber' ? legacy : null),
        layout,
      ),
    ]),
  );
}

function hexToRgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgbToHsl([r, g, b]) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const delta = max - min;
  const saturation =
    lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue;
  if (max === red) hue = ((green - blue) / delta + (green < blue ? 6 : 0)) / 6;
  else if (max === green) hue = ((blue - red) / delta + 2) / 6;
  else hue = ((red - green) / delta + 4) / 6;
  return [hue, saturation, lightness];
}

function hslToRgb([hue, saturation, lightness]) {
  if (saturation === 0) {
    const gray = Math.round(lightness * 255);
    return [gray, gray, gray];
  }
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = hue * 6;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));
  const base = lightness - chroma / 2;
  const rgb =
    sector < 1
      ? [chroma, second, 0]
      : sector < 2
        ? [second, chroma, 0]
        : sector < 3
          ? [0, chroma, second]
          : sector < 4
            ? [0, second, chroma]
            : sector < 5
              ? [second, 0, chroma]
              : [chroma, 0, second];
  return rgb.map((channel) => Math.round((channel + base) * 255));
}

function rgbToHex([r, g, b]) {
  return `#${[r, g, b]
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`;
}

/** A brighter companion for titles, focus rings and active borders. */
export function brightDisplayAccent(hex) {
  const [, saturation, lightness] = rgbToHsl(hexToRgb(hex));
  const nextSaturation =
    saturation < 0.05 ? saturation : Math.min(0.84, saturation + 0.17);
  const nextLightness = Math.min(0.78, lightness + 0.18);
  const [hue] = rgbToHsl(hexToRgb(hex));
  return rgbToHex(hslToRgb([hue, nextSaturation, nextLightness]));
}

/** A dark tint for active controls, derived from the same hue as the accent. */
export function displayAccentSurface(hex) {
  const [hue, saturation] = rgbToHsl(hexToRgb(hex));
  const nextSaturation =
    saturation < 0.05 ? saturation : Math.min(0.6, saturation);
  return rgbToHex(hslToRgb([hue, nextSaturation, 0.18]));
}

/**
 * Publish the current template's accent. Automatic Tactical/Minimal colors
 * release the override so IntelHUD's existing style-aware colors take over.
 * @param {{style?: {setProperty(name: string, value: string): void}}|null|undefined} root
 * @param {unknown} accent
 */
export function applyDisplayAccentTheme(root, accent) {
  const setting = normalizeDisplayAccent(
    accent,
    accent?.id === 'auto' ? 'tactical' : 'cyber',
  );
  const style = root?.style;
  if (!style?.setProperty) return setting;
  if (!setting.color) {
    if (root.dataset) delete root.dataset.displayAccent;
    for (const prefix of ['display', 'cyber']) {
      for (const suffix of [
        '',
        '-bright',
        '-rgb',
        '-bright-rgb',
        '-surface-rgb',
      ]) {
        style.removeProperty?.(`--${prefix}-accent${suffix}`);
      }
    }
    return setting;
  }
  if (root.dataset) root.dataset.displayAccent = setting.id;
  const rgb = hexToRgb(setting.color);
  const bright = brightDisplayAccent(setting.color);
  const brightRgb = hexToRgb(bright);
  for (const prefix of ['display', 'cyber']) {
    style.setProperty(`--${prefix}-accent`, setting.color);
    style.setProperty(`--${prefix}-accent-bright`, bright);
    style.setProperty(`--${prefix}-accent-rgb`, rgb.join(', '));
    style.setProperty(`--${prefix}-accent-bright-rgb`, brightRgb.join(', '));
    style.setProperty(
      `--${prefix}-accent-surface-rgb`,
      hexToRgb(displayAccentSurface(setting.color)).join(', '),
    );
  }
  return setting;
}
