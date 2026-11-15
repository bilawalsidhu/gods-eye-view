import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ambientScore,
  selectWildlifeAmbientRows,
  buildWildlifeThumbnailEntry,
  buildWildlifeLabelEntry,
  buildWildlifeSelectedLabel,
  wildlifeAccent,
  WILDLIFE_OVERLAY_SOURCE_OPTIONS,
  WILDLIFE_LABEL_SOURCE_ID,
  WILDLIFE_LABEL_SOURCE_OPTIONS,
  WILDLIFE_SELECTED_SOURCE_OPTIONS,
} from './cards.js';
import { CCTV_THUMBNAIL_STYLE } from '../../overlays/worldOverlayTokens.js';
import {
  WILDLIFE_SELECTED_LABEL_MAX_CHARS,
  WILDLIFE_CARD_SHOW_MAX_METERS,
  WILDLIFE_CARD_HIDE_MAX_METERS,
  WILDLIFE_LABEL_LIMIT,
} from './policy.js';
import { formatAge } from './photoText.js';
import { createSelection } from './selection.js';
import { setLocale } from '../../i18n/index.js';
import {
  altitudeFade,
  altitudeScale,
  measureOverlayEntry,
} from '../../overlays/worldOverlayDraw.js';

const now = Date.UTC(2026, 10, 4, 18, 40);
const hour = 3_600_000;
const photo = {
  square:
    'https://inaturalist-open-data.s3.amazonaws.com/photos/123/square.jpeg',
  medium:
    'https://inaturalist-open-data.s3.amazonaws.com/photos/123/medium.jpeg',
  licence: 'cc-by-nc',
  attribution: '(c) Synthetic Photographer, some rights reserved',
};
const row = (overrides = {}) => ({
  stableId: 'inat:123',
  origin: 'inaturalist',
  lat: 47.6,
  lon: -122.3,
  observedAt: now - 2 * hour,
  observedOn: '2026-11-04',
  obscured: false,
  cell: null,
  quality: 'research',
  accuracyM: 12,
  commonName: "Anna's Hummingbird",
  scientificName: 'Calypte anna',
  iconic: 'Aves',
  threatened: false,
  conservation: null,
  count: null,
  provider: null,
  obsLicence: 'cc-by-nc',
  link: 'https://www.inaturalist.org/observations/123',
  photo,
  favesCount: 0,
  identificationAgreements: 0,
  ...overrides,
});
const acartia = (overrides = {}) =>
  row({
    stableId: 'acartia:abc',
    origin: 'acartia',
    iconic: 'Mammalia',
    commonName: 'Orca',
    scientificName: null,
    accuracyM: null,
    count: 5,
    provider: { name: 'Synthetic Network', entity: 'Whale Alert' },
    obsLicence: null,
    photo: null,
    link: 'https://acartia.io',
    ...overrides,
  });

test('ambient photo score prioritizes grade, threat, appreciation and recency exactly', () => {
  const base = row({ quality: 'needs_id' });
  assert.ok(
    Math.abs(ambientScore(row(), now) - ambientScore(base, now) - 2) < 1e-12,
  );
  assert.equal(
    ambientScore(row({ threatened: true, observedAt: now }), now) -
      ambientScore(row({ observedAt: now }), now),
    1,
  );
  assert.ok(
    ambientScore(row({ favesCount: 8 }), now) >
      ambientScore(row({ favesCount: 1 }), now),
  );
  assert.ok(
    Math.abs(
      ambientScore(row({ identificationAgreements: 3 }), now) -
        ambientScore(row(), now) -
        0.5 * Math.log1p(3),
    ) < 1e-12,
  );
  assert.ok(
    ambientScore(row({ quality: 'needs_id', observedAt: now - hour }), now) >
      ambientScore(
        row({ quality: 'needs_id', observedAt: now - 48 * hour }),
        now,
      ),
  );
  for (const input of [
    row({ obscured: true }),
    row({ photo: null }),
    row({ photo: { ...photo, licence: 'cc-by-nd' } }),
  ])
    assert.equal(ambientScore(input, now), -Infinity);
});

