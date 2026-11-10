import { createQaProbe, createSettledState } from '../../src/app/qaProbe.js';
import { compareLedgers, drawLedger } from './ledger.mjs';

// Each group needs four page starts and two picker switches within 300 seconds.
export const COLD_START_GROUPS = {
  aircraft: {
    layers: ['flights', 'military'],
    view: [40.2539, -125.5779, 21130],
  },
  local: {
    layers: ['local-adsb', 'local-dams', 'local-datacenters'],
    view: [41.534, -90.507, 20000],
  },
  ground: {
    layers: [
      'ais-live-vessels',
      'air-quality',
      'gnss-integrity',
      'fire-perimeters',
    ],
    view: [43.65, -79.38, 46000],
  },
  contacts: {
    layers: ['military-awareness', 'military-installations'],
    view: [43.65, -79.38, 46000],
  },
  open: {
    layers: ['drone-airspace', 'osm-places', 'sea-marks', 'ski-pistes'],
    view: [38.9, -77.03, 30000],
  },
  weather: {
    layers: [
      'weather-radar',
      'weather-satellite',
      'weather-lightning',
      'weather-cyclones',
    ],
    view: [43.65, -79.38, 46000],
  },
  wind: { layers: ['wind'], view: [43.65, -79.38, 2000000] },
  ghostmaps: { layers: ['s2-ghostmaps'], view: [43.65, -79.38, 46000] },
  wildlife: { layers: ['wildlife-sightings'], view: [48.4, -123.1, 200000] },
  urban: {
    layers: ['bikeshare', 'transit', 'earthquakes'],
    view: [42.3554, -71.0605, 6000],
  },
  cameras: { layers: ['cctv', 'alpr-cameras'], view: [30.262, -97.7431, 5500] },
  radio: { layers: ['radio'], view: [30.27, -97.74, 12000] },
  space: { layers: ['satellites', 'rocket-launches'], view: [5, 5, 18000000] },
  traffic: { layers: ['traffic'], view: [30.267, -97.744, 1800] },
  street: { layers: ['street-level'], view: [38.5831, -121.504, 850] },
  imagery: { layers: ['recent-imagery'], view: [30.27, -97.74, 12000] },
  nepal: {
    layers: ['bhote-koshi-locator', 'bhote-koshi-2026'],
    view: [28.3326, 85.4848, 18000],
  },
  cables: {
    layers: ['telegeography-submarine-cables', 'directions'],
    view: [55.3241, 10.7995, 25000],
  },
  fires: { layers: ['local-firms'], view: [37.77, -122.42, 100000] },
};

/** Change only the engine query of the address written by the application. */
export function coldStartUrl(href, engine) {
  const url = new URL(href);
  url.searchParams.set('engine', engine);
  return url.href;
}

/** Feed completion alone does not mean its deferred display has been drawn. */
export function coldStartReady(layers, cold = false) {
  const { dataManager, engine } = window.__godsEyeView;
  engine.render.request('qa-cold-start-readiness');
  const movers = engine.movers.list();
  return layers.every((id) => {
    const entry = dataManager.layers.get(id),
      module = entry?.module;
    if (!entry) return false;
    if (cold && module.sessionState?.includes('enabled')) return !entry.enabled;
    if (
      !entry.enabled ||
      !entry.initialized ||
      entry.sceneDetached ||
      entry.refreshing
    )
      return false;
    const stats = module.getStats?.() ?? {};
    if (stats.loading || stats.refreshing) return false;
    if (id === 'local-dams' || id === 'local-datacenters')
      return (
        module.getLodDiagnostics().computed && engine.surface.tilesLoaded()
      );
    if (id === 'wildlife-sightings')
      return (
        movers.some((row) => row.id === id && row.count === 4) &&
        movers.some((row) => row.id === `${id}-density` && row.count === 3)
      );
    if (id === 'bhote-koshi-locator')
      return movers.some(
        (row) =>
          row.id === `${id}-bhote-koshi-incident-halo` &&
          row.count === 1 &&
          row.shown,
      );
    if (id === 'traffic')
      return (
        stats.count > 0 &&
        movers.some(
          (row) =>
            row.id === 'traffic-fill' && row.count > 0 && row.shown,
        )
      );
    if (['flights', 'military', 'transit'].includes(id))
      return (
        stats.count > 0 &&
        movers.some(
          (row) => row.id.startsWith(id + '-') && row.count > 0 && row.shown,
        )
      );
    // These layers can be enabled with no search, route or selected subject.
    if (
      [
        'directions',
        'military-awareness',
        'osm-places',
        'sea-marks',
        'ski-pistes',
      ].includes(id)
    )
      return true;
    return stats.count > 0;
  });
}

