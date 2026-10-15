import assert from 'node:assert/strict';
import test from 'node:test';
import {
  daySpan,
  isIsoDate,
  normalizeEawsRegions,
  normalizeRegobsObservations,
  normalizeVarsomRegions,
} from './records.js';
import {
  addDays,
  dayLabel,
  inSeason,
  seasonLabel,
  seasonOf,
  windowDays,
} from './dates.js';
import {
  busiestWeek,
  currentDay,
  dangerTrend,
  dayBlend,
  isQuietWindow,
  observationState,
  ratingsByDay,
  regionFill,
} from './model.js';
import {
  observationCard,
  regionAnchor,
  regionCard,
  wrapLines,
} from './cards.js';
import { selectionForPick } from './selection.js';
import { createAvalancheSource } from './source.js';
import { createPlayback } from './playback.js';
import { createState } from './state.js';
import { DAY_DURATION_MS, FADED_ALPHA, SEEK_DURATION_MS } from './policy.js';

test('dates are validated as real calendar days', () => {
  assert.equal(isIsoDate('2026-03-07'), true);
  assert.equal(isIsoDate('2026-02-30'), false);
  assert.equal(isIsoDate('20260307'), false);
  assert.equal(daySpan('2026-02-27', '2026-03-08'), 9);
});

test('Varsom keeps rated (type A) regions with their days in order', () => {
  const regions = normalizeVarsomRegions([
    {
      Id: 3010,
      Name: 'Lyngen',
      TypeName: 'A',
      AvalancheWarningList: [
        {
          ValidFrom: '2026-03-08T00:00:00',
          DangerLevel: '4',
          MainText: 'High.',
        },
        {
          ValidFrom: '2026-03-07T00:00:00',
          DangerLevel: '3',
          MainText: ' Big   one. ',
        },
        { ValidFrom: 'bad', DangerLevel: '3' },
      ],
    },
    { Id: 3001, Name: 'Svalbard øst', TypeName: 'B', AvalancheWarningList: [] },
  ]);
  assert.deepEqual(regions, [
    {
      id: 'NO-3010',
      provider: 'varsom',
      name: 'Lyngen',
      days: [
        { date: '2026-03-07', level: 3, text: 'Big one.' },
        { date: '2026-03-08', level: 4, text: 'High.' },
      ],
    },
  ]);
  assert.throws(() => normalizeVarsomRegions({}), /invalid_forecast/);
});

test('regObs observations keep the path, drop unknowns and fix the trigger spelling', () => {
  const [first, second] = normalizeRegobsObservations([
    {
      RegId: 1,
      DtObsTime: '2026-03-06T08:00:00+01:00',
      ObsLocation: {
        Latitude: 61,
        Longitude: 7,
        ForecastRegionTID: 3024,
        ForecastRegionName: 'Sogn',
      },
      AvalancheObs: {},
      Observer: { NickName: 'a' },
    },
    {
      RegId: 2,
      DtObsTime: '2026-03-07T21:00:00+01:00',
      ObsLocation: { Latitude: 69.4, Longitude: 20.1 },
      AvalancheObs: {
        DtAvalancheTime: '2026-03-07T21:36:04+01:00',
        StartLat: 69.45,
        StartLong: 20.13,
        StopLat: 69.44,
        StopLong: 20.14,
        DestructiveSizeTID: 2,
        DestructiveSizeName: '2 - Medium',
        AvalancheTriggerName: 'Naturaly released',
        AvalancheName: 'Unknown',
        HeightStartZone: 995,
        HeightStopZone: 505,
      },
    },
    {
      RegId: 3,
      DtObsTime: 'never',
      ObsLocation: { Latitude: 1, Longitude: 1 },
    },
    { RegId: 4, DtObsTime: '2026-03-07T00:00:00Z', ObsLocation: {} },
  ]);
  assert.equal(first.id, '2', 'newest first');
  assert.equal(first.time, '2026-03-07T20:36:04.000Z');
  assert.deepEqual(first.stop, { lat: 69.44, lon: 20.14 });
  assert.equal(first.sizeClass, 2);
  assert.equal(first.trigger, 'Naturally released');
  assert.equal(first.type, null);
  assert.equal(first.url, 'https://www.regobs.no/registration/2');
  assert.equal(
    second.stop,
    null,
    'a release point without a runout stays a point',
  );
  assert.deepEqual(second.start, { lat: 61, lon: 7 });
  assert.equal(second.regionId, 'NO-3024');
});