test('ambient ranking ties by stable id and never replaces a visible incumbent', () => {
  const a = row({ stableId: 'inat:a' });
  const b = row({ stableId: 'inat:b' });
  assert.deepEqual(
    selectWildlifeAmbientRows([b, a], [], now).map((item) => item.stableId),
    ['inat:a', 'inat:b'],
  );
  const slightlyBetter = row({ stableId: 'inat:b', observedAt: now - hour });
  assert.ok(ambientScore(slightlyBetter, now) - ambientScore(a, now) < 0.5);
  assert.equal(
    selectWildlifeAmbientRows([a, slightlyBetter], ['inat:a'], now, 1)[0]
      .stableId,
    'inat:a',
  );
  assert.equal(
    selectWildlifeAmbientRows(
      [a, row({ stableId: 'inat:b', threatened: true })],
      ['inat:a'],
      now,
      1,
    )[0].stableId,
    'inat:a',
  );
  assert.equal(
    selectWildlifeAmbientRows([a], ['gone'], now, 24)[0].stableId,
    a.stableId,
  );
});

test('ambient entries are stable, accessible and select in place until their row is gone', () => {
  const selected = [];
  let exists = true;
  const entry = buildWildlifeThumbnailEntry(row(), now, {
    select(id) {
      selected.push(id);
    },
    hasRow: () => exists,
  });
  assert.equal(entry.id, 'sighting:inat:123');
  assert.equal(entry.interactive, true);
  assert.equal(entry.accessibilityLabel, "Show Anna's Hummingbird sighting");
  assert.equal(entry.activate(), true);
  assert.deepEqual(selected, ['inat:123']);
  exists = false;
  assert.equal(entry.activate(), false);
  assert.equal(selected.length, 1);
  assert.equal(buildWildlifeThumbnailEntry(row({ obscured: true }), now), null);
});

test('all wildlife name labels prefer a complete word before their ellipsis and retain the full accessible name', () => {
  const commonName =
    'Great Blue Heron With An Unusually Lengthy Synthetic Common Name';
  for (const build of [buildWildlifeLabelEntry, buildWildlifeSelectedLabel]) {
    const entry = build(row({ commonName }));
    assert.equal(entry.title, 'GREAT BLUE HERON WITH AN UNUSUALLY…');
    assert.ok(
      Array.from(entry.title).length <= WILDLIFE_SELECTED_LABEL_MAX_CHARS,
    );
    assert.ok(entry.accessibilityLabel.includes(commonName));
    const unbroken = build(row({ commonName: '𓅃'.repeat(60) }));
    assert.equal(
      Array.from(unbroken.title).length,
      WILDLIFE_SELECTED_LABEL_MAX_CHARS,
    );
    assert.ok(unbroken.title.endsWith('…'));
    assert.ok(!unbroken.title.includes('\ufffd'));
  }
});

test('thumbnail entries use every shared thumbnail token and wildlife altitude curves', () => {
  const entry = buildWildlifeThumbnailEntry(row(), now);
  assert.deepEqual([entry.thumbnailWidth, entry.thumbnailHeight], [96, 72]);
  for (const key of ['thumbnailPadX', 'thumbnailPadTop', 'thumbnailPadBottom'])
    assert.equal(entry[key], CCTV_THUMBNAIL_STYLE.padding);
  const mapping = {
    thumbnailTitleHeight: 'titleHeight',
    thumbnailTitleChars: 'titleChars',
    thumbnailBackground: 'background',
    thumbnailTitleColor: 'titleColor',
    thumbnailTitleFont: 'titleFont',
    thumbnailLeaderColor: 'leader',
    thumbnailRuleColor: 'rule',
    thumbnailRuleHeight: 'ruleHeight',
    thumbnailRadius: 'radius',
  };
  for (const [field, token] of Object.entries(mapping))
    assert.equal(entry[field], CCTV_THUMBNAIL_STYLE[token]);
  assert.equal(entry.altitudeScale.fullEnd, 20_000);
  assert.equal(entry.altitudeScale.midEnd, 120_000);
  assert.equal(entry.altitudeFadeStart, 70_000);
  assert.equal(entry.altitudeFadeEnd, 125_000);
  assert.equal(entry.maxDistance, 600_000);
  assert.equal(entry.minAnchorSeparationPx, 112);
  assert.equal(entry.accent, wildlifeAccent('Aves'));
  assert.equal(entry.horizonCull, true);
  assert.equal(entry.requireImage, true);
  assert.deepEqual(entry.details, ['© Synthetic Photographer']);
  assert.equal(entry.thumbnailFixedWidth, true);
  assert.equal(entry.thumbnailFit, 'contain');
  assert.deepEqual(JSON.parse(JSON.stringify(entry)), entry);
  assert.equal(entry.interactive, false);
  assert.equal(Object.isFrozen(WILDLIFE_OVERLAY_SOURCE_OPTIONS), true);
  assert.equal(WILDLIFE_OVERLAY_SOURCE_OPTIONS.cohortLimit, 24);
  assert.equal(WILDLIFE_SELECTED_SOURCE_OPTIONS.cohortLimit, 1);
  assert.equal(WILDLIFE_SELECTED_SOURCE_OPTIONS.collisionCapacity, 1);
});