// Share addresses round the camera to 0.0001 degrees and whole metres/degrees.
// World positions must still match within a metre; projected positions allow
// two CSS pixels for that camera quantization. Counts and identities are exact.
export function numericTolerance(field) {
  if (/(?:^|\.)screen\.[xy]$/.test(field)) return 2;
  if (/(?:^|\.)position\.[xyz]$/.test(field)) return 1;
  return 1e-6;
}

/** Compare JSON without losing absent fields, nulls or identities in arrays. */
export function compareProbe(before, after, { skip = [], field = '' } = {}) {
  const differences = [];
  const visit = (left, right, path) => {
    if (skip.includes(path)) return;
    if (Object.is(left, right)) return;
    if (typeof left === 'number' && typeof right === 'number') {
      const tolerance = /(?:count|capacity|length|id)$/.test(path)
        ? 0
        : numericTolerance(path);
      if (
        Number.isFinite(left) &&
        Number.isFinite(right) &&
        Math.abs(left - right) <= tolerance
      )
        return;
    } else if (
      left &&
      right &&
      typeof left === 'object' &&
      typeof right === 'object' &&
      Array.isArray(left) === Array.isArray(right)
    ) {
      if (Array.isArray(left)) {
        if (left.length !== right.length)
          visit(left.length, right.length, `${path}.length`);
        const identified = [...left, ...right].every(
          (row) => row && typeof row === 'object' && row.id !== undefined,
        );
        if (identified) {
          const a = new Map(left.map((row) => [String(row.id), row]));
          const b = new Map(right.map((row) => [String(row.id), row]));
          if (a.size !== left.length || b.size !== right.length)
            differences.push({
              field: path,
              switchValue: left,
              coldStartValue: right,
              error: 'duplicate ids',
            });
          for (const id of new Set([...a.keys(), ...b.keys()]))
            visit(a.get(id), b.get(id), `${path}[${JSON.stringify(id)}]`);
        } else
          for (let i = 0; i < Math.max(left.length, right.length); i++)
            visit(left[i], right[i], `${path}[${i}]`);
      } else
        for (const key of new Set([
          ...Object.keys(left),
          ...Object.keys(right),
        ]))
          visit(left[key], right[key], path ? `${path}.${key}` : key);
      return;
    }
    differences.push({
      field: path,
      switchValue: left === undefined ? '<absent>' : left,
      coldStartValue: right === undefined ? '<absent>' : right,
    });
  };
  visit(before, after, field);
  return differences;
}

/** The production build drops its dev probe; inject the same implementation. */
export async function probeSnapshot(page, layers) {
  const probe = await page.evaluate(`(() => {
    const plain = (p) => p ? { x: p.x, y: p.y, z: p.z } : null;
    const createSettledState = ${createSettledState};
    const probe = (${createQaProbe})(window.__godsEyeView);
    const layers = ${JSON.stringify(layers)};
    try {
      return {
        layers: Object.fromEntries(layers.map((id) => {
          const module = window.__godsEyeView.dataManager.layers.get(id).module;
          const session = id === 'radio'
            ? { selected: module.getUIState().selected, audioState: module.getUIState().audioState }
            : id === 'wind' ? { reading: module.getRowControls().summary.reading }
            : id === 'osm-places' ? { results: module.getAnalystRecords(1000000) }
            : id === 'directions' ? { route: module.getRowControls().list } : {};
          return [id, {
            enabled: window.__godsEyeView.dataManager.layers.get(id).enabled,
            objects: probe.objects(id, 1000000), selected: probe.selected(id),
            session, sessionState: module.sessionState ?? [],
          }];
        })),
        following: probe.following(), movers: probe.movers(),
      };
    } finally { probe.destroy(); }
  })()`);
  return { ...probe, ledger: await drawLedger(page) };
}

// Display allocations are not content identities. Keep every slot and its
// generation, but number these allocator-local sequences within each family.
// Raw evidence retains the original IDs. A lost or extra slot still differs.
export function normalizeAllocations(snapshot) {
  const patterns = [
    ['imagery', /^(weather-)(\d+)$/],
    ['imagery', /^(wind-field-)(\d+)$/],
    ['imagery', /^(bhote-koshi-imagery-)(\d+)(-(?:left|right))$/],
    ['lines', /^(satellites-orbit-)(\d+)$/],
    ['movers', /^(satellites-points-)(\d+)(-\d+)$/],
  ];
  const ids = new Map();
  for (const [family, pattern] of patterns) {
    const rows = snapshot.ledger.filter(
      (row) => row.family === family && pattern.test(row.id),
    );
    const sequence = [
      ...new Set(rows.map((row) => Number(row.id.match(pattern)[2]))),
    ].sort((a, b) => a - b);
    for (const row of rows) {
      const [, prefix, number, suffix = ''] = row.id.match(pattern);
      ids.set(
        `${family}:${row.id}`,
        `${prefix}${sequence.indexOf(Number(number)) + 1}${suffix}`,
      );
    }
  }
  const rename = (row, family) => ({
    ...row,
    id: ids.get(`${family}:${row.id}`) ?? row.id,
  });
  return {
    ...snapshot,
    ledger: snapshot.ledger.map((row) => rename(row, row.family)),
    movers: snapshot.movers.map((row) => rename(row, 'movers')),
  };
}

