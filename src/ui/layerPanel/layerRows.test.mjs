// src/ui/layerPanel/layerRows.test.mjs — a layer row's own classes change
// without wiping classes other code adds, such as the voice highlight.
import '../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { h, render, nextTick } from 'vue';
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

test('layer switches expose their live checked state and preserve the toggle action', async () => {
  document.documentElement.dataset.uiTheme = 'minimal';
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const calls = [];
  const value = row(false);
  value.toggle.classes = { active: true };
  value.toggle.feedState = 'loading';
  value.toggle.text = 'LOADING';
  render(
    h(LayerRows, { items: [value], onToggle: (id) => calls.push(id) }),
    host,
  );
  await nextTick();
  const toggle = host.querySelector('[role="switch"]');
  assert.equal(toggle.getAttribute('aria-checked'), 'true');
  assert.ok(toggle.querySelector('[data-slot="switch-thumb"]'));
  toggle.click();
  assert.deepEqual(calls, ['flights']);
  value.toggle.classes = { active: false };
  render(
    h(LayerRows, { items: [{ ...value }], onToggle: (id) => calls.push(id) }),
    host,
  );
  assert.equal(toggle.getAttribute('aria-checked'), 'false');
  render(null, host);
  delete document.documentElement.dataset.uiTheme;
});

test('Minimal sections collapse without changing layer state and remain collapsed through live refreshes', async (t) => {
  document.body.replaceChildren();
  document.documentElement.dataset.uiTheme = 'minimal';
  const host = document.body.appendChild(document.createElement('div'));
  const calls = [];
  const items = [
    { key: 'group:Movement', heading: 'Movement' },
    row(false),
    { key: 'group:Cameras', heading: 'Cameras' },
    { ...row(false), key: 'cctv', id: 'cctv', name: 'Cameras' },
  ];
  const props = { items, onToggle: (id) => calls.push(id) };
  t.after(() => {
    render(null, host);
    delete document.documentElement.dataset.uiTheme;
  });
  render(h(LayerRows, props), host);
  await nextTick();
  await nextTick();
  const trigger = host.querySelector('.console-section-trigger');
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  trigger.click();
  await nextTick();
  await nextTick();
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.deepEqual(calls, []);
  assert.equal(host.querySelector('[data-layer-id="cctv"]').hidden, false);
  render(h(LayerRows, { ...props, items: [...items] }), host);
  await nextTick();
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  trigger.click();
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  host.querySelector('[data-layer-id="flights"] [role="switch"]').click();
  assert.deepEqual(calls, ['flights']);
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