test('ambient cards retain only the credited creator and leave names for host truncation', () => {
  const commonName = 'An extremely long synthetic organism name';
  for (const [attribution, creator] of [
    [
      '(c) Synthetic Photographer, some rights reserved (CC BY-NC)',
      'Synthetic Photographer',
    ],
    ['© Doe, Jane, some rights reserved (CC BY)', 'Doe, Jane'],
    ['(c) Synthetic Observer, no rights reserved (CC0)', 'Synthetic Observer'],
    ['Doe, Jane, CC BY', 'Doe, Jane'],
    ['Synthetic Photographer, CC BY-NC', 'Synthetic Photographer'],
    ['© Synthetic Photographer (CC BY-SA 4.0)', 'Synthetic Photographer'],
    ['Synthetic Photographer, CC0', 'Synthetic Photographer'],
    ['Synthetic Photographer', 'Synthetic Photographer'],
  ]) {
    const input = row({ commonName, photo: { ...photo, attribution } });
    const entry = buildWildlifeThumbnailEntry(input, now);
    assert.equal(
      entry.title,
      commonName,
      'the overlay host truncates the title',
    );
    assert.equal(entry.thumbnailFixedWidth, true);
    assert.deepEqual(entry.details, [`© ${creator}`]);
    assert.doesNotMatch(
      entry.details.join(' '),
      /Photo:|reserved|CC BY|Not a census/,
    );
  }
  for (const attribution of [
    'some rights reserved (CC BY)',
    '(c) ',
    'CC BY',
    'CC-BY-NC',
    '© (CC BY)',
  ]) {
    assert.equal(
      buildWildlifeThumbnailEntry(
        row({ photo: { ...photo, attribution } }),
        now,
      ),
      null,
      'a missing creator never becomes a made-up ambient credit',
    );
  }
});

test('ambient cards fade and scale gradually through the 120 km height band', () => {
  const entry = buildWildlifeThumbnailEntry(row(), now);
  const options = {
    fadeStart: entry.altitudeFadeStart,
    fadeEnd: entry.altitudeFadeEnd,
  };
  assert.equal(altitudeFade(70_000, options), 1);
  assert.ok(altitudeFade(100_000, options) > altitudeFade(120_000, options));
  assert.ok(altitudeFade(120_000, options) > 0);
  assert.equal(altitudeFade(125_000, options), 0);
  assert.equal(altitudeScale(20_000, entry.altitudeScale), 1);
  assert.equal(altitudeScale(120_000, entry.altitudeScale), 0.9);
  assert.ok(
    Math.abs(
      altitudeScale(119_999, entry.altitudeScale) -
        altitudeScale(120_001, entry.altitudeScale),
    ) < 0.001,
  );
});