test('EAWS outlines keep current Norwegian regions, rounded', () => {
  const ring = [
    [7.123456, 61.987654],
    [7.2, 61.9],
    [7.3, 62],
    [7.123456, 61.987654],
  ];
  const regions = normalizeEawsRegions({
    features: [
      {
        properties: { id: 'NO-3024' },
        geometry: { type: 'Polygon', coordinates: [ring] },
      },
      {
        properties: { id: 'NO-3001', valid_until: '2020-01-01' },
        geometry: { type: 'Polygon', coordinates: [ring] },
      },
      {
        properties: { id: 'AT-07' },
        geometry: { type: 'Polygon', coordinates: [ring] },
      },
    ],
  });
  assert.equal(regions.length, 1);
  assert.deepEqual(regions[0].polygons[0][0][0], [7.1235, 61.9877]);
});

test('a window is seven observed days, the anchor, and two forecast days', () => {
  const days = windowDays('2026-03-08');
  assert.equal(days.length, 10);
  assert.equal(days[0].date, '2026-03-01');
  assert.equal(days[7].date, '2026-03-08');
  assert.deepEqual(
    days.filter((day) => day.forecast).map((day) => day.date),
    ['2026-03-09', '2026-03-10'],
  );
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(dayLabel('2026-03-05'), 'Thu 5 Mar');
});

test('seasons run December to May and an off-season date belongs to the last one', () => {
  assert.equal(inSeason('2026-01-15'), true);
  assert.equal(inSeason('2026-10-11'), false);
  assert.equal(seasonOf('2025-12-03'), 2025);
  assert.equal(seasonOf('2026-03-08'), 2025);
  assert.equal(seasonOf('2026-10-11'), 2025);
  assert.equal(seasonLabel(2025), '2025–26');
});

test('a day holds its rating, then blends into the next', () => {
  assert.deepEqual(dayBlend(10, 3.2), { from: 3, to: 4, mix: 0 });
  assert.ok(Math.abs(dayBlend(10, 3.75).mix - 0.5) < 1e-9);
  assert.deepEqual(
    dayBlend(10, 12),
    { from: 9, to: 9, mix: 0 },
    'clamped to the last day',
  );
  assert.equal(currentDay(10, 3.9), 4);
});

test('region fills use the EAWS colour of the day and fade out unrated days', () => {
  const days = windowDays('2026-03-08');
  const ratings = ratingsByDay(
    {
      days: [
        { date: '2026-03-01', level: 3 },
        { date: '2026-03-02', level: 0 },
      ],
    },
    days,
  );
  assert.deepEqual(ratings.slice(0, 3), [3, 0, 0]);
  const considerable = regionFill(ratings, 0.2, 0.5);
  assert.ok(Math.abs(considerable.red - 1) < 1e-9);
  assert.ok(Math.abs(considerable.green - 0x99 / 255) < 1e-9);
  assert.equal(considerable.alpha, 0.5);
  assert.equal(regionFill(ratings, 1.2, 0.5).alpha, 0, 'no rating, no fill');
  assert.equal(dangerTrend([2, 3, 3, 0], 0), 1);
  assert.equal(dangerTrend([2, 3, 3, 0], 1), 0);
  assert.equal(
    dangerTrend([2, 3, 3, 0], 2),
    0,
    'unrated next day has no trend',
  );
});

test('an avalanche appears when it happened, runs out, then fades to a floor', () => {
  const first = '2026-03-01';
  const at = '2026-03-03T12:00:00Z'; // day 2.5 of the window
  assert.equal(observationState(at, first, 2.4).visible, false);
  const running = observationState(at, first, 2.6);
  assert.equal(running.visible, true);
  assert.ok(running.runout > 0 && running.runout < 1);
  assert.equal(running.fresh, true);
  const done = observationState(at, first, 3);
  assert.equal(done.runout, 1);
  assert.ok(
    Math.abs(observationState(at, first, 30).alpha - FADED_ALPHA) < 1e-9,
  );
});

test('off-season windows are quiet and replay opens the busiest week', () => {
  assert.equal(isQuietWindow([{ days: [{ level: 0 }] }], []), true);
  assert.equal(isQuietWindow([{ days: [{ level: 2 }] }], []), false);
  assert.equal(isQuietWindow([], [{ id: '1' }]), false);
  assert.deepEqual(
    busiestWeek([
      { from: 'a', count: 3 },
      { from: 'b', count: 9 },
      { from: 'c', count: 9 },
    ]).from,
    'b',
  );
  assert.equal(busiestWeek([{ from: 'a', count: 0 }]), null);
});

