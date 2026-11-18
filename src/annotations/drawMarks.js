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

/** The kind of shape a row action is offered for: `area` or `line`. */
const ACTION_SHAPES = Object.freeze({ area: 'area', route: 'line' });

const lonLat = (point) =>
  Array.isArray(point)
    ? [Number(point[0]), Number(point[1])]
    : [Number(point?.lon), Number(point?.lat)];
const finitePairs = (points) =>
  (Array.isArray(points) ? points : [])
    .map(lonLat)
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
/** A longitude in [-180, 180]; an unwrapped outline can carry ±540. */
const wrapLon = (lon) =>
  lon >= -180 && lon <= 180 ? lon : ((((lon + 180) % 360) + 360) % 360) - 180;
/** Whether consecutive positions step across the antimeridian once wrapped. */
const crossesAntimeridian = (points) =>
  points.some(
    (point, index) =>
      index > 0 && Math.abs(point[0] - points[index - 1][0]) > 180,
  );
/** Positions wrapped into range, or null when the sequence crosses ±180°. */
const inRange = (points) => {
  if (points.some(([, lat]) => Math.abs(lat) > 90)) return null;
  const wrapped = points.map(([lon, lat]) => [wrapLon(lon), lat]);
  return crossesAntimeridian(wrapped) ? null : wrapped;
};
const closed = (ring) => {
  if (ring.length < 3) return ring;
  const [first, last] = [ring[0], ring[ring.length - 1]];
  return first[0] === last[0] && first[1] === last[1] ? ring : [...ring, first];
};

/**
 * A drawn shape's geometry as GeoJSON in `[lon, lat]` degrees, longitudes in
 * [-180, 180]: an area is a closed `Polygon` (a `MultiPolygon` when an area
 * handle has several parts), a line a `LineString`. A pin, a shape too small
 * to be one, or one that crosses the antimeridian has none, so it is offered
 * no action rather than a shape that wraps the wrong way round the world.
 */
export function drawMarkGeometry(mark) {
  if (mark?.type === 'route') {
    const path = inRange(finitePairs(mark.path));
    return path?.length >= 2 ? { type: 'LineString', coordinates: path } : null;
  }
  if (mark?.type !== 'area') return null;
  const ringOf = (points) => {
    const ring = inRange(closed(finitePairs(points)));
    return ring?.length >= 4 ? ring : null;
  };
  if (Array.isArray(mark.polygons) && mark.polygons.length) {
    const polygons = [];
    for (const rings of mark.polygons) {
      const parts = (Array.isArray(rings) ? rings : []).map(ringOf);
      // A part that cannot be given whole is no part: never a hole dropped.
      if (!parts.length || parts.some((ring) => !ring)) return null;
      polygons.push(parts);
    }
    return polygons.length > 1
      ? { type: 'MultiPolygon', coordinates: polygons }
      : { type: 'Polygon', coordinates: polygons[0] };
  }
  const ring = ringOf(mark.ring);
  return ring ? { type: 'Polygon', coordinates: [ring] } : null;
}

/**
 * The actions an application adds to Draw's rows, checked once: each has an
 * `id`, a Material Symbols `icon`, a `label(name)` worded by the application,
 * the `shapes` it is for (`area`, `line`), an optional `accepts(geometry)` and
 * `run({ id, shape, name, title, geometry })` (`name` the person's own, `title`
 * as the row shows it). Malformed or repeated ids are dropped.
 */
export function drawMarkActions(actions = []) {
  const kept = new Map();
  for (const action of Array.isArray(actions) ? actions : []) {
    const wellFormed =
      typeof action?.id === 'string' &&
      /^[a-z][a-z0-9-]{0,39}$/.test(action.id) &&
      typeof action.icon === 'string' &&
      typeof action.label === 'function' &&
      typeof action.run === 'function' &&
      Array.isArray(action.shapes);
    if (!wellFormed || kept.has(action.id)) continue;
    kept.set(
      action.id,
      Object.freeze({
        id: action.id,
        icon: action.icon,
        label: action.label,
        shapes: Object.freeze(
          action.shapes.filter((shape) =>
            Object.values(ACTION_SHAPES).includes(shape),
          ),
        ),
        accepts:
          typeof action.accepts === 'function' ? action.accepts : () => true,
        run: action.run,
      }),
    );
  }
  return Object.freeze([...kept.values()]);
}

/** The actions from `drawMarkActions` that `mark` is offered, with its geometry. */
export function drawMarkActionsFor(mark, actions = []) {
  const shape = ACTION_SHAPES[mark?.type];
  if (!shape || !actions.length) return { shape, geometry: null, actions: [] };
  const geometry = drawMarkGeometry(mark);
  if (!geometry) return { shape, geometry, actions: [] };
  return {
    shape,
    geometry,
    actions: actions.filter((action) => {
      if (!action.shapes.includes(shape)) return false;
      try {
        return action.accepts(geometry, shape) === true;
      } catch {
        return false;
      }
    }),
  };
}

/** An action's words for a row; an application's label that throws shows its id. */
function actionLabel(action, title) {
  try {
    const text = action.label(title);
    return typeof text === 'string' && text.trim() ? text.trim() : action.id;
  } catch {
    return action.id;
  }
}

/**
 * The rows for the hand-drawn marks on the board, in board order. Text is
 * worded here, in the current language; the view only lays it out.
 * @param {object[]} marks The engine's `list()`.
 * @param {ReturnType<typeof drawMarkActions>} [actions] The application's row actions.
 * @param {Map<string, {busy: boolean, text: string}>} [notes] What an action said on a shape.
 */
export function presentDrawMarks(marks = [], actions = [], notes = new Map()) {
  return marks
    .filter((mark) => mark?.manual === true)
    .map((mark) => {
      const fallback = drawMarkFallbackName(mark);
      const title = mark.name || fallback;
      const visible = !mark.hidden;
      const offered = drawMarkActionsFor(mark, actions).actions;
      return {
        id: mark.id,
        name: mark.name || '',
        placeholder: fallback,
        color: DRAW_COLORS.includes(mark.color) ? mark.color : 'primary',
        hidden: !visible,
        busy: notes.get(mark.id)?.busy === true,
        note: offered.length ? notes.get(mark.id)?.text || '' : '',
        actions: offered.map((action) => ({
          id: action.id,
          icon: action.icon,
          label: actionLabel(action, title),
        })),
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