test('selected rows use the shared selected treatment without duplicating photo content', () => {
  for (const input of [
    row(),
    row({ photo: null }),
    row({ obscured: true, observedAt: null, accuracyM: null }),
    acartia(),
  ]) {
    const label = buildWildlifeSelectedLabel(input);
    assert.equal(label.id, `wildlife-sightings-label:${input.stableId}`);
    assert.equal(label.title, input.commonName.toLocaleUpperCase('en'));
    assert.equal(label.variant, 'label');
    assert.equal(label.placement, 'above');
    assert.equal(label.verticalOnly, true);
    assert.equal(label.protected, true);
    assert.equal(label.paintLane, 'selected');
    assert.equal(label.priority, Number.MAX_SAFE_INTEGER);
    assert.equal(label.interactive, false);
    assert.equal(label.selected, true);
    assert.equal(label.details, undefined, 'no link line on canvas cards');
    assert.equal(label.horizonCull, true);
    assert.equal(label.edgeFade, 'keyhole');
    assert.equal(label.accent, wildlifeAccent(input.iconic));
    for (const field of ['image', 'thumbnailWidth', 'pinned', 'activate'])
      assert.equal(
        Object.hasOwn(label, field),
        false,
        `${field} is absent from the selected name label`,
      );
    assert.deepEqual(JSON.parse(JSON.stringify(label)), label);
  }
  const ctx = { measureText: (value) => ({ width: String(value).length * 6 }) };
  const measured = measureOverlayEntry(ctx, buildWildlifeSelectedLabel(row()));
  assert.equal(
    measured.titleH,
    15,
    'selected names use the shared selected title metrics',
  );
  assert.equal(measured.padX, 12);
  assert.equal(measured.padY, 8);
});

test('selected labels normalize one bounded common-name line and stay absent when unnamed', () => {
  const label = buildWildlifeSelectedLabel(
    row({
      commonName: `Synthetic\n  ${'organism '.repeat(10)}`,
    }),
  );
  assert.doesNotMatch(label.title, /\n|  /);
  assert.ok(
    Array.from(label.title).length <= WILDLIFE_SELECTED_LABEL_MAX_CHARS,
  );
  assert.equal(label.title, 'SYNTHETIC ORGANISM ORGANISM ORGANISM…');
  assert.ok(label.title.endsWith('…'));
  assert.equal(buildWildlifeSelectedLabel(row({ commonName: null })), null);
  assert.equal(
    buildWildlifeSelectedLabel(row({ commonName: null, scientificName: null })),
    null,
  );
});

test('detail labels show only common names, with no age, grade, accuracy or photo details', () => {
  const label = buildWildlifeLabelEntry(row());
  assert.equal(label.id, 'wildlife-sightings-label:inat:123');
  assert.equal(label.title, "ANNA'S HUMMINGBIRD");
  assert.equal(label.variant, 'label');
  assert.equal(label.collisionGroup, 'ambient-label');
  assert.equal(label.yieldToCollisionGroup, 'ambient-card');
  assert.equal(
    label.stateless,
    true,
    'labels never retain overlapping incumbent or exit placements',
  );
  assert.equal(label.paintLane, 'ambient-label');
  assert.equal(label.horizonCull, true);
  assert.equal(label.edgeFade, 'keyhole');
  assert.equal(label.interactive, false);
  assert.equal(label.accent, wildlifeAccent('Aves'));
  for (const field of [
    'details',
    'image',
    'accuracyM',
    'quality',
    'observedAt',
    'maxDistance',
    'altitudeFadeStart',
    'altitudeFadeEnd',
    'selected',
  ])
    assert.equal(Object.hasOwn(label, field), false, field);
  assert.equal(WILDLIFE_LABEL_SOURCE_ID, 'wildlife-sightings-labels');
  assert.equal(WILDLIFE_LABEL_LIMIT, 150);
  assert.equal(Object.isFrozen(WILDLIFE_LABEL_SOURCE_OPTIONS), true);
  assert.equal(WILDLIFE_LABEL_SOURCE_OPTIONS.cohortLimit, WILDLIFE_LABEL_LIMIT);
  assert.equal(
    WILDLIFE_LABEL_SOURCE_OPTIONS.collisionCapacity,
    WILDLIFE_LABEL_LIMIT,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(label)), label);
});

test('unnamed observations have no ambient label and names come only from the row', () => {
  for (const commonName of [null, undefined, '', ' \n\t '])
    assert.equal(buildWildlifeLabelEntry({ ...row(), commonName }), null);
  assert.equal(
    buildWildlifeLabelEntry({ ...row(), commonName: 'Red-tailed hawk' }).title,
    'RED-TAILED HAWK',
  );
});

