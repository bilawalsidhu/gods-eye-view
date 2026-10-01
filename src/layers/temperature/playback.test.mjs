import assert from 'node:assert/strict';
import test from 'node:test';
import { blendAlphas, dominantFrame, playheadAt } from './filmstrip.js';
import { monthPlayhead } from './indicator.js';
import { createPlayback } from './playback.js';
import {
  CROSSFADE_SHARE,
  MONTH_DURATION_MS,
  SEEK_DURATION_MS,
} from './policy.js';
import { createState } from './state.js';

const months = (year, count = 12) =>
  Array.from({ length: count }, (_, index) =>
    new Date(Date.UTC(year, index, 1)).toISOString().slice(0, 10),
  );
const YEAR = months(2019);

/** Two stacked layers cover this much of the basemap. */
const coverage = (alphas) => 1 - alphas.reduce((rest, a) => rest * (1 - a), 1);

test('a month holds before it blends, and the blend eases at both ends', () => {
  const hold = 1 - CROSSFADE_SHARE;
  assert.deepEqual(playheadAt(12, 3), { from: 3, to: 4, mix: 0 });
  assert.equal(playheadAt(12, 3 + hold * 0.9).mix, 0);
  assert.ok(
    Math.abs(playheadAt(12, 3 + hold + CROSSFADE_SHARE / 2).mix - 0.5) < 1e-9,
  );
  assert.deepEqual(playheadAt(12, 11.2), { from: 11, to: 0, mix: 0 });
  assert.equal(dominantFrame(12, 3.99), 4);
  assert.equal(dominantFrame(12, -0.01), 0, 'negative playheads wrap');
});

test('blending never changes the overlay opacity, including across the year wrap', () => {
  for (const alpha of [0.4, 0.7, 1]) {
    for (let position = 0; position < 12; position += 0.05) {
      const alphas = blendAlphas(12, position, alpha);
      assert.ok(
        Math.abs(coverage(alphas) - alpha) < 1e-9,
        `coverage at ${position.toFixed(2)} with alpha ${alpha}`,
      );
      assert.ok(alphas.filter((a) => a > 0).length <= 2);
    }
  }
  assert.deepEqual(blendAlphas(1, 0.5, 0.7), [0.7]);
});

/** Animation frames that advance only when the test says so. */
function manualAnimation() {
  let callback = null;
  let now = 0;
  return {
    animation: {
      request(next) {
        callback = next;
        return 1;
      },
      cancel() {
        callback = null;
      },
    },
    advance(ms) {
      now += ms;
      const next = callback;
      callback = null;
      next?.(now);
    },
    get pending() {
      return Boolean(callback);
    },
  };
}

function fixture({ years = { 2019: YEAR, 2026: months(2026, 8) } } = {}) {
  const clock = manualAnimation();
  const state = createState();
  state.enabled = true;
  state.viewer = {};
  state.latest = '2026-08-01';
  const reads = [];
  const views = [];
  const loads = [];
  const parts = {
    filmstrip: {
      async load(dates) {
        loads.push(dates[0].slice(0, 4));
        state.filmstrip = { dates, layers: [] };
        return true;
      },
      clear() {
        state.filmstrip = null;
      },
      setPosition() {},
    },
    sampling: { refreshReadout: () => reads.push(state.date) },
    indicator: { render: (view) => views.push(view), hide() {} },
  };
  const source = {
    async resolveYear({ year }) {
      if (!years[year]) throw new Error(`No monthly means for ${year}`);
      return { year, dates: years[year] };
    },
  };
  const playback = createPlayback({
    state,
    services: { animation: clock.animation },
    parts,
    source,
  });
  return { playback, state, clock, reads, views, loads };
}

