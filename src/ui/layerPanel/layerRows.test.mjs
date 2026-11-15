// src/ui/layerPanel/layerRows.test.mjs — a layer row's own classes change
// without wiping classes other code adds, such as the voice highlight.
import '../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { h, render } from 'vue';
import LayerRows from './LayerRows.vue';

const row = (countLine) => ({
  key: 'flights',
  id: 'flights',
  englishName: 'Flights',
  icon: 'flight',
  name: 'Flights',
  meta: '',
  toggle: {
    classes: [],
    text: 'OFF',
    ariaLabel: 'Flights',
    title: '',
    ariaBusy: 'false',
    ariaDisabled: 'false',
    feedState: '',
  },
  count: { countLine, text: '12', empty: false },
  controls: null,
});

test('the count-line class toggles without dropping the voice highlight', () => {
  document.body.replaceChildren();
  const container = document.body.appendChild(document.createElement('div'));
  render(h(LayerRows, { items: [row(false)] }), container);
  const element = container.querySelector('[data-layer-id="flights"]');
  assert.equal(element.className, 'data-toggle-row');
  element.classList.add('gev-voice-focus');

  render(h(LayerRows, { items: [row(true)] }), container);
  assert.equal(element.classList.contains('data-toggle-row--count-line'), true);
  assert.equal(element.classList.contains('gev-voice-focus'), true);

  render(h(LayerRows, { items: [row(false)] }), container);
  assert.equal(
    element.classList.contains('data-toggle-row--count-line'),
    false,
  );
  assert.equal(element.classList.contains('gev-voice-focus'), true);
  assert.equal(element.classList.contains('data-toggle-row'), true);
  render(null, container);
});

const fireRow = (value, active = 'all') => ({
  ...row(false),
  key: 'fires',
  id: 'fires',
  controls: {
    hidden: false,
    chips: [],
    segmented: {
      id: 'confidence',
      label: 'Confidence',
      ariaLabel: 'Detection confidence',
      options: ['all', 'high'].map((mode) => ({
        id: `confidence-${mode}`,
        label: mode.toUpperCase(),
        title: `${mode} title`,
        active: mode === active,
      })),
    },
    slider: {
      id: 'min-frp',
      label: 'Fire intensity (FRP)',
      ariaLabel: 'Minimum fire radiative power, megawatts',
      valueText: value ? `≥ ${value} MW` : 'All',
      min: 0,
      max: 1000,
      step: 1,
      value,
      track: 'linear-gradient(90deg, #9e2a1b, #fff3b0)',
      ticks: [
        { at: 0, label: '0' },
        { at: 0.5, label: '30' },
      ],
    },
    legend: [],
    info: null,
    list: null,
  },
});

test('a row switch and slider render their markup and report choices', () => {
  document.body.replaceChildren();
  const container = document.body.appendChild(document.createElement('div'));
  const chips = [];
  const moves = [];
  const props = {
    onChip: (id, chipId) => chips.push([id, chipId]),
    onSlider: (id, sliderId, value) => moves.push([id, sliderId, value]),
  };
  render(h(LayerRows, { items: [fireRow(0)], ...props }), container);

  const caption = container.querySelector('.data-toggle-segmented-label');
  assert.equal(caption.textContent, 'Confidence');
  const group = container.querySelector('.gev-segmented.data-toggle-segmented');
  assert.equal(group.getAttribute('role'), 'radiogroup');
  assert.equal(group.getAttribute('aria-label'), 'Detection confidence');
  const segments = [
    ...group.querySelectorAll('.gev-segment.data-toggle-segment'),
  ];
  assert.deepEqual(
    segments.map((button) => button.dataset.chipId),
    ['confidence-all', 'confidence-high'],
  );
  assert.equal(segments[0].classList.contains('active'), true);
  assert.equal(segments[1].title, 'high title');
  segments[1].click();
  assert.deepEqual(chips, [['fires', 'confidence-high']]);

  const block = container.querySelector('.data-toggle-slider');
  assert.equal(block.dataset.sliderId, 'min-frp');
  assert.equal(
    block.querySelector('.data-toggle-slider-label').textContent,
    'Fire intensity (FRP)',
  );
  assert.equal(
    block.querySelector('.data-toggle-slider-value').textContent,
    'All',
  );
  const input = block.querySelector('input.data-toggle-slider-input');
  assert.equal(input.classList.contains('gev-quantitative-slider'), true);
  assert.equal(input.type, 'range');
  assert.equal(input.max, '1000');
  assert.equal(
    input.getAttribute('aria-label'),
    'Minimum fire radiative power, megawatts',
  );
  assert.equal(input.getAttribute('aria-valuetext'), 'All');
  assert.match(
    input.style.getPropertyValue('--slider-track'),
    /^linear-gradient/,
  );
  const ticks = [...block.querySelectorAll('.data-toggle-slider-tick')];
  assert.deepEqual(
    ticks.map((tick) => tick.textContent),
    ['0', '30'],
  );
  assert.equal(ticks[1].style.getPropertyValue('--at'), '50.00%');

  input.value = '120';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  assert.deepEqual(moves, [['fires', 'min-frp', 120]]);

  // The refresh that tick triggers keeps the same nodes and updates the text.
  render(h(LayerRows, { items: [fireRow(120, 'high')], ...props }), container);
  assert.equal(
    container.querySelector('input.data-toggle-slider-input'),
    input,
  );
  assert.equal(input.getAttribute('aria-valuetext'), '≥ 120 MW');
  assert.equal(segments[1].classList.contains('active'), true);
  render(null, container);
});