test('cards name the rating per day, mark forecasts, and credit the observer', () => {
  const days = windowDays('2026-03-08');
  const ratings = [0, 0, 0, 0, 0, 0, 2, 3, 4, 3];
  const card = regionCard(
    {
      name: 'Lyngen',
      days: [
        {
          date: '2026-03-08',
          level: 3,
          text: 'Avoid steep terrain. '.repeat(12),
        },
      ],
    },
    ratings,
    days,
    7,
  );
  assert.equal(card.title, 'Lyngen');
  assert.match(card.details[0], /^Sun 8 Mar\s+3 Considerable ↑$/);
  assert.match(card.details[1], /4 High ↓ \(forecast\)$/);
  assert.equal(card.accent, '#ff9900');
  assert.ok(card.details.includes('Varsom · NVE'));
  const obs = observationCard({
    time: '2026-03-07T20:36:04.000Z',
    size: '2 - Medium',
    trigger: 'Naturally released',
    type: null,
    startElevationM: 995,
    stopElevationM: 505,
    stop: { lat: 1, lon: 1 },
    region: 'Lyngen',
    observer: 'Skred.AS',
  });
  assert.equal(obs.title, 'Avalanche · 2 - Medium');
  assert.ok(
    obs.details.some(
      (line) => line === 'Release 995 m → runout 505 m (490 m drop)',
    ),
  );
  assert.equal(obs.details.at(-1), 'regObs · Skred.AS');
  assert.match(obs.details[0], /21:36 \(Norway\)$/);
});

test('long text wraps to card width and is cut with an ellipsis', () => {
  const lines = wrapLines('word '.repeat(80), 20, 3);
  assert.equal(lines.length, 3);
  assert.ok(lines.every((line) => line.length <= 20));
  assert.ok(lines[2].endsWith('…'));
  assert.deepEqual(
    regionAnchor([
      [
        [
          [0, 0],
          [2, 0],
          [2, 2],
          [0, 0],
        ],
      ],
    ]),
    {
      lon: 1,
      lat: 0.5,
    },
  );
});

test('picks resolve to a region or an avalanche, nothing else', () => {
  assert.deepEqual(selectionForPick('avalanches:obs:42:path'), {
    kind: 'observation',
    id: '42',
  });
  assert.deepEqual(selectionForPick('avalanches:region:NO-3010:0'), {
    kind: 'region',
    id: 'NO-3010',
  });
  assert.equal(selectionForPick('flights:abc'), null);
  assert.equal(selectionForPick(null), null);
});

test('the source reads every route through the same-origin proxy', async () => {
  const urls = [];
  const source = createAvalancheSource({
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.includes('/season')) return Response.json({ weeks: [] });
      if (url.includes('/observations'))
        return Response.json({ observations: [], stale: true });
      return Response.json({ regions: [] });
    },
  });
  await source.getRegions();
  const forecast = await source.getForecast({
    from: '2026-03-01',
    to: '2026-03-10',
  });
  const observed = await source.getObservations({
    from: '2026-03-01',
    to: '2026-03-08',
  });
  await source.getSeason({ season: 2025 });
  assert.deepEqual(urls, [
    '/api/avalanches/regions',
    '/api/avalanches/forecast?from=2026-03-01&to=2026-03-10',
    '/api/avalanches/observations?from=2026-03-01&to=2026-03-08',
    '/api/avalanches/season?season=2025',
  ]);
  assert.equal(forecast.stale, false);
  assert.equal(observed.stale, true);
  const failing = createAvalancheSource({
    fetchImpl: async () => new Response('busy', { status: 429 }),
  });
  await assert.rejects(
    failing.getRegions(),
    (error) => error.failureReason === 'rate_limited',
  );
});

function playbackFixture() {
  let callback = null;
  let now = 0;
  const state = createState();
  state.enabled = true;
  state.window = { days: windowDays('2026-03-08') };
  const applied = [];
  const playback = createPlayback({
    state,
    services: {
      animation: {
        request: (next) => ((callback = next), 1),
        cancel: () => (callback = null),
      },
    },
    parts: {
      rendering: { apply: (position) => applied.push(position) },
      presenter: { refresh() {} },
    },
  });
  const advance = (ms) => {
    now += ms;
    const next = callback;
    callback = null;
    next?.(now);
  };
  return {
    playback,
    state,
    advance,
    pending: () => Boolean(callback),
    applied,
  };
}

