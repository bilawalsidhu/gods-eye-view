import assert from 'node:assert/strict';
import test from 'node:test';
import { STATE } from './satCore.js';
import {
  CLASS_CHIPS,
  LIST_LIMIT,
  STATE_TEXT,
  ageBanner,
  cardData,
  fmtPassTime,
  listIndexFromTarget,
  overheadList,
  passKey,
  passRowText,
  passesView,
} from './satPanel.js';
import { upcomingPasses } from './passes.js';

const DAY = 86_400_000;

test('overhead list: above 0 deg only, chip filter, behind-terrain marked, highest first, limited', () => {
  const objects = [];
  for (let i = 0; i < 60; i++)
    objects.push({
      index: i,
      name: `S${i}`,
      azDeg: i * 6,
      elDeg: i - 5,
      klass: i % 2 ? 'other' : 'visual',
      state: STATE.VISIBLE,
    });
  const list = overheadList(objects, {
    classesOn: new Set(['visual']),
    occlusion: (az, el) => (el < 10 ? 'terrain' : 'clear'),
  });
  assert.equal(list.total, 27); // even i from 6..58
  assert.ok(list.rows.length <= LIST_LIMIT);
  assert.equal(list.rows[0].index, 58);
  assert.ok(list.rows.every((r) => r.elDeg > 0 && r.klass === 'visual'));
  assert.equal(list.rows.at(-1).behindTerrain, true);
  assert.equal(overheadList(null).total, 0);
});

test('element-age banner: newest epoch, greyed and hidden counts, warning levels', () => {
  const t = Date.parse('2026-10-12T00:00:00Z');
  const fresh = ageBanner(
    { total: 10, stale: 0, dropped: 0, newestEpochMs: t - 0.5 * DAY },
    t,
  );
  assert.equal(fresh.level, 'ok');
  assert.match(
    fresh.text,
    /newest epoch 2026-10-11 12:00 UTC \(0\.5 d before Sky time\)/,
  );
  const old = ageBanner(
    { total: 10, stale: 4, dropped: 2, newestEpochMs: t - 9 * DAY },
    t,
  );
  assert.equal(old.level, 'warn');
  assert.match(old.text, /4 older than 7 d greyed · 2 beyond 30 d hidden/);
  assert.equal(
    ageBanner(
      { total: 1, stale: 0, dropped: 1, newestEpochMs: t - 40 * DAY },
      t,
    ).level,
    'error',
  );
  assert.match(
    ageBanner({ total: 1, stale: 0, dropped: 0, newestEpochMs: t + DAY }, t)
      .text,
    /after Sky time/,
  );
  assert.equal(ageBanner(null, t), null);
  assert.equal(ageBanner({ total: 0 }, t), null);
});

test('card: name, NORAD, class, az/el, range, range rate, state, element age; below-horizon case', () => {
  const t = Date.parse('2026-10-12T00:00:00Z');
  const meta = {
    index: 0,
    noradId: 25544,
    name: 'ISS (ZARYA)',
    objectId: '1998-067A',
    group: 'stations',
    klass: 'station',
    epochMs: t - 2 * DAY,
  };
  const card = cardData(
    {
      meta,
      row: {
        azDeg: 200,
        elDeg: 45.25,
        rangeKm: 580.4,
        rangeRateKmS: -3.21,
        state: STATE.VISIBLE,
      },
    },
    t,
  );
  const lines = Object.fromEntries(card.lines);
  assert.equal(card.title, 'ISS (ZARYA)');
  assert.equal(lines.NORAD, '25544');
  assert.equal(lines.Class, 'STATION · ISS');
  assert.equal(lines['Az / El'], '200.0° S / 45.3°');
  assert.equal(lines.Range, '580 km');
  assert.match(lines['Range rate'], /-3\.21 km\/s \(approaching\)/);
  assert.equal(lines.State, STATE_TEXT[STATE.VISIBLE]);
  assert.match(lines.Elements, /2\.0 d old/);
  assert.equal(card.aboveHorizon, true);
  const below = cardData(
    {
      meta: { ...meta, klass: 'other', group: 'active', epochMs: t - 9 * DAY },
      row: null,
    },
    t,
  );
  const b = Object.fromEntries(below.lines);
  assert.equal(b.Class, 'ACTIVE');
  assert.equal(b.Position, 'Below your horizon now');
  assert.match(b.Elements, /old: position less certain/);
  assert.equal(below.aboveHorizon, false);
  const dropped = cardData(
    { meta: { ...meta, epochMs: t - 31 * DAY }, row: null },
    t,
  );
  assert.equal(
    Object.fromEntries(dropped.lines).Position,
    'Hidden: elements more than 30 days from Sky time',
  );
  assert.equal(cardData(null, t), null);
});

