/**
 * The action runner with every cross-feature workflow wired to fakes that
 * behave like the real services: aircraft records, an annotation board, OSM
 * places, the real Recent Imagery layer over a manual catalog, the outline
 * ladder with Kathmandu and an ambiguous "Punjab", the referent registry and
 * a turn pointer. Shared by the cross-feature voice contract tests.
 */
import { createGevActionRunner } from './gevActions.js';
import { createReferentRegistry } from './referents.js';
import { createRecentImageryLayer } from '../layers/recentImagery/index.js';
import {
  fakeCatalog,
  fakeRenderer,
  fakeThumbnails,
} from '../layers/recentImagery/testDoubles.mjs';

globalThis.window = globalThis.window || {
  clearTimeout,
  setTimeout,
  requestIdleCallback: null,
};

const square = (w, s, e, n) => [
  [w, s],
  [e, s],
  [e, n],
  [w, n],
  [w, s],
];

const punjab = (country, box) => ({
  kind: 'state',
  name: 'Punjab',
  country,
  source: 'natural-earth',
  polygons: [[square(...box)]],
});

/** Bundled units sharing a name, as data/adminBoundaries.js lists them. */
const PUNJABS = [
  punjab('India', [73.9, 29.5, 76.9, 32.5]),
  punjab('Pakistan', [69.3, 27.7, 73.8, 34.0]),
];

/**
 * The annotation outline ladder: Kathmandu comes back from the guarded
 * Nominatim route; any other name anchors with no outline.
 */
async function resolveAnnotationTarget({ target }) {
  if (/kathmandu/i.test(target || ''))
    return {
      lat: 27.7,
      lon: 85.3,
      label: 'Kathmandu',
      ring: null,
      resolveOutline: async () => ({
        ring: square(85.2, 27.6, 85.4, 27.8),
        polygons: [[square(85.2, 27.6, 85.4, 27.8)]],
        synthesized: false,
        outlineSource: 'nominatim',
      }),
    };
  return { lat: 37.795, lon: -122.393, ring: null };
}

const HOSPITALS = [
  { id: 'node/1', lat: 27.7, lon: 85.31, tags: { name: 'Bir Hospital' } },
  { id: 'node/2', lat: 27.71, lon: 85.33, tags: { name: 'Military Hospital' } },
  { id: 'node/3', lat: 27.72, lon: 85.35, tags: {} },
];

/** An annotation board that marks every spec it is given. */
function fakeAnnotations() {
  const marks = [];
  let seq = 0;
  return {
    marks,
    async annotate(specs) {
      const results = specs.map((spec) => {
        const mark = {
          id: `anno-${(seq += 1)}`,
          ring: spec.ring,
          label: spec.label,
          target: spec.target,
          areaId: spec.areaId || null,
          origin: spec.manual ? spec.origin || 'drawn' : 'voice',
          createdAt: seq,
        };
        marks.push(mark);
        return { ok: true, id: mark.id, target: spec.target };
      });
      return { drawn: results.length, failed: 0, results };
    },
    list: () => marks,
    generation: () => 0,
  };
}

function osmPlacesModule() {
  let records = [];
  return {
    setResults(next) {
      records = next.slice();
    },
    getAnalystRecords: (max = 2000) => records.slice(0, max),
    getStats: () => ({ count: records.length, lastUpdate: Date.now() }),
  };
}

function realImageryLayer() {
  const catalog = fakeCatalog();
  const layer = createRecentImageryLayer({
    catalog,
    renderer: fakeRenderer(),
    thumbnails: fakeThumbnails(),
    host: () => ({ collection: {}, kind: 'globe' }),
    now: () => new Date('2026-09-23T12:00:00Z'),
  });
  layer.init({ camera: {} });
  layer.enable();
  return { layer, catalog };
}

/**
 * The runner with every workflow wired: aircraft, annotations, OSM places,
 * imagery, areas, the referent registry and a turn pointer.
 */
export function harness({
  flights = null,
  pointer = null,
  osmHits = HOSPITALS,
  osmSearch = null,
  on = ['flights', 'recent-imagery'],
} = {}) {
  const imagery = realImageryLayer();
  const modules = {
    flights: flights || {
      getStats: () => ({ count: 3, lastUpdate: Date.now() }),
      getAnalystRecords: () => [
        { id: 'UAL1', icao24: 'a1', callsign: 'UAL1', lat: 30, lon: -97 },
        { id: 'DAL2', icao24: 'a2', callsign: 'DAL2', lat: 30.1, lon: -97 },
        { id: 'SWA3', icao24: 'a3', callsign: 'SWA3', lat: 30.2, lon: -97 },
      ],
    },
    'osm-places': osmPlacesModule(),
    'recent-imagery': imagery.layer,
  };
  const enabled = new Set(on);
  const viewer = {
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
    camera: {
      moveEnd: { addEventListener() {} },
      // The view: a box over Kathmandu, in radians.
      computeViewRectangle: () => ({
        west: (85.2 * Math.PI) / 180,
        south: (27.6 * Math.PI) / 180,
        east: (85.4 * Math.PI) / 180,
        north: (27.8 * Math.PI) / 180,
      }),
      positionCartographic: {
        height: 300_000,
        latitude: 0.52,
        longitude: -1.71,
      },
    },
  };
  const referents = createReferentRegistry();
  let snapshot = pointer;
  const osmCalls = [];
  const runner = createGevActionRunner({
    viewer,
    styleManager: {},
    annotations: fakeAnnotations(),
    annotationResolver: {
      resolveRegionRingForQuery: async () => null,
      resolveAnnotationTarget,
    },
    areaOptions: {
      findRegion: async () => null,
      findAdminCandidates: async (q) => (/^punjab$/i.test(q) ? PUNJABS : []),
    },
    osmSearch:
      osmSearch ||
      (async (request) => {
        osmCalls.push(request);
        return { ok: true, features: osmHits, truncated: false };
      }),
    deixis: {
      pointer: { activeSnapshot: () => snapshot },
      referents,
      cameraKey: () => null,
    },
    dataManager: {
      layers: new Map(
        Object.entries(modules).map(([id, module]) => [id, { module }]),
      ),
      isEnabled: (id) => enabled.has(id),
      getAll: () =>
        Object.entries(modules).map(([id, module]) => ({
          id,
          name: id,
          enabled: enabled.has(id),
          stats: module.getStats?.() || {},
        })),
      async setEnabled(id, on) {
        if (on) enabled.add(id);
        else enabled.delete(id);
        return true;
      },
    },
  });
  return {
    runner,
    referents,
    imagery,
    osmCalls,
    setPointer: (next) => (snapshot = next),
  };
}

export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
