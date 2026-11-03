// resolve_area and the analyst area scopes as the voice runner sees them:
// what reaches the annotation engine, what reaches the model, and which
// outline a "drawn" or "outlined" scope counts over.
//
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceAreas, spokenArea } from './areaActions.js';
import { pointInPreparedArea } from '../data/areaGeometry.js';
import { presentResult } from './resultDisplay.js';

const square = (w, s, e, n) => [
  [w, s],
  [e, s],
  [e, n],
  [w, n],
  [w, s],
];

const BAGMATI_POLYGONS = [
  [square(84.4, 26.9, 86.6, 28.4), square(85.3, 27.6, 85.4, 27.7)],
];

/**
 * The annotation outline ladder as the area actions see it: an anchor, then
 * a deferred outline (here Bagmati from the guarded Nominatim route).
 */
function fakeLadder({
  outline,
  calls = [],
  delay = null,
  label = 'Bagmati Province',
} = {}) {
  return {
    calls,
    async resolveAnnotationTarget(request) {
      calls.push(request);
      if (!/bagmati/i.test(request.target)) return null;
      return {
        lat: 27.7,
        lon: 85.3,
        label,
        ring: null,
        resolveOutline: async () => {
          if (delay) await delay;
          if (outline !== undefined) return outline;
          return {
            ring: BAGMATI_POLYGONS[0][0],
            polygons: BAGMATI_POLYGONS,
            adminArea: 'Bagmati Province',
            adminLevel: 'admin1',
            synthesized: false,
            outlineSource: 'nominatim',
          };
        },
      };
    },
  };
}

const PUNJABS = [
  {
    kind: 'state',
    name: 'Punjab',
    country: 'India',
    source: 'natural-earth',
    polygons: [[square(73.8, 29.5, 77, 32.5)]],
  },
  {
    kind: 'state',
    name: 'Punjab',
    country: 'Pakistan',
    source: 'natural-earth',
    polygons: [[square(69.3, 27.7, 73.7, 34)]],
  },
];

function fakeAnnotations() {
  const marks = [];
  let seq = 0;
  return {
    marks,
    calls: [],
    async annotate(specs) {
      this.calls.push(specs);
      const results = specs.map((spec) => {
        const mark = {
          id: `anno-${(seq += 1)}`,
          ring: spec.ring,
          label: spec.label,
          areaId: spec.areaId || null,
          origin: spec.manual
            ? spec.origin === 'area'
              ? 'area'
              : 'drawn'
            : 'voice',
          synthesized: spec.approximate === true,
          createdAt: seq,
        };
        marks.push(mark);
        return { ok: true, id: mark.id };
      });
      return { drawn: results.length, results };
    },
    list() {
      return marks;
    },
  };
}

function makeAreas(overrides = {}) {
  const annotations = overrides.annotations || fakeAnnotations();
  const areas = createVoiceAreas({
    viewer: {},
    annotations,
    annotationResolver: fakeLadder(),
    findRegion: async () => null,
    findAdminCandidates: async (q) => (/^punjab$/i.test(q) ? PUNJABS : []),
    ...overrides,
  });
  return { areas, annotations };
}