test('ambient names select in place and reject activation after their row disappears', () => {
  let selectedId = null;
  let exists = true;
  const label = buildWildlifeLabelEntry(row(), {
    select(id) {
      selectedId = id;
    },
    hasRow: () => exists,
  });
  assert.equal(label.interactive, true);
  assert.equal(label.accessibilityLabel, "Show Anna's Hummingbird sighting");
  assert.equal(label.activate(), true);
  assert.equal(selectedId, 'inat:123');
  exists = false;
  assert.equal(label.activate(), false);
});

test('selected name labels retain the existing altitude fade through 400 km', () => {
  for (const input of [row(), row({ photo: null }), acartia()]) {
    const entry = buildWildlifeSelectedLabel(input);
    const options = {
      fadeStart: entry.altitudeFadeStart,
      fadeEnd: entry.altitudeFadeEnd,
    };
    assert.equal(altitudeFade(30_000, options), 1);
    assert.ok(altitudeFade(300_000, options) > 0);
    assert.equal(altitudeFade(400_000, options), 0);
    assert.equal(altitudeFade(5_000_000, options), 0);
  }
});

test('compact ages follow shared translated minute, hour and day forms', () => {
  assert.equal(formatAge(59_999), '1m');
  assert.equal(formatAge(60 * 60_000), '1h');
  assert.equal(formatAge(2 * 24 * hour), '2d');
  assert.equal(formatAge(-1), null);
  assert.equal(formatAge(NaN), null);
  assert.equal(wildlifeAccent('Protozoa'), '#9aa7b3');
});

function ambientFixture(rows, screens) {
  const state = {
    enabled: true,
    renderedRows: rows,
    ambientRows: [],
    ambientIds: [],
    labelRows: [],
    selectedId: null,
    positions: new Map(
      rows.map((row) => [row.stableId, screens.get(row.stableId)]),
    ),
    pointById: new Map(),
    rowById: new Map(rows.map((row) => [row.stableId, row])),
    viewer: {
      scene: { canvas: { clientWidth: 1200, clientHeight: 900 } },
      camera: { positionCartographic: { height: 30_000 } },
    },
  };
  const photos = [];
  const painted = [];
  const entries = new Map();
  let cardSourceOptions;
  const selection = createSelection({
    state,
    services: {
      now: () => now,
      project: (_scene, position) => position,
      overlayHost: {
        setEntries(id, _entries, options) {
          entries.set(id, _entries);
          if (id === 'wildlife-sightings') cardSourceOptions = options;
        },
      },
    },
    parts: {
      rendering: {
        occluder: () => null,
        requestRender() {},
        setPhotoCardVisibility: (ids) => painted.push([...ids]),
      },
      photos: { get: () => null, setAmbient: (rows) => photos.push(rows) },
    },
  });
  return {
    state,
    selection,
    photos,
    painted,
    entries,
    get cardSourceOptions() {
      return cardSourceOptions;
    },
  };
}

test('label candidates and host priorities use ambientScore before the candidate cap', () => {
  const rows = Array.from({ length: WILDLIFE_LABEL_LIMIT + 20 }, (_, i) =>
    row({
      stableId: `inat:${String(i).padStart(3, '0')}`,
      commonName: `Synthetic bird ${i}`,
      favesCount: i,
    }),
  );
  const f = ambientFixture(
    rows,
    new Map(
      rows.map((r, i) => [
        r.stableId,
        { x: 10 + (i % 40) * 28, y: 200 + Math.floor(i / 40) * 28 },
      ]),
    ),
  );
  f.selection.refreshAmbient();
  const entries = f.entries.get('wildlife-sightings-labels');
  assert.equal(entries.length, WILDLIFE_LABEL_LIMIT);
  assert.deepEqual(
    entries.map((entry) => entry.id),
    rows
      .slice(20)
      .reverse()
      .map((r) => `wildlife-sightings-label:${r.stableId}`),
  );
  for (const r of f.state.labelRows)
    assert.equal(
      buildWildlifeLabelEntry(r, { nowMs: now }).priority,
      ambientScore(r, now),
    );
});