test('playback runs the window continuously and loops after the last day', () => {
  const { playback, state, advance } = playbackFixture();
  playback.begin();
  assert.equal(state.playing, true);
  advance(0);
  advance(DAY_DURATION_MS * 2.5);
  assert.ok(Math.abs(state.position - 2.5) < 1e-9);
  advance(DAY_DURATION_MS * 8.5);
  assert.equal(state.position, 0, 'loops after holding on the last day');
});

test('a clicked day glides to its middle and pauses', () => {
  const { playback, state, advance, pending } = playbackFixture();
  playback.begin();
  advance(0);
  playback.seekDay(8);
  assert.equal(state.playing, false);
  advance(SEEK_DURATION_MS / 2);
  assert.ok(state.position > 0 && state.position < 8.5);
  advance(SEEK_DURATION_MS);
  assert.equal(state.position, 8.5);
  assert.equal(pending(), false);
  playback.togglePlay();
  assert.equal(state.playing, true);
});

/** A strict little DOM: insertBefore refuses a reference that is not a child, as browsers do. */
function strictDocument() {
  const document = {
    createElement(tag) {
      const node = new EventTarget();
      const classes = new Set();
      Object.assign(node, {
        tagName: tag.toUpperCase(),
        ownerDocument: document,
        children: [],
        parentNode: null,
        dataset: {},
        hidden: false,
        disabled: false,
        title: '',
        textContent: '',
        offsetWidth: 0,
        style: { setProperty() {} },
        classList: {
          add: (name) => classes.add(name),
          remove: (name) => classes.delete(name),
          toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
          contains: (name) => classes.has(name),
        },
        setAttribute() {},
        appendChild(child) {
          return this.insertBefore(child, null);
        },
        insertBefore(child, reference) {
          if (reference && !this.children.includes(reference))
            throw new Error('NotFoundError: reference is not a child');
          child.remove();
          const index = reference
            ? this.children.indexOf(reference)
            : this.children.length;
          this.children.splice(index, 0, child);
          child.parentNode = this;
          return child;
        },
        append(...nodes) {
          for (const child of nodes) this.appendChild(child);
        },
        remove() {
          if (!this.parentNode) return;
          const siblings = this.parentNode.children;
          siblings.splice(siblings.indexOf(this), 1);
          this.parentNode = null;
        },
        closest(selector) {
          return classes.has(selector.slice(1))
            ? this
            : (this.parentNode?.closest?.(selector) ?? null);
        },
      });
      // A real accessor: Object.assign would copy the getter's value instead.
      Object.defineProperty(node, 'className', {
        get: () => [...classes].join(' '),
        set(value) {
          classes.clear();
          for (const name of String(value).split(/\s+/).filter(Boolean))
            classes.add(name);
        },
      });
      return node;
    },
  };
  return document;
}

const findAll = (node, className, out = []) => {
  if (node.classList?.contains(className)) out.push(node);
  for (const child of node.children ?? []) findAll(child, className, out);
  return out;
};

test('the panel draws the window, marks forecasts, and offers replay off-season', async () => {
  const { createAvalanchePanel } = await import('./panel.js');
  const document = strictDocument();
  const container = document.createElement('div');
  const calls = [];
  const panel = createAvalanchePanel({
    container,
    onDay: (index) => calls.push(['day', index]),
    onToggle: () => calls.push(['toggle']),
    onReplay: () => calls.push(['replay']),
    onWeek: (from, to) => calls.push(['week', from, to]),
    onLive: () => calls.push(['live']),
  });
  const days = windowDays('2026-10-12');
  const view = {
    days,
    anchor: '2026-10-12',
    position: 8.6,
    current: 8,
    playing: true,
    mode: 'live',
    season: null,
    seasonNumber: 2025,
    weekFrom: null,
    quiet: true,
    loading: false,
    error: null,
    visibleCount: 0,
  };
  panel.render(view);
  panel.render({ ...view, position: 9.1, current: 9 });
  const ticks = findAll(container, 'avalanche-panel-tick');
  assert.equal(ticks.length, 10);
  assert.equal(
    ticks.filter((tick) => tick.classList.contains('is-forecast')).length,
    2,
  );
  assert.equal(
    findAll(container, 'avalanche-panel-badge')[0].textContent,
    'Forecast',
  );
  const notice = findAll(container, 'avalanche-panel-notice')[0];
  assert.equal(notice.hidden, false);
  assert.equal(
    findAll(notice, 'avalanche-panel-action')[0].textContent,
    'Replay 2025–26',
  );
  panel.render({
    ...view,
    mode: 'replay',
    quiet: false,
    season: {
      season: 2025,
      weeks: [
        { from: '2026-03-02', to: '2026-03-08', count: 166 },
        { from: '2026-03-09', to: '2026-03-15', count: 0 },
      ],
    },
    weekFrom: '2026-03-02',
  });
  const weeks = findAll(container, 'avalanche-panel-week');
  assert.equal(weeks.length, 2);
  assert.equal(weeks[0].classList.contains('is-current'), true);
  assert.equal(weeks[1].disabled, true, 'an empty week cannot be opened');
  assert.equal(notice.hidden, true);
  panel.destroy();
  assert.equal(container.children.length, 0);
});