test('a year plays continuously from January and loops', async () => {
  const { playback, state, clock, reads } = fixture();
  assert.equal(await playback.selectYear(2019), true);
  assert.equal(state.date, '2019-01-01');
  clock.advance(0);
  clock.advance(MONTH_DURATION_MS * 2.5);
  assert.ok(Math.abs(state.playback.position - 2.5) < 1e-9);
  clock.advance(MONTH_DURATION_MS * 10);
  assert.ok(state.playback.position < 1, 'the playhead wraps to January');
  assert.ok(reads.includes('2019-03-01'), 'a pinned reading follows the month');
});

test('choosing another year keeps the month on screen and the play state', async () => {
  const { playback, state, clock, loads } = fixture();
  await playback.selectYear(2026);
  clock.advance(0);
  playback.seekMonth(6);
  clock.advance(SEEK_DURATION_MS * 2);
  assert.equal(state.date, '2026-07-01');
  await playback.selectYear(2019);
  assert.deepEqual(loads, ['2026', '2019']);
  assert.equal(state.date, '2019-07-01');
  assert.equal(playback.view().playing, false, 'a paused year stays paused');
  assert.equal(playback.view().year, 2019);
});

test('clicking a month glides to it, the short way round, and pauses', async () => {
  const { playback, state, clock } = fixture();
  await playback.selectYear(2019);
  clock.advance(0);
  playback.seekMonth(11);
  assert.equal(playback.view().playing, false);
  clock.advance(SEEK_DURATION_MS / 2);
  // From January, December is one month back, not eleven forward.
  const midway = state.playback.position;
  assert.ok(
    midway > 11 && midway < 12,
    `glides via the year wrap, at ${midway}`,
  );
  clock.advance(SEEK_DURATION_MS);
  assert.equal(state.date, '2019-12-01');
  assert.equal(clock.pending, false, 'a paused playhead stops animating');
  // From a pause the first frame only timestamps the glide.
  playback.seekMonth(8);
  clock.advance(0);
  clock.advance(SEEK_DURATION_MS * 2);
  assert.equal(state.date, '2019-09-01');
});

test('an unpublished month cannot be sought', async () => {
  const { playback, state, clock } = fixture();
  await playback.selectYear(2026);
  clock.advance(0);
  playback.seekMonth(10);
  assert.equal(playback.view().playing, true, 'November 2026 is not published');
  assert.equal(state.date, '2026-01-01');
});

test('the panel lists every year of the record and reports a failed year', async () => {
  const { playback, views } = fixture();
  await playback.selectYear(2019);
  const view = playback.view();
  assert.equal(view.years[0], 2000);
  assert.equal(view.years.at(-1), 2026);
  assert.ok(views.some((entry) => entry.loadingYear === 2019));
  await assert.rejects(playback.selectYear(2010));
  assert.match(playback.view().error, /2010/);
  assert.equal(playback.view().year, 2019, 'the shown year stays on screen');
});

test('a year with one published month is a still, not a loop', async () => {
  const { playback, clock } = fixture({ years: { 2026: ['2026-01-01'] } });
  await playback.selectYear(2026);
  assert.equal(playback.view().playing, false);
  assert.equal(clock.pending, false);
});

test('the month playhead moves continuously across the scale', () => {
  assert.equal(monthPlayhead(YEAR, 0), 0);
  assert.equal(monthPlayhead(YEAR, 6.25), 6.25);
  // A gap in the year is crossed in one frame interval.
  const gapped = ['2019-01-01', '2019-04-01'];
  assert.equal(monthPlayhead(gapped, 0.5), 1.5);
});

test('a measured reading reaches the panel scale, and a gap does not', async () => {
  const { playback, state, views } = fixture();
  await playback.selectYear(2019);
  state.sample = {
    outcome: 'measured',
    stop: { r: 255, g: 205, b: 0, lowK: 309.8, highK: 310.4 },
  };
  playback.refreshPanel();
  assert.equal(views.at(-1).reading.color, 'rgb(255,205,0)');
  state.sample = { outcome: 'no-value' };
  playback.refreshPanel();
  assert.equal(views.at(-1).reading, null);
  playback.release();
  const drawn = views.length;
  playback.refreshPanel();
  assert.equal(views.length, drawn, 'a switched-off layer draws no panel');
});
