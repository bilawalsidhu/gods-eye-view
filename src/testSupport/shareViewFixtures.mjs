/**
 * Shared fixtures for the share-view codec tests: a seeded generator and
 * real long-form links.
 */
import {
  REGISTERED_LAYER_IDS,
  createDefaultLayerState,
  optionSpecs,
} from '../data/layerState.js';

/** A long-form link copied from a real session. */
export const HAL_EXAMPLE_HASH =
  'v=2&lat=30.2672&lon=-97.7431&alt=600&heading=15&pitch=-30&roll=360&style=normal&bloom=0&sharpen=1&bi=0&bv=2&si=49&hud=tactical&hv=1&dm=DENSE&dd=75&da=elastic&kf=7&ko=1&cr=0&sc=1&scf=11&map=photoreal&l=a.f.s&lo=f.e.1_k.o.n&ui=c.c.1_c.p.0_l.c.1_l.p.0_d.c.1_v.c.0_i.c.0_t.c.1_r.c.1_s.c.1_g.c.1_p.c.1_m.c.0';

/** Deterministic generator (mulberry32) for property-style tests. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OPTION_CANDIDATES = [
  true,
  false,
  'light',
  'strong',
  'gfs',
  'ifs',
  'none',
  'speed',
  'temperature',
  'pressure',
  'km/h',
  'm/s',
  'mph',
  'proximity',
  'all',
  'core',
  'dense',
  'off',
  'on',
  'viewshed',
  'tomtom',
  'osm',
  'hybrid',
  'clouds',
  'clouds-regional',
  'pano',
  'flat',
  'filtered',
  'full',
  0,
  1,
  2,
  37,
  50,
  100,
  365,
  -12345678,
  12345678,
  8505110,
  'S30:2026-09-18',
  'L30:2024-02-29',
  'VIIRS:2025-01-02',
  'genre:jazz & blues',
  'news',
  'public-safety',
  0.35,
  0.8,
  'abc-1*def-0',
  'osm-1',
  25544,
  'a1b2c3',
  '~abc123',
];

/** A random layer state using only values each option accepts. */
export function randomLayerState(random) {
  const state = createDefaultLayerState();
  state.enabledLayerIds = REGISTERED_LAYER_IDS.filter(() => random() < 0.3);
  for (const ownerId of Object.keys(state.options)) {
    for (const spec of optionSpecs(ownerId)) {
      if (random() < 0.5) continue;
      const accepted = OPTION_CANDIDATES.filter(
        (value) => spec.normalize(value) !== null,
      );
      if (accepted.length)
        state.options[ownerId][spec.key] =
          accepted[Math.floor(random() * accepted.length)];
    }
  }
  return state;
}

/** One element of `values`, chosen by `random`. */
export function pick(random, values) {
  return values[Math.floor(random() * values.length)];
}