test('resolve_area outlines every part and hands the model a handle, not coordinates', async () => {
  const { areas, annotations } = makeAreas();
  const result = await areas.resolveAreaAction({
    query: 'Bagmati province',
    draw: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.level, 'admin1');
  assert.equal(result.source, 'osm');
  assert.equal(result.sourceIdentity, 'Bagmati Province');
  assert.equal(areas.store.get(result.areaId).meta.adminLevel, 'admin1');
  assert.equal(result.display.source, 'OpenStreetMap');
  assert.equal(result.holes, 1);
  assert.equal(result.drawn, true);
  assert.match(result.say, /^Bagmati Province — about [\d,]+ km²$/);
  assert.equal(JSON.stringify(result).includes('coordinates'), false);
  const [spec] = annotations.calls[0];
  assert.equal(spec.manual, true);
  assert.equal(spec.origin, 'area');
  assert.equal(spec.areaId, result.areaId);
  assert.equal(spec.polygons[0].length, 2, 'the hole is drawn too');
});

test('draw failures stay honest in the result, spoken line, and card', async (t) => {
  const cases = [
    {
      name: 'annotation cap',
      annotations: {
        annotate: async () => ({
          ok: false,
          capped: true,
          results: [{ ok: false, error: 'annotation limit reached' }],
        }),
        list: () => [],
      },
      reason: /annotation limit reached/,
    },
    {
      name: 'renderer failure',
      annotations: {
        annotate: async () => ({
          ok: false,
          results: [{ ok: false, error: 'renderer unavailable' }],
        }),
        list: () => [],
      },
      reason: /renderer unavailable/,
    },
    { name: 'missing annotation engine', annotations: null, reason: /unavailable/ },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const areas = createVoiceAreas({
        viewer: {},
        annotations: entry.annotations,
        annotationResolver: fakeLadder(),
        findRegion: async () => null,
        findAdminCandidates: async () => [],
      });
      const result = await areas.resolveAreaAction({
        query: 'Bagmati province',
        draw: true,
      });
      assert.equal(result.ok, true, 'the area itself resolved');
      assert.equal(result.partial, true);
      assert.equal(result.drawn, false);
      assert.match(result.notDrawn, entry.reason);
      assert.match(result.say, /resolved the area, but couldn't draw/i);
      assert.match(result.say, entry.reason);
      const card = presentResult('resolve_area', result, {
        query: 'Bagmati province',
      });
      assert.ok(card.display.chips.some((chip) => chip.label === 'partial'));
      assert.ok(card.display.lines.some((line) => /Not drawn:/i.test(line)));
    });
  }
});

test('a newer turn cancels area drawing before any annotation or flight commits', async () => {
  let release;
  let entered;
  const enteredDraw = new Promise((resolve) => {
    entered = resolve;
  });
  let committed = false;
  const annotations = {
    generation: () => 0,
    async annotate(_specs, options) {
      entered();
      await new Promise((resolve) => {
        release = resolve;
      });
      if (options.signal?.aborted || !options.isCurrent?.())
        return { aborted: true, drawn: 0, results: [] };
      committed = true;
      return { drawn: 1, results: [{ ok: true, id: 'late-area' }] };
    },
    list: () => [],
  };
  const { areas } = makeAreas({ annotations });
  const controller = new AbortController();
  const pending = areas.resolveAreaAction(
    { query: 'Bagmati province', draw: true },
    {
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted,
    },
  );
  await enteredDraw;
  controller.abort();
  release();
  const result = await pending;
  assert.equal(result.code, 'CANCELLED');
  assert.equal(result.cancelled, true);
  assert.equal(committed, false);
});

test('an outline counts over the stored geometry, not the drawn copy', async () => {
  const { areas } = makeAreas();
  const resolved = await areas.resolveAreaAction({
    query: 'Bagmati',
    draw: true,
  });
  const scope = await areas.resolveAreaScope({ kind: 'annotation' });
  assert.equal(scope.ok, true);
  assert.equal(
    scope.area.areaId,
    resolved.areaId,
    'the outline resolves back to its area',
  );
  assert.equal(
    pointInPreparedArea(scope.area.prepared, 27.65, 85.35),
    false,
    'inside the hole',
  );
  assert.equal(pointInPreparedArea(scope.area.prepared, 27.0, 85.0), true);
});

test('"the area I drew" is the newest hand-drawn outline, never a voice outline', async () => {
  const { areas, annotations } = makeAreas();
  const none = await areas.resolveAreaScope({ kind: 'drawn' });
  assert.equal(none.ok, false);
  assert.equal(none.code, 'NO_DRAWN_AREA');
  await annotations.annotate([
    { type: 'area', manual: true, ring: square(0, 0, 1, 1), label: null },
  ]);
  await areas.resolveAreaAction({ query: 'Bagmati', draw: true });
  const drawn = await areas.resolveAreaScope({ kind: 'drawn' });
  assert.equal(drawn.ok, true);
  assert.equal(drawn.area.name, 'the drawn area');
  assert.equal(pointInPreparedArea(drawn.area.prepared, 0.5, 0.5), true);
  // By id, and an unknown id refuses.
  const byId = await areas.resolveAreaScope({
    kind: 'annotation',
    id: 'anno-1',
  });
  assert.equal(byId.area.name, 'the drawn area');
  const unknown = await areas.resolveAreaScope({
    kind: 'annotation',
    id: 'anno-99',
  });
  assert.equal(unknown.ok, false);
  const expired = await areas.resolveAreaScope({
    kind: 'area',
    areaId: 'area-99',
  });
  assert.equal(expired.code, 'AREA_UNKNOWN');
});