test('chips cover every sky class', () => {
  assert.deepEqual(
    CLASS_CHIPS.map((c) => c.klass),
    ['station', 'nav', 'geo', 'visual', 'comms', 'other'],
  );
});

test('list click target: only a row button inside the list with a valid data-index selects', () => {
  const node = (tagName, attrs = {}, parentNode = null) => ({
    tagName,
    parentNode,
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
  });
  const list = node('UL');
  const li = node('LI', {}, list);
  const button = node('BUTTON', { 'data-index': '7' }, li);
  const span = node('SPAN', {}, button);
  // legitimate: the button itself and a nested element inside it
  assert.equal(listIndexFromTarget(list, button, 100), 7);
  assert.equal(listIndexFromTarget(list, span, 100), 7);
  // background: the list itself, an <li> gap, null, a node outside the list
  assert.equal(listIndexFromTarget(list, list, 100), null);
  assert.equal(listIndexFromTarget(list, li, 100), null);
  assert.equal(listIndexFromTarget(list, null, 100), null);
  const outside = node('BUTTON', { 'data-index': '3' }, node('DIV'));
  assert.equal(listIndexFromTarget(list, outside, 100), null);
  // a button in the list without / with a bad data-index
  for (const bad of [undefined, '', ' 1', '-1', '1.5', '1e2', 'x', '100']) {
    const attrs = bad === undefined ? {} : { 'data-index': bad };
    assert.equal(
      listIndexFromTarget(
        list,
        node('BUTTON', attrs, node('LI', {}, list)),
        100,
      ),
      null,
      `data-index ${JSON.stringify(bad)}`,
    );
  }
  assert.equal(
    listIndexFromTarget(list, node('BUTTON', { 'data-index': '0' }, li), 1),
    0,
  );
});

// ── passes and brightness ────────────────────────────────────────────────────────────────────
const NOW = new Date(2026, 9, 12, 20, 0).getTime(); // local time
const pass = (extra = {}) => ({
  index: 3,
  noradId: 25544,
  name: 'ISS (ZARYA)',
  riseMs: new Date(2026, 9, 12, 21, 14).getTime(),
  riseAzDeg: 225,
  peakMs: new Date(2026, 9, 12, 21, 17).getTime(),
  peakElevDeg: 72.6,
  peakAzDeg: 314,
  setMs: new Date(2026, 9, 12, 21, 20).getTime(),
  setAzDeg: 42,
  visible: true,
  estMag: -4.04,
  alsoNames: [],
  ...extra,
});

test('pass row: rise time/az, max elevation/time, set time/az, VISIBLE, est. mag; weekday when not today', () => {
  const t = passRowText(pass(), NOW);
  assert.deepEqual(t, {
    name: 'ISS (ZARYA)',
    rise: '21:14 SW',
    peak: '73° 21:17',
    set: '21:20 NE',
    visible: true,
    mag: 'est. mag -4.0',
  });
  const tomorrow = passRowText(
    pass({
      riseMs: NOW + 26 * 3600_000,
      peakMs: NOW + 26 * 3600_000,
      setMs: NOW + 26 * 3600_000,
      estMag: null,
      visible: false,
      alsoNames: ['ISS (NAUKA)'],
    }),
    NOW,
  );
  assert.match(tomorrow.rise, /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d\d:\d\d SW$/);
  assert.equal(tomorrow.mag, null);
  assert.equal(tomorrow.name, 'ISS (ZARYA) (+1 docked)');
  assert.equal(
    passRowText(pass({ riseMs: NOW - 1000, inProgress: true }), NOW).rise,
    'now SW',
  );
  assert.equal(fmtPassTime(NOW, NOW), '20:00');
  assert.equal(passKey(pass()), `25544@${pass().riseMs}`);
});