test('SLF bulletins rate each region at its worst level, with SLF refinement and summary', async () => {
  const { normalizeSlfForecast, normalizeSlfRegions, slfDayRatings } =
    await import('./records.js');
  const day = slfDayRatings({
    bulletins: [
      {
        regions: [
          { regionID: 'CH-7222', name: 'Lower Val Poschiavo' },
          { regionID: 'AT-07', name: 'not ours' },
        ],
        dangerRatings: [
          { mainValue: 'moderate', validTimePeriod: 'earlier' },
          {
            mainValue: 'considerable',
            validTimePeriod: 'later',
            customData: { CH: { subdivision: 'plus' } },
          },
        ],
        avalancheProblems: [
          {
            dangerRatingValue: 'moderate',
            customData: { CH: { coreZoneText: 'Morning.' } },
          },
          {
            dangerRatingValue: 'considerable',
            customData: { CH: { coreZoneText: 'Wet snow below 2400m.' } },
          },
        ],
      },
      {
        regions: [{ regionID: 'CH-1111' }],
        dangerRatings: [{ mainValue: 'no_snow' }],
      },
    ],
  });
  assert.deepEqual(day.get('CH-7222'), {
    name: 'Lower Val Poschiavo',
    level: 3,
    sub: '+',
    text: 'Wet snow below 2400m.',
  });
  assert.equal(day.get('CH-1111').level, 0);
  assert.equal(
    day.get('CH-1111').text,
    null,
    'an unrated region carries no summary',
  );
  assert.equal(day.has('AT-07'), false);
  assert.throws(() => slfDayRatings({}), /invalid_bulletin/);

  const regions = normalizeSlfForecast([
    { date: '2026-03-06', payload: { bulletins: [] } },
    {
      date: '2026-03-05',
      payload: {
        bulletins: [
          {
            regions: [{ regionID: 'CH-7222', name: 'Lower Val Poschiavo' }],
            dangerRatings: [{ mainValue: 'high' }],
          },
        ],
      },
    },
  ]);
  assert.deepEqual(regions, [
    {
      id: 'CH-7222',
      provider: 'slf',
      name: 'Lower Val Poschiavo',
      days: [{ date: '2026-03-05', level: 4, text: null, sub: null }],
    },
  ]);
  const outlines = normalizeSlfRegions({
    features: [
      {
        properties: {
          sector_id: '1111',
          sector_name: 'Préalpes vaudoises',
          sector_names: { en: 'Vaud Prealps' },
        },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [7, 46],
              [7.1, 46],
              [7.1, 46.1],
              [7, 46],
            ],
          ],
        },
      },
      {
        properties: { sector_id: 'x' },
        geometry: { type: 'Polygon', coordinates: [] },
      },
    ],
  });
  assert.deepEqual(
    outlines.map(({ id, provider, name }) => [id, provider, name]),
    [['CH-1111', 'slf', 'Vaud Prealps']],
  );
});

test('a Swiss card keeps the SLF refinement and credits SLF', () => {
  const days = windowDays('2026-03-08');
  const ratings = [0, 0, 0, 0, 0, 0, 0, 3, 3, 0];
  const card = regionCard(
    {
      provider: 'slf',
      name: 'Vaud Prealps',
      days: [{ date: '2026-03-08', level: 3, sub: '−', text: 'Above 2200m.' }],
    },
    ratings,
    days,
    7,
  );
  assert.match(card.details[0], /3− Considerable$/);
  assert.equal(card.details.at(-1), 'SLF · slf.ch');
  assert.ok(card.details.includes('Above 2200m.'));
});