test('a row range renders start and end pickers and reports which end moved', () => {
  document.body.replaceChildren();
  const container = document.body.appendChild(document.createElement('div'));
  const picks = [];
  const item = {
    ...row(false),
    key: 'shipwrecks',
    id: 'shipwrecks',
    controls: {
      hidden: false,
      chips: [],
      segmented: null,
      slider: null,
      range: {
        id: 'period',
        label: 'Period',
        valueText: '2010–2024',
        from: { label: 'From', ariaLabel: 'First year', value: 2010 },
        to: { label: 'To', ariaLabel: 'Last year', value: 2024 },
        options: [2024, 2010, 2007].map((year) => ({
          value: year,
          label: String(year),
        })),
      },
      legend: [],
      info: null,
      list: null,
    },
  };
  render(
    h(LayerRows, {
      items: [item],
      onRange: (id, rangeId, end, value) =>
        picks.push([id, rangeId, end, value]),
    }),
    container,
  );
  const block = container.querySelector('.data-toggle-range');
  assert.equal(block.dataset.rangeId, 'period');
  assert.equal(
    block.querySelector('.data-toggle-slider-value').textContent,
    '2010–2024',
  );
  const [from, to] = block.querySelectorAll('select.data-toggle-range-select');
  assert.equal(from.getAttribute('aria-label'), 'First year');
  assert.equal(from.value, '2010');
  assert.equal(to.value, '2024');
  assert.deepEqual(
    [...block.querySelectorAll('.data-toggle-range-caption')].map(
      (caption) => caption.textContent,
    ),
    ['From', 'To'],
  );
  to.value = '2007';
  to.dispatchEvent(new Event('change', { bubbles: true }));
  assert.deepEqual(picks, [['shipwrecks', 'period', 'to', '2007']]);
  render(null, container);
});

const libraryRow = (chips) => ({
  ...row(false),
  key: 'lib-night-lights',
  id: 'lib-night-lights',
  libraryEntry: 'nasa-black-marble',
  controls: { hidden: false, chips, legend: [], list: null },
});

test('a Data Library row names its entry and draws icon action chips', () => {
  document.body.replaceChildren();
  const container = document.body.appendChild(document.createElement('div'));
  const zoom = {
    id: 'zoom',
    icon: 'zoom_in_map',
    action: true,
    label: 'Zoom to layer',
  };
  render(h(LayerRows, { items: [libraryRow([zoom])] }), container);
  const element = container.querySelector('[data-layer-id="lib-night-lights"]');
  assert.equal(element.dataset.libraryEntry, 'nasa-black-marble');
  const button = element.querySelector('[data-chip-id="zoom"]');
  const glyph = button.children[0];
  assert.equal(glyph.className, 'material-symbols-outlined');
  assert.equal(glyph.textContent, 'zoom_in_map');
  assert.equal(glyph.getAttribute('aria-hidden'), 'true');
  assert.equal(button.getAttribute('aria-label'), 'Zoom to layer');
  assert.equal(button.title, 'Zoom to layer');
  assert.equal(button.getAttribute('aria-pressed'), null);
  assert.ok(button.classList.contains('chip-icon'));

  // The same id as a text toggle drops the icon semantics.
  render(
    h(LayerRows, {
      items: [libraryRow([{ id: 'zoom', label: 'ZOOM', active: true }])],
    }),
    container,
  );
  const toggle = element.querySelector('[data-chip-id="zoom"]');
  assert.equal(toggle.textContent, 'ZOOM');
  assert.equal(toggle.getAttribute('aria-label'), null);
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(toggle.classList.contains('chip-icon'), false);
  render(null, container);
});

test('a core row carries no library entry attribute', () => {
  document.body.replaceChildren();
  const container = document.body.appendChild(document.createElement('div'));
  render(h(LayerRows, { items: [row(false)] }), container);
  const element = container.querySelector('[data-layer-id="flights"]');
  assert.equal(element.hasAttribute('data-library-entry'), false);
  render(null, container);
});