test('an ambiguous name returns candidates for the model to ask about', async () => {
  const { areas } = makeAreas();
  const result = await areas.resolveAreaAction({ query: 'Punjab', draw: true });
  assert.equal(result.ok, false);
  assert.equal(result.needsClarification, true);
  assert.deepEqual(
    result.candidates.map((c) => `${c.name}/${c.country}`),
    ['Punjab/India', 'Punjab/Pakistan'],
  );
  const picked = await areas.resolveAreaAction({
    candidateId: result.candidates[1].candidateId,
  });
  assert.equal(picked.ok, true);
  assert.equal(picked.country, 'Pakistan');
  assert.equal(picked.display.source, 'Natural Earth');
});

test('names reach the annotation outline ladder with the level as entity kind', async () => {
  const ladder = fakeLadder();
  const { areas } = makeAreas({ annotationResolver: ladder });
  await areas.resolveAreaAction({ query: 'Bagmati province' });
  const [request] = ladder.calls;
  assert.equal(request.target, 'Bagmati province');
  assert.equal(request.entityKind, 'state');
  assert.equal(request.footprint, true);
  assert.equal(request.allowDistant, true);
});

test('a verified province accepts a bare query with a separate level', async () => {
  const { areas } = makeAreas({ annotationResolver: fakeLadder() });
  const result = await areas.resolveAreaAction({
    query: 'Bagmati',
    level: 'admin1',
  });
  assert.equal(result.ok, true);
  assert.equal(result.name, 'Bagmati Province');
  assert.equal(result.level, 'admin1');
  assert.equal(result.sourceIdentity, 'Bagmati Province');

  const unverified = makeAreas({
    annotationResolver: fakeLadder({
      outline: {
        ring: BAGMATI_POLYGONS[0][0],
        polygons: BAGMATI_POLYGONS,
        adminArea: 'Bagmati',
        synthesized: false,
        outlineSource: 'nominatim',
      },
    }),
  });
  const refused = await unverified.areas.resolveAreaAction({
    query: 'Bagmati',
    level: 'admin1',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'AREA_IDENTITY_UNVERIFIED');
  assert.equal(unverified.areas.store.size, 0);

  const implicit = makeAreas({
    annotationResolver: fakeLadder({
      outline: {
        ring: BAGMATI_POLYGONS[0][0],
        polygons: BAGMATI_POLYGONS,
        adminArea: 'Bagmati',
        synthesized: false,
        outlineSource: 'nominatim',
      },
    }),
  });
  const implicitRefusal = await implicit.areas.resolveAreaAction({
    query: 'Bagmati',
  });
  assert.equal(implicitRefusal.ok, false);
  assert.equal(implicitRefusal.code, 'AREA_IDENTITY_UNVERIFIED');
  assert.equal(implicit.areas.store.size, 0);

  const retired = makeAreas({
    annotationResolver: fakeLadder({
      label: 'Bagmati',
      outline: {
        ring: BAGMATI_POLYGONS[0][0],
        polygons: BAGMATI_POLYGONS,
        adminArea: 'Bagmati Zone',
        synthesized: false,
        outlineSource: 'nominatim',
      },
    }),
  });
  const retiredRefusal = await retired.areas.resolveAreaAction({
    query: 'Bagmati',
  });
  assert.equal(retiredRefusal.ok, false);
  assert.equal(retiredRefusal.code, 'AREA_IDENTITY_MISMATCH');
  assert.equal(retired.areas.store.size, 0);
});

test('a place no outline source can trace is refused, not guessed', async () => {
  const miss = makeAreas({
    annotationResolver: fakeLadder({ outline: null }),
  });
  const none = await miss.areas.resolveAreaAction({ query: 'Bagmati' });
  assert.equal(none.code, 'AREA_NOT_FOUND');
  const off = makeAreas({
    annotationResolver: fakeLadder({
      outline: { unavailable: true, retryable: false },
    }),
  });
  const refused = await off.areas.resolveAreaAction({ query: 'Bagmati' });
  assert.equal(refused.code, 'AREA_UNAVAILABLE');
  assert.match(refused.error, /stays a point/);
  const unknown = await off.areas.resolveAreaAction({ query: 'Atlantis' });
  assert.equal(unknown.code, 'AREA_NOT_FOUND');
});

test('an old or unverified administrative outline is refused and never stored', async () => {
  for (const [outline, code] of [
    [
      {
        ring: BAGMATI_POLYGONS[0][0],
        polygons: BAGMATI_POLYGONS,
        adminArea: 'Bagmati Zone',
        outlineSource: 'nominatim',
      },
      'AREA_IDENTITY_MISMATCH',
    ],
    [
      {
        ring: BAGMATI_POLYGONS[0][0],
        polygons: BAGMATI_POLYGONS,
        adminArea: 'Bagmati Province',
        adminLevel: 'admin2',
        outlineSource: 'nominatim',
      },
      'AREA_IDENTITY_MISMATCH',
    ],
    [
      {
        ring: BAGMATI_POLYGONS[0][0],
        polygons: BAGMATI_POLYGONS,
        adminArea: 'Bagmati Province',
        outlineSource: 'nominatim',
      },
      'AREA_IDENTITY_UNVERIFIED',
    ],
    [
      {
        ring: BAGMATI_POLYGONS[0][0],
        polygons: BAGMATI_POLYGONS,
        outlineSource: 'nominatim',
      },
      'AREA_IDENTITY_UNVERIFIED',
    ],
    [
      {
        ring: BAGMATI_POLYGONS[0][0],
        polygons: BAGMATI_POLYGONS,
        synthesized: true,
        outlineSource: 'nominatim',
      },
      'AREA_IDENTITY_UNVERIFIED',
    ],
  ]) {
    const { areas } = makeAreas({
      annotationResolver: fakeLadder({ outline }),
    });
    const result = await areas.resolveAreaAction({
      query: 'Bagmati province',
      draw: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(areas.store.size, 0, 'a refused outline is not reusable');
    const repeated = await areas.resolveAreaAction({
      query: 'Bagmati province',
    });
    assert.equal(repeated.code, code);
    assert.equal(repeated.areaId, undefined);
    assert.equal(areas.store.size, 0);
  }
});

test('a region scope reuses the ladder and asks on ambiguity', async () => {
  const { areas } = makeAreas();
  const region = await areas.resolveRegion('Bagmati');
  assert.equal(region.name, 'Bagmati Province');
  assert.equal(region.sourceLabel, 'OpenStreetMap');
  assert.ok(region.prepared);
  const asked = await areas.resolveRegion('Punjab');
  assert.equal(asked.needsClarification, true);
  assert.equal(await areas.resolveRegion('Atlantis'), null);
});

test('an area around a landmark uses its enclosing outline, else a labelled buffer', async () => {
  const around = (outline, extra = {}) => ({
    resolveAnnotationTarget: async (request) => {
      assert.equal(request.entityKind, 'compound', 'grounds, not the building');
      return {
        lat: 37.7955,
        lon: -122.3937,
        label: 'Ferry Building',
        ring: null,
        ...(outline === undefined
          ? {}
          : { resolveOutline: async () => outline }),
        ...extra,
      };
    },
  });
  const grounds = makeAreas({
    annotationResolver: around({
      ring: square(-122.395, 37.794, -122.392, 37.797),
      polygons: [[square(-122.395, 37.794, -122.392, 37.797)]],
      synthesized: false,
      outlineSource: 'openfreemap',
    }),
  });
  const real = await grounds.areas.resolveAreaAction({
    query: 'Ferry Building, San Francisco',
    around: true,
  });
  assert.equal(real.ok, true);
  assert.equal(real.source, 'openfreemap');
  assert.equal(real.approximate, undefined);
  assert.equal(real.drawn, true, 'an around-area is always drawn');
  assert.equal(real.display.basis, 'enclosing mapped area');
  assert.equal(real.name, 'Ferry Building');

  // No enclosing outline (Nominatim off, nothing in the tiles): a buffer.
  const bare = makeAreas({
    annotationResolver: around({ unavailable: true, retryable: false }),
  });
  const approx = await bare.areas.resolveAreaAction({
    query: 'Ferry Building',
    around: true,
  });
  assert.equal(approx.ok, true);
  assert.equal(approx.approximate, true);
  assert.equal(approx.source, 'approximate');
  assert.match(approx.say, /^Rough area around Ferry Building/);
  assert.equal(approx.display.basis, '250 m around the landmark');
  assert.equal(bare.annotations.calls[0][0].approximate, true, 'drawn dashed');
  assert.ok(approx.areaKm2 > 0.15 && approx.areaKm2 < 0.25);

  // A buffer the ladder sized itself is still a buffer.
  const sized = makeAreas({
    annotationResolver: around({
      ring: square(-122.395, 37.794, -122.392, 37.797),
      synthesized: true,
    }),
  });
  const disc = await sized.areas.resolveAreaAction({
    query: 'Ferry Building',
    around: true,
  });
  assert.equal(disc.approximate, true);

  // A slow outline gives way to the buffer instead of holding the answer.
  const slow = makeAreas({
    aroundOutlineMs: 20,
    annotationResolver: {
      resolveAnnotationTarget: async () => ({
        lat: 37.7955,
        lon: -122.3937,
        ring: null,
        resolveOutline: () => new Promise(() => {}),
      }),
    },
  });
  const started = Date.now();
  const buffered = await slow.areas.resolveAreaAction({
    query: 'Ferry Building',
    around: true,
    radiusM: 400,
  });
  assert.ok(Date.now() - started < 1000);
  assert.equal(buffered.approximate, true);
  assert.equal(buffered.display.basis, '400 m around the landmark');

  const missing = makeAreas({
    annotationResolver: { resolveAnnotationTarget: async () => null },
  });
  const lost = await missing.areas.resolveAreaAction({
    query: 'Nowhere Hall',
    around: true,
  });
  assert.equal(lost.code, 'AREA_NOT_FOUND');
});

test('a superseded resolve returns cancelled and draws nothing', async () => {
  const { areas, annotations } = makeAreas();
  let current = true;
  const pending = areas.resolveAreaAction(
    { query: 'Bagmati', draw: true },
    { isCurrent: () => current },
  );
  current = false;
  const result = await pending;
  assert.equal(result.code, 'CANCELLED');
  assert.equal(annotations.calls.length, 0);
});

test('spoken areas round to two significant figures', () => {
  assert.equal(spokenArea(20_312.4), 'about 20,000 km²');
  assert.equal(spokenArea(0.196), 'about 0.2 km²');
  assert.equal(spokenArea(1234), 'about 1,200 km²');
  assert.equal(spokenArea(0), null);
});

// ── Review regressions: board ownership, eviction, runner replacement ──

/** Annotations fake with the engine's board generation and clear(). */
function boardAnnotations() {
  const fake = fakeAnnotations();
  let generation = 0;
  fake.generation = () => generation;
  fake.clear = () => {
    generation += 1;
    fake.marks.length = 0;
  };
  return fake;
}

test('a clear during a slow lookup is not undone by a late outline', async () => {
  let release;
  const annotations = boardAnnotations();
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const areas = createVoiceAreas({
    viewer: {},
    annotations,
    findRegion: async () => null,
    findAdminCandidates: async () => [],
    annotationResolver: fakeLadder({ delay: gate }),
  });
  const pending = areas.resolveAreaAction({ query: 'Bagmati', draw: true });
  await new Promise((resolve) => setTimeout(resolve, 5));
  annotations.clear(); // the person clears the map while the lookup runs
  release();
  const result = await pending;
  assert.equal(result.ok, true, 'the area itself still resolves');
  assert.equal(result.drawn, false);
  assert.match(result.notDrawn, /cleared/);
  assert.equal(result.partial, true);
  assert.match(result.say, /couldn't draw the outline:.*cleared/i);
  assert.equal(annotations.calls.length, 0, 'nothing drawn, no camera flight');
  // Asked again after the clear, it draws.
  const again = await areas.resolveAreaAction({ query: 'Bagmati', draw: true });
  assert.equal(again.drawn, true);
});

test('an outlined area keeps its full geometry past store eviction', async () => {
  const { areas } = makeAreas();
  const resolved = await areas.resolveAreaAction({
    query: 'Bagmati',
    draw: true,
  });
  // Far more areas than the store holds, none of them on the map.
  for (let i = 0; i < 40; i += 1)
    areas.store.put({
      geometry: [[square(i, 0, i + 0.5, 0.5)]],
      name: `filler ${i}`,
      source: 'osm',
    });
  const scope = await areas.resolveAreaScope({ kind: 'annotation' });
  assert.equal(scope.ok, true);
  assert.equal(scope.area.areaId, resolved.areaId);
  assert.equal(
    pointInPreparedArea(scope.area.prepared, 27.65, 85.35),
    false,
    'the hole is still a hole',
  );
  assert.equal(areas.store.has(resolved.areaId), true);
});

test('an outline from before a page reload asks to resolve again, never counts its drawing', async () => {
  const annotations = fakeAnnotations();
  const first = createVoiceAreas({
    viewer: {},
    annotations,
    annotationResolver: fakeLadder(),
    findRegion: async () => null,
    findAdminCandidates: async () => [],
  });
  await first.resolveAreaAction({ query: 'Bagmati', draw: true });
  // A new runner means a reloaded page: the store is new while the persisted
  // outline stays on the map. A mic restart keeps the runner (and handles);
  // see integrationContract.test.mjs.
  const second = createVoiceAreas({
    viewer: {},
    annotations,
    findRegion: async () => null,
    findAdminCandidates: async () => [],
  });
  const scope = await second.resolveAreaScope({ kind: 'annotation' });
  assert.equal(scope.ok, false);
  assert.equal(scope.code, 'AREA_EXPIRED');
});

test('a voice outline without an area handle counts over every part it drew', async () => {
  const { areas, annotations } = makeAreas();
  annotations.marks.push({
    id: 'anno-9',
    ring: square(0, 0, 1, 1),
    polygons: [[square(0, 0, 1, 1)], [square(2, 2, 3, 3)]],
    label: 'Presidio',
    origin: 'voice',
    createdAt: 99,
  });
  const scope = await areas.resolveAreaScope({ kind: 'annotation' });
  assert.equal(scope.ok, true);
  assert.equal(scope.area.approximate, false);
  assert.equal(pointInPreparedArea(scope.area.prepared, 2.5, 2.5), true);
  annotations.marks.push({
    id: 'anno-10',
    ring: square(5, 5, 6, 6),
    label: 'Around the pier',
    origin: 'voice',
    synthesized: true,
    createdAt: 100,
  });
  const buffer = await areas.resolveAreaScope({ kind: 'annotation' });
  assert.equal(buffer.area.approximate, true, 'a buffer says approximate');
});

test('an area around a landmark keeps the enclosing feature’s parts and holes', async () => {
  const { areas, annotations } = makeAreas({
    annotationResolver: {
      resolveAnnotationTarget: async () => ({
        lat: 37.7955,
        lon: -122.3937,
        ring: null,
        resolveOutline: async () => ({
          ring: square(-122.395, 37.794, -122.392, 37.797),
          polygons: [
            [
              square(-122.395, 37.794, -122.392, 37.797),
              square(-122.394, 37.795, -122.393, 37.796),
            ],
            [square(-122.39, 37.79, -122.389, 37.791)],
          ],
          adminArea: 'Pier Complex',
          synthesized: false,
          outlineSource: 'nominatim',
        }),
      }),
    },
  });
  const result = await areas.resolveAreaAction({
    query: 'Pier Complex',
    around: true,
  });
  assert.equal(result.source, 'osm');
  assert.equal(result.parts, 2);
  assert.equal(result.holes, 1);
  assert.equal(result.approximate, undefined);
  assert.equal(annotations.calls[0][0].polygons.length, 2, 'both parts drawn');
  const scope = await areas.resolveAreaScope({
    kind: 'area',
    areaId: result.areaId,
  });
  assert.equal(
    pointInPreparedArea(scope.area.prepared, 37.7955, -122.3935),
    false,
    'the courtyard hole',
  );
  assert.equal(
    pointInPreparedArea(scope.area.prepared, 37.7905, -122.3895),
    true,
    'the second part',
  );
});