/** Keep raw samples and declared exclusions beside the complete difference list. */
export function compareColdStart(
  switched,
  cold,
  { direction, owners = {}, allow = [], sessionState = true },
) {
  const ownership = normalizeAllocations({
    ledger: Object.entries(owners).map(([key, layer]) => {
      const colon = key.indexOf(':');
      return { family: key.slice(0, colon), id: key.slice(colon + 1), layer };
    }),
    movers: [],
  });
  switched = normalizeAllocations(switched);
  cold = normalizeAllocations(cold);
  const differences = [],
    skipped = [];
  const add = (layer, family, id, rows) =>
    differences.push(
      ...rows.map((row) => ({ layer, direction, family, id, ...row })),
    );
  const layerOf = (family, id) =>
    [...switched.ledger, ...cold.ledger, ...ownership.ledger].find(
      (row) => row.family === family && row.id === id && row.layer,
    )?.layer ?? '[page]';
  const ledger = compareLedgers(switched.ledger, cold.ledger, allow);
  for (const [side, rows] of [
    ['switch', ledger.onlyBefore],
    ['cold', ledger.onlyAfter],
  ])
    for (const { family, id } of rows)
      add(layerOf(family, id), family, id, [
        {
          field: 'present',
          switchValue: side === 'switch',
          coldStartValue: side === 'cold',
        },
      ]);
  for (const { family, id, before, after } of ledger.shown)
    add(layerOf(family, id), family, id, [
      { field: 'shown', switchValue: before, coldStartValue: after },
    ]);
  for (const row of switched.ledger) {
    const next = cold.ledger.find(
      (other) => other.family === row.family && other.id === row.id,
    );
    if (next) {
      // A field entry excuses one field of one set, with its reason.
      const rows = compareProbe(
        { kind: row.kind, count: row.count },
        { kind: next.kind, count: next.count },
      ).filter((difference) => {
        const exception = allow.find(
          (entry) =>
            entry.field === difference.field &&
            entry.id === row.id &&
            (!entry.family || entry.family === row.family),
        );
        if (exception)
          skipped.push({
            layer: layerOf(row.family, row.id),
            family: row.family,
            id: row.id,
            ...difference,
            reason: exception.reason,
          });
        return !exception;
      });
      add(layerOf(row.family, row.id), row.family, row.id, rows);
    }
  }
  for (const layer of new Set([
    ...Object.keys(switched.layers),
    ...Object.keys(cold.layers),
  ])) {
    const before = switched.layers[layer],
      after = cold.layers[layer];
    for (const row of compareProbe(before, after)) {
      const id = /^objects\[("(?:[^"\\]|\\.)*")\]/.exec(row.field)?.[1];
      add(layer, 'probe', id ? JSON.parse(id) : layer, [row]);
    }
  }
  add(
    '[page]',
    'probe',
    'following',
    compareProbe(switched.following, cold.following, { field: 'following' }),
  );
  // Keep all mover registry fields, including capacity, beyond the draw ledger.
  const a = new Map(switched.movers.map((row) => [String(row.id), row]));
  const b = new Map(cold.movers.map((row) => [String(row.id), row]));
  for (const id of new Set([...a.keys(), ...b.keys()]))
    add(
      layerOf('movers', id),
      'probe-movers',
      id,
      compareProbe(a.get(id), b.get(id)),
    );
  return {
    differences: differences.filter((row) => {
      const field = sessionState && sessionExclusion(row, switched);
      if (!field) return true;
      skipped.push({ ...row, sessionState: field });
      return false;
    }),
    skipped,
    ledger,
  };
}

/** Only declared fields and their drawn derivatives can differ from a link. */
export function sessionExclusion(row, snapshot) {
  const declared = snapshot.layers[row.layer]?.sessionState ?? [];
  for (const field of declared) {
    if (
      row.family === 'probe' &&
      (row.field === `session.${field}` ||
        row.field.startsWith(`session.${field}.`) ||
        row.field.startsWith(`session.${field}[`))
    )
      return field;
    // Session-only layers are absent from the link. Their drawing must still
    // survive the switch; the scenario checks these same rows against S first.
    if (
      field === 'enabled' &&
      (row.family !== 'probe' ||
        /^(enabled|objects|selected)(\.|\[|$)/.test(row.field))
    )
      return field;
    if (
      row.layer === 'radio' &&
      field === 'selected' &&
      ['radio-selected', 'radio-bracket'].includes(row.id)
    )
      return field;
    if (
      row.layer === 'directions' &&
      field === 'route' &&
      [
        'directions-route',
        'directions-steps',
        'directions-markers',
        'directions-marker-letters',
      ].includes(row.id)
    )
      return field;
  }
  return null;
}
