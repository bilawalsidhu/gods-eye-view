// src/cockpitProgress.test.mjs — a subject's progress line laid out at a
// width: close bare ticks merge, labelled ticks keep their place, labels never
// overlap (the lower priority gives way) and the part before the marker is
// the travelled part.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cockpitProgressLayout,
  estimateProgressLabelPx,
} from './cockpitProgress.js';

const tick = (at, label = null, tone = 'normal') => ({ at, tone, label });
const label = (text, priority, align = 'center', detail = '') => ({
  text,
  detail,
  priority,
  align,
});
/** Every label is 50 px wide. */
const measure = () => 50;

test('nothing is drawn without two ticks or a width', () => {
  assert.equal(cockpitProgressLayout(null, 500), null);
  assert.equal(cockpitProgressLayout({ ticks: [tick(0)] }, 500), null);
  assert.equal(
    cockpitProgressLayout({ ticks: [tick(0), tick(1)], marker: null }, 0),
    null,
  );
});

test('ticks closer than the minimum spacing merge, keeping the strongest tone', () => {
  const layout = cockpitProgressLayout(
    {
      ticks: [
        tick(0, label('A', 1, 'start')),
        tick(0.1),
        tick(0.101, null, 'warning'),
        tick(0.102),
        tick(0.5),
        tick(1, label('Z', 1, 'end')),
      ],
      marker: { at: 0.3, dwell: false },
      tag: 'TIMETABLE',
    },
    1000,
    { measure },
  );
  assert.deepEqual(
    layout.ticks.map(({ x, count, tone, labelled }) => [
      Math.round(x),
      count,
      tone,
      labelled,
    ]),
    [
      [0, 1, 'normal', true],
      [101, 3, 'warning', false],
      [500, 1, 'normal', false],
      [1000, 1, 'normal', true],
    ],
  );
  assert.deepEqual(layout.marker, { x: 300, dwell: false });
  assert.equal(layout.travelledX, 300);
  assert.equal(layout.tag, 'TIMETABLE');
});

test('a labelled tick keeps its place and takes in the bare ticks beside it', () => {
  const layout = cockpitProgressLayout(
    {
      ticks: [
        tick(0, label('A', 1, 'start')),
        tick(0.498),
        tick(0.5, label('Next', 3), 'alert'),
        tick(0.503, null, 'warning'),
        tick(1, label('Z', 1, 'end')),
      ],
      marker: null,
    },
    1000,
    { measure },
  );
  const next = layout.ticks.find(({ x }) => Math.round(x) === 500);
  assert.equal(next.count, 3);
  assert.equal(next.labelled, true);
  assert.equal(next.tone, 'alert');
  assert.equal(layout.ticks.length, 3);
  assert.equal(layout.marker, null);
  assert.equal(layout.travelledX, 0);
});

test('labels hang from their ticks inside the line, and overlaps give way by priority', () => {
  const layout = cockpitProgressLayout(
    {
      ticks: [
        tick(0, label('First', 1, 'start')),
        tick(0.04, label('Previous', 2)),
        tick(0.5, label('Next', 3)),
        tick(0.52, label('Close', 0)),
        tick(1, label('Last', 1, 'end')),
      ],
      marker: { at: 0.2, dwell: true },
    },
    1000,
    { measure },
  );
  assert.deepEqual(
    layout.labels.map(({ text, left }) => [text, Math.round(left)]),
    [
      ['Previous', 15],
      ['Next', 475],
      ['Last', 950],
    ],
  );
  // The first stop's label would cover the previous stop's: it gives way.
  assert.ok(!layout.labels.some(({ text }) => text === 'First'));
  assert.ok(!layout.labels.some(({ text }) => text === 'Close'));
  assert.deepEqual(layout.marker, { x: 200, dwell: true });
});

test('a centred label at an edge is clamped inside the line', () => {
  const layout = cockpitProgressLayout(
    { ticks: [tick(0, label('Edge', 1)), tick(1)], marker: null },
    300,
    { measure },
  );
  assert.equal(layout.labels[0].left, 0);
  const right = cockpitProgressLayout(
    { ticks: [tick(0), tick(1, label('Edge', 1))], marker: null },
    300,
    { measure },
  );
  assert.equal(right.labels[0].left, 250);
});

test('a long run of calls still lays out, every one a tick or part of one', () => {
  const ticks = Array.from({ length: 60 }, (_, i) => tick(i / 59));
  ticks[0].label = label('First', 1, 'start');
  ticks[59].label = label('Last', 1, 'end');
  const narrow = cockpitProgressLayout({ ticks, marker: null }, 200);
  const wide = cockpitProgressLayout({ ticks, marker: null }, 2000);
  const count = (layout) =>
    layout.ticks.reduce((sum, entry) => sum + entry.count, 0);
  assert.equal(count(narrow), 60);
  assert.equal(count(wide), 60);
  assert.ok(narrow.ticks.length < wide.ticks.length);
  assert.equal(wide.ticks.length, 60);
});

test('a CJK stop name gets the width its full-width glyphs need', () => {
  const text = '中央駅前広場東口'; // 8 full-width glyphs
  // 10 px type, 0.06 em apart.
  const needPx = text.length * (10 + 0.6);
  const givenPx = estimateProgressLabelPx({ text, detail: '' });
  assert.ok(
    givenPx >= needPx,
    `${givenPx} px given, about ${needPx} px needed`,
  );
  // As many Latin letters are narrower; half-width katakana are as narrow.
  assert.ok(givenPx > estimateProgressLabelPx({ text: 'CENTRALS' }));
  assert.equal(
    estimateProgressLabelPx({ text: 'ｶﾀｶﾅ' }),
    estimateProgressLabelPx({ text: 'KANA' }),
  );
});

test('astral glyphs (emoji outside the BMP, supplementary kana) in a progress label get at least 1 em each', () => {
  // About 1 em in 10 px type, 0.06 em apart.
  const emPx = 10 + 0.6;
  for (const [text, needPx] of [
    ['🚉🚆🚇🚋', 4 * emPx],
    ['🚆'.repeat(8), 8 * emPx],
    // Supplementary kana, outside the full-width ranges.
    ['𛀁𛀂', 2 * emPx],
    // Mixed: four emoji, a space and two full-width glyphs.
    ['🚆🚇🚌🚕 乗換', 4 * emPx + 6.4 + 2 * emPx],
  ]) {
    const givenPx = estimateProgressLabelPx({ text, detail: '' });
    assert.ok(
      givenPx >= needPx + 8,
      `${text}: ${givenPx} px given, about ${needPx} px needed`,
    );
  }
});

test('a label is as wide as its wider line, its smaller detail line included', () => {
  assert.ok(
    estimateProgressLabelPx({ text: 'GATE', detail: '中央駅前' }) >
      estimateProgressLabelPx({ text: 'GATE', detail: '' }),
    'the wider detail line widens the label',
  );
  // As headless Chrome draws the detail's <small> (8.333 px JetBrains Mono,
  // 0.6 px apart): 'WWWWMMMMWWWW' at 67.2 px, '中央駅前広場東口' at 72.9 px.
  for (const [detail, needPx] of [
    ['W'.repeat(64), 64 * (67.2 / 12)],
    ['駅'.repeat(45), 45 * (72.9 / 8)],
  ]) {
    const givenPx = estimateProgressLabelPx({ text: 'A', detail });
    assert.ok(
      givenPx >= needPx,
      `${detail.length} × ${detail[0]}: ${givenPx} px given, ${needPx} px needed`,
    );
  }
});
