/**
 * The shapes drawn by hand, as UTILITIES ▸ Draw lists them: one row per shape
 * with its colour, its name, and show/hide, fly-to and remove, the way Import
 * lists its files. The board is the annotation engine's; voice marks are not
 * listed, only `manual` ones.
 */
import { msg, t } from '../i18n/index.js';

export const DRAW_COLORS = Object.freeze([
  'primary',
  'amber',
  'cyan',
  'green',
  'red',
]);
/** Each colour as drawn: the preview, the swatches and the drawn shape. */
export const DRAW_COLOR_CSS = Object.freeze({
  primary: '#8be9ff',
  amber: '#ffb547',
  cyan: '#39d0ff',
  green: '#5dff9f',
  red: '#ff6b6b',
});
export const DRAW_COLOR_NAMES = Object.freeze({
  primary: msg('Primary'),
  amber: msg('Amber'),
  cyan: msg('Cyan'),
  green: msg('Green'),
  red: msg('Red'),
});
const SHAPE_NAMES = Object.freeze({
  area: msg('Area'),
  route: msg('Line'),
  pin: msg('Pin'),
});

/** What a row calls a shape that has no name of its own. */
export function drawMarkFallbackName(mark) {
  const shape = t(SHAPE_NAMES[mark?.type] || SHAPE_NAMES.pin);
  // An unnamed line's label is its length; keep it, it is the useful part.
  return mark?.type === 'route' && !mark.name && mark.label
    ? `${shape} · ${mark.label}`
    : shape;
}

/**
 * The rows for the hand-drawn marks on the board, in board order. Text is
 * worded here, in the current language; the view only lays it out.
 * @param {object[]} marks The engine's `list()`.
 */
export function presentDrawMarks(marks = []) {
  return marks
    .filter((mark) => mark?.manual === true)
    .map((mark) => {
      const fallback = drawMarkFallbackName(mark);
      const title = mark.name || fallback;
      const visible = !mark.hidden;
      return {
        id: mark.id,
        name: mark.name || '',
        placeholder: fallback,
        color: DRAW_COLORS.includes(mark.color) ? mark.color : 'primary',
        hidden: !visible,
        labels: {
          name: t('Name of {name}', { name: title }),
          swatch: t('Change the colour of {name}', { name: title }),
          colors: t('Colour of {name}', { name: title }),
          toggle: visible
            ? t('Hide {name}', { name: title })
            : t('Show {name}', { name: title }),
          fly: t('Fly to {name}', { name: title }),
          remove: t('Remove {name}', { name: title }),
        },
      };
    });
}