test('ambient source forwards actual painted membership to badge visibility', () => {
  const r = row();
  const f = ambientFixture([r], new Map([[r.stableId, { x: 150, y: 150 }]]));
  f.selection.refreshAmbient();
  assert.deepEqual(f.painted, [], 'a queued photo is not a painted card');
  f.cardSourceOptions.onVisibilityChange(new Set([`sighting:${r.stableId}`]));
  assert.deepEqual(f.painted, [[`sighting:${r.stableId}`]]);
  f.cardSourceOptions.onVisibilityChange(new Set());
  assert.deepEqual(f.painted.at(-1), []);
});

test('new ambient cards admit at most one highest-score photo per screen region', () => {
  const rows = Array.from({ length: 24 }, (_, i) =>
    row({ stableId: `inat:${i}`, favesCount: i }),
  );
  const screens = new Map(
    rows.map((row, i) => [
      row.stableId,
      {
        x: 150 + (Math.floor(i / 2) % 4) * 300,
        y: 150 + Math.floor(i / 8) * 300,
      },
    ]),
  );
  const f = ambientFixture(rows, screens);
  f.selection.refreshAmbient();
  assert.equal(f.state.ambientRows.length, 12);
  assert.ok(
    f.state.ambientRows.every(
      (row) => Number(row.stableId.split(':')[1]) % 2 === 1,
    ),
  );
  assert.equal(
    new Set(
      f.state.ambientRows.map((row) => {
        const p = screens.get(row.stableId);
        return `${Math.floor(p.x / 300)}:${Math.floor(p.y / 300)}`;
      }),
    ).size,
    12,
  );
});

test('pans retain every on-screen photo and refreshes only fill free slots', () => {
  const a = row({ stableId: 'inat:a' });
  const b = row({ stableId: 'inat:b' });
  const c = row({ stableId: 'inat:c', favesCount: 1000 });
  const screens = new Map([
    [a.stableId, { x: 150, y: 150 }],
    [b.stableId, { x: 450, y: 150 }],
    [c.stableId, { x: 170, y: 150 }],
  ]);
  const f = ambientFixture([a, b], screens);
  f.selection.refreshAmbient();
  const initial = f.state.ambientIds.slice();
  // This pan moves the two incumbents into one region. Neither may be evicted.
  f.state.positions.set(b.stableId, { x: 200, y: 160 });
  f.selection.refreshAmbient();
  assert.deepEqual(f.state.ambientIds, initial);
  f.state.rowById.set(c.stableId, c);
  f.state.positions.set(c.stableId, screens.get(c.stableId));
  // A new random sample can omit both incumbent rows from the rendered batch.
  f.state.renderedRows = [c];
  f.selection.refreshAmbient();
  assert.deepEqual(f.state.ambientIds, initial);
  assert.deepEqual(
    new Set(f.selection.retainedAmbientRows().map((row) => row.stableId)),
    new Set(initial),
  );
  f.state.positions.set(a.stableId, { x: -1, y: 150 });
  assert.deepEqual(
    f.selection.retainedAmbientRows().map((row) => row.stableId),
    [b.stableId],
  );
});

test('ambient show/hide thresholds have hysteresis without small-zoom toggles', () => {
  const a = row();
  const f = ambientFixture([a], new Map([[a.stableId, { x: 150, y: 150 }]]));
  const height = f.state.viewer.camera.positionCartographic;
  height.height = WILDLIFE_CARD_SHOW_MAX_METERS - 1;
  f.selection.refreshAmbient();
  assert.equal(f.state.ambientRows.length, 1);
  for (const altitude of [110_001, 119_999, 120_001, 124_999, 110_001]) {
    height.height = altitude;
    f.selection.refreshAmbient();
    assert.equal(f.state.ambientRows.length, 1);
  }
  height.height = WILDLIFE_CARD_HIDE_MAX_METERS;
  f.selection.refreshAmbient();
  assert.equal(f.state.ambientRows.length, 0);
  height.height = WILDLIFE_CARD_HIDE_MAX_METERS - 1;
  f.selection.refreshAmbient();
  assert.equal(f.state.ambientRows.length, 0);
  height.height = WILDLIFE_CARD_SHOW_MAX_METERS;
  f.selection.refreshAmbient();
  assert.equal(f.state.ambientRows.length, 1);
});