test('passes view: scanning progress, empty and done texts; visible-only filter', () => {
  assert.match(passesView(null, NOW).status, /Finding passes/);
  const scanning = {
    scanId: 1,
    done: false,
    processed: 4,
    total: 120,
    list: [],
  };
  assert.match(passesView(scanning, NOW).status, /^Scanning 4 of 120/);
  const done = {
    scanId: 1,
    done: true,
    processed: 120,
    total: 120,
    list: [
      pass(),
      pass({
        noradId: 5,
        riseMs: NOW + 600_000,
        setMs: NOW + 900_000,
        visible: false,
      }),
    ],
  };
  const v = passesView(done, NOW, {
    visibleOnly: true,
    upcoming: upcomingPasses,
  });
  assert.equal(v.rows.length, 1);
  assert.equal(v.title, 'Next passes (1)');
  assert.match(v.status, /estimates/);
  assert.equal(
    passesView(done, NOW, { visibleOnly: false, upcoming: upcomingPasses }).rows
      .length,
    2,
  );
  assert.match(
    passesView({ ...done, list: [] }, NOW, { upcoming: upcomingPasses }).status,
    /^No visible passes/,
  );
});

test('overhead list include filter; card brightness wording and next pass', () => {
  const objects = [
    { index: 1, name: 'A', azDeg: 10, elDeg: 30, klass: 'other', estMag: 4 },
    { index: 2, name: 'B', azDeg: 20, elDeg: 40, klass: 'other', estMag: null },
  ];
  const list = overheadList(objects, { include: (o) => o.estMag != null });
  assert.deepEqual(
    list.rows.map((r) => r.index),
    [1],
  );
  const meta = {
    name: 'A',
    noradId: 7,
    group: 'active',
    klass: 'other',
    epochMs: NOW,
    objectId: '',
    rcsM2: 2,
  };
  const row = {
    azDeg: 10,
    elDeg: 30,
    rangeKm: 900,
    rangeRateKmS: 1,
    state: STATE.VISIBLE,
    sunlit: true,
    estMag: 4.04,
  };
  const lines = (found, opts) =>
    Object.fromEntries(cardData(found, NOW, opts).lines);
  assert.equal(
    lines({ meta, row })['Brightness'],
    'est. mag 4.0 (estimate, +/- 2 mag)',
  );
  assert.equal(
    lines({ meta: { ...meta, rcsM2: null }, row: { ...row, estMag: null } })[
      'Brightness'
    ],
    'no estimate (no radar size in the catalogue)',
  );
  assert.equal(
    lines(
      { meta: { ...meta, rcsM2: null }, row: { ...row, estMag: null } },
      { rcsStatus: 'error' },
    )['Brightness'],
    'no estimate (catalogue sizes unavailable)',
  );
  assert.equal(
    lines({
      meta,
      row: { ...row, sunlit: false, estMag: null, state: STATE.SHADOW },
    })['Brightness'],
    'no estimate (in shadow)',
  );
  assert.equal(
    lines({ meta, row }, { nextPass: pass() })['Next pass'],
    '21:14 SW -> 73° 21:17 -> 21:20 NE (visible)',
  );
});

test('passes view: before the scanned window no rows and no count; past the cache rule no count', () => {
  const H = 3600_000;
  const done = {
    scanId: 2,
    fromMs: NOW,
    done: true,
    processed: 10,
    total: 10,
    list: [pass({ riseMs: NOW + H, setMs: NOW + H + 300_000 })],
  };
  const ok = passesView(done, NOW, { upcoming: upcomingPasses });
  assert.equal(ok.title, 'Next passes (1)');
  const gap = passesView(done, NOW - 1, { upcoming: upcomingPasses });
  assert.equal(gap.rows.length, 0, 'a pass before the window could be missing');
  assert.equal(gap.title, 'Next passes');
  assert.match(gap.status, /^Updating passes/);
  const short = passesView(done, NOW + 25 * H, {
    visibleOnly: false,
    upcoming: upcomingPasses,
  });
  assert.equal(short.title, 'Next passes');
  assert.match(short.status, /^Updating passes/);
  const scanningGap = passesView({ ...done, done: false }, NOW - 1, {
    upcoming: upcomingPasses,
  });
  assert.equal(scanningGap.rows.length, 0);
  assert.equal(scanningGap.title, 'Next passes');
});
