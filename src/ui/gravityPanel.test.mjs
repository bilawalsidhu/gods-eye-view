import test from 'node:test';
import assert from 'node:assert/strict';
import { createGravityPanel, gravityChartGeometry } from './gravityPanel.js';
import { railFixture } from './railTestFixture.mjs';

const solutions = [
  { id: '2017-04-01', start: '2017-04-01', end: '2017-05-01' },
  { id: '2017-05-01', start: '2017-05-01', end: '2017-06-01' },
  { id: '2018-06-01', start: '2018-06-01', end: '2018-07-01' },
  { id: '2018-07-01', start: '2018-07-01', end: '2018-08-01' },
];

function card(overrides = {}) {
  return {
    enabled: true,
    solutions,
    shownIndex: 3,
    latest: true,
    playing: false,
    area: 'land',
    opacity: 'strong',
    probe: null,
    status: null,
    ...overrides,
  };
}

function mount() {
  const f = railFixture();
  f.document.createElementNS = (_ns, tag) => f.document.createElement(tag);
  const panel = f.document.createElement('div');
  panel.hidden = true;
  panel.dataset.collapsedPreference = 'user';
  panel.classList.contains = () => false;
  panel.querySelector = () => null;
  panel.appendChild(f.container);
  f.container.closest = (selector) =>
    selector === '#gravity-panel' ? panel : null;
  const calls = [];
  const view = createGravityPanel({
    container: f.container,
    setLayerParams: (id, params) => calls.push([id, params]),
  });
  const byText = (text) => f.find((node) => node.textContent === text);
  return { f, panel, view, calls, byText };
}

test('the chart breaks at the mission gap and marks the shown solution', () => {
  const geometry = gravityChartGeometry(solutions, [5, 3, -10, -12], 2);
  assert.equal(geometry.lines.length, 2, 'no line across 2017-2018');
  assert.equal(geometry.low, -12);
  assert.equal(geometry.high, 5);
  assert.ok(geometry.marker);
  assert.equal(geometry.indexAt(4), 0);
  assert.equal(geometry.indexAt(296), 3);
  const holes = gravityChartGeometry(solutions, [5, null, -10, -12], 0);
  assert.equal(holes.lines.length, 1, 'a lone point draws no line');
  assert.equal(
    gravityChartGeometry(solutions, [null, null, null, null], 0),
    null,
  );
});

test('the card follows the layer: hidden while off, transport and display chips send params', () => {
  const { panel, view, calls, byText } = mount();
  view.update(null);
  assert.equal(panel.hidden, true);
  view.update(card());
  assert.equal(panel.hidden, false);
  assert.ok(byText('2018-07-01 – 2018-08-01'));
  assert.equal(byText('›').disabled, true, 'nothing newer than the latest');
  byText('‹').click();
  byText('Play').click();
  byText('Land + ocean').click();
  byText('Soft').click();
  assert.deepEqual(calls, [
    ['gravity', { step: -1 }],
    ['gravity', { playing: true }],
    ['gravity', { area: 'all' }],
    ['gravity', { opacity: 'light' }],
  ]);
  view.update(card({ playing: true }));
  assert.ok(byText('Pause'));
});

test('a probed point shows its value and history, and Clear removes it', () => {
  const { view, calls, byText, f } = mount();
  view.update(card());
  assert.ok(byText('Click the map to chart a point'));
  view.update(
    card({
      probe: {
        lat: 28.5,
        lon: 77.5,
        cm: -34.5,
        land: true,
        history: [5, 3, -10, -34.5],
      },
    }),
  );
  assert.ok(byText('28.5°N 77.5°E · −34.5 cm'));
  // SVG nodes carry their class as an attribute.
  const group = f.find(
    (node) => node.getAttribute?.('class') === 'gravity-chart-series',
  );
  assert.equal(group.children.length, 2);
  byText('Clear').click();
  assert.deepEqual(calls.at(-1), ['gravity', { clearProbe: true }]);
});
