/**
 * @module ui/cardMapStyle
 * @description Styles close-up and pinned maps drawn from OpenFreeMap's
 * OpenMapTiles vector tiles. The dark palette uses near-black land, dark
 * water, bright roads and muted parks and buildings. Major roads are
 * thicker and lighter. After the tiles are painted, cardMapLabels.js
 * places names across the map according to {@link CARD_MAP_LABELS}.
 */

/** The deepest zoom OpenFreeMap's tiles are cut at; deeper is over-zoomed. */
export const CARD_MAP_SOURCE_MAXZOOM = 14;

/** Road classes from the thinnest up; each is a layer, the major on top. */
const ROADS = Object.freeze([
  ['path', ['path', 'track']],
  ['service', ['service']],
  ['minor', ['minor']],
  ['tertiary', ['tertiary']],
  ['secondary', ['secondary']],
  ['primary', ['primary', 'trunk']],
  ['motorway', ['motorway']],
]);

/** A road's width in CSS pixels at card zooms 11, 14 and 16. */
const ROAD_WIDTHS = Object.freeze({
  path: [0, 0.3, 0.9],
  service: [0, 0.5, 1.6],
  minor: [0.3, 1, 3],
  tertiary: [0.6, 1.8, 4],
  secondary: [0.8, 2.4, 5],
  primary: [1.2, 3.2, 6.5],
  motorway: [1.6, 4, 8],
});

/** Roads that carry a soft halo. */
const GLOWING = new Set(['secondary', 'primary', 'motorway']);

/** The card map's dark palette and the halo under major roads. */
export const CARD_MAP_COLOURS = Object.freeze({
  land: '#06080b',
  water: '#0b1a2a',
  green: '#0d1711',
  building: '#141a20',
  buildingEdge: '#1c232b',
  runway: '#232a32',
  rail: '#2e353d',
  glow: 'rgba(255, 255, 255, 0.07)',
  names: '#e4ebf0',
  nameHalo: 'rgba(6, 8, 11, 0.92)',
  waterNames: '#6f8fae',
  roads: Object.freeze({
    path: '#262d34',
    service: '#38414a',
    minor: '#5c6670',
    tertiary: '#97a1aa',
    secondary: '#c2cad1',
    primary: '#e9edf0',
    motorway: '#fff4dc',
  }),
});

/** The light toner palette for the alternative card map theme. */
const TONER_COLOURS = Object.freeze({
  land: '#ffffff',
  water: '#141414',
  green: '#e6e6e6',
  building: '#d2d2d2',
  buildingEdge: '#bdbdbd',
  runway: '#9a9a9a',
  rail: '#7a7a7a',
  glow: null,
  names: '#000000',
  nameHalo: 'rgba(255, 255, 255, 0.95)',
  waterNames: '#5a5a5a',
  roads: Object.freeze({
    path: '#8c8c8c',
    service: '#5a5a5a',
    minor: '#2a2a2a',
    tertiary: '#111111',
    secondary: '#000000',
    primary: '#000000',
    motorway: '#000000',
  }),
});

export function cardMapColours(theme) {
  return theme === 'toner' ? TONER_COLOURS : CARD_MAP_COLOURS;
}

/** Exponential width stops at card zooms 11, 14 and 16, in device pixels. */
function roadWidth(stops, zoom, scale) {
  if (zoom <= 11) return stops[0] * scale;
  if (zoom >= 16) return stops[2] * scale;
  const i = zoom < 14 ? 0 : 1;
  const start = i === 0 ? 11 : 14;
  const span = i === 0 ? 3 : 2;
  const fraction = (1.5 ** (zoom - start) - 1) / (1.5 ** span - 1);
  return (stops[i] + (stops[i + 1] - stops[i]) * fraction) * scale;
}

/** Ground layers in drawing order for the card's own bounded tile projection. */
export function cardMapStyle({ theme = 'dark', scale = 1, zoom = 14 } = {}) {
  const c = cardMapColours(theme);
  const fill = (id, source, color, classes, outline) => ({
    id,
    source,
    color,
    classes,
    outline,
    type: 3,
  });
  const line = (id, source, color, classes, stops, extra) => ({
    id,
    source,
    color,
    classes,
    type: 2,
    width: roadWidth(stops, zoom, scale),
    ...extra,
  });
  const layers = [
    fill('green', 'landcover', c.green, ['wood', 'grass', 'wetland']),
    fill('parks-landuse', 'landuse', c.green, [
      'park',
      'cemetery',
      'pitch',
      'stadium',
      'playground',
    ]),
    fill('parks', 'park', c.green),
    fill('water', 'water', c.water),
    line(
      'waterway',
      'waterway',
      c.water,
      ['river', 'canal', 'stream'],
      [0.6, 1.6, 4],
      { round: true },
    ),
    line('runway', 'aeroway', c.runway, ['runway', 'taxiway'], [1, 4, 12]),
    fill('buildings', 'building', c.building, undefined, c.buildingEdge),
    line(
      'rail',
      'transportation',
      c.rail,
      ['rail', 'transit'],
      [0.4, 0.8, 1.4],
      { dashed: true },
    ),
  ];
  for (const [name, classes] of ROADS) {
    const road = (id, color, stops) =>
      line(id, 'transportation', color, classes, stops, {
        round: true,
        fadeTunnel: true,
      });
    const stops = ROAD_WIDTHS[name];
    if (c.glow && GLOWING.has(name))
      layers.push(
        road(
          `road-${name}-glow`,
          c.glow,
          stops.map((w) => w * 3),
        ),
      );
    layers.push(road(`road-${name}`, c.roads[name], stops));
  }
  return { land: c.land, layers };
}

/**
 * How the card map's names are set, in CSS pixels: place names by rank
 * (the lower `priority`, the sooner placed), names along major roads, and
 * names of open water. Fonts are the system's, a stack that covers Latin,
 * Cyrillic, Greek, CJK, Arabic, Hebrew, Devanagari and Thai; no font is
 * loaded from the network.
 */
export const CARD_MAP_LABELS = Object.freeze({
  font: [
    'system-ui',
    '-apple-system',
    '"Segoe UI"',
    '"Noto Sans"',
    '"Hiragino Sans"',
    '"PingFang SC"',
    '"Microsoft YaHei"',
    '"Noto Sans CJK JP"',
    '"Noto Sans Arabic"',
    '"Noto Sans Hebrew"',
    '"Noto Sans Devanagari"',
    '"Noto Sans Thai"',
    'Tahoma',
    'sans-serif',
  ].join(', '),
  places: Object.freeze({
    city: Object.freeze({ priority: 0, size: 15, weight: 700 }),
    town: Object.freeze({ priority: 1, size: 13, weight: 700 }),
    village: Object.freeze({ priority: 2, size: 12, weight: 600 }),
    suburb: Object.freeze({ priority: 3, size: 11, weight: 600 }),
    quarter: Object.freeze({ priority: 4, size: 10, weight: 600 }),
    neighbourhood: Object.freeze({ priority: 4, size: 10, weight: 600 }),
  }),
  roads: Object.freeze({
    classes: Object.freeze(['motorway', 'trunk', 'primary', 'secondary']),
    priority: 5,
    size: 10,
    weight: 500,
    /** Names along roads on one map, at most. */
    most: 6,
  }),
  water: Object.freeze({
    classes: Object.freeze(['ocean', 'sea', 'bay', 'lake', 'river']),
    priority: 6,
    size: 10,
    weight: 400,
  }),
  /** The halo round each name. */
  halo: 3,
  /** Room kept clear round a name, and round the item's marker. */
  gap: 4,
  marker: 30,
});
