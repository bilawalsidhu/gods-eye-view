import test from 'node:test';
import assert from 'node:assert/strict';
import { syncSegmentedGroup, syncSliderBlock } from './rowFilterControls.js';
import { railFixture } from './railTestFixture.mjs';

const sliderDescriptor = (overrides = {}) => ({
  id: 'min-frp',
  label: 'MIN FRP',
  ariaLabel: 'Minimum fire radiative power',
  valueText: 'All',
  min: 0,
  max: 1000,
  step: 1,
  value: 0,
  track: 'linear-gradient(90deg, #4a5bd4 0% 23%, #d1382a 82% 100%)',
  ticks: [
    { at: 0, label: '0' },
    { at: 0.233, label: '5' },
    { at: 0.826, label: '300' },
  ],
  params: (value) => ({ minFrp: Number(value) }),
  ...overrides,
});

const segmentedDescriptor = (active = 'all') => ({
  id: 'confidence',
  label: 'Confidence',
  ariaLabel: 'Detection confidence',
  options: ['all', 'nominal', 'high'].map((mode) => ({
    id: `confidence-${mode}`,
    label: mode.toUpperCase(),
    title: `${mode} title`,
    active: mode === active,
    params: { confidence: mode },
  })),
});

test('the slider block renders label, value, painted track and ticks, and is reconciled in place', () => {
  const f = railFixture();
  const container = f.document.createElement('div');
  const block = syncSliderBlock(container, sliderDescriptor());
  assert.equal(block.className, 'data-toggle-slider');
  assert.equal(block.dataset.sliderId, 'min-frp');
  const input = block.querySelector('.data-toggle-slider-input');
  assert.equal(input.type, 'range');
  assert.equal(input.max, '1000');
  assert.equal(input.value, '0');
  assert.equal(
    input.getAttribute('aria-label'),
    'Minimum fire radiative power',
  );
  assert.equal(input.getAttribute('aria-valuetext'), 'All');
  assert.match(input.style['--slider-track'], /^linear-gradient/);
  assert.equal(
    block.querySelector('.data-toggle-slider-label').textContent,
    'MIN FRP',
  );
  assert.equal(
    block.querySelector('.data-toggle-slider-value').textContent,
    'All',
  );
  const ticks = block.querySelector('.data-toggle-slider-ticks');
  assert.deepEqual(
    ticks.children.map((node) => [node.textContent, node.style['--at']]),
    [
      ['0', '0.00%'],
      ['5', '23.30%'],
      ['300', '82.60%'],
    ],
  );

  const again = syncSliderBlock(
    container,
    sliderDescriptor({ value: 434, valueText: '20 MW' }),
  );
  assert.equal(again, block, 'same node — a refresh never drops the thumb');
  assert.equal(input.value, '434');
  assert.equal(
    block.querySelector('.data-toggle-slider-value').textContent,
    '20 MW',
  );
  assert.equal(container.children.length, 1);

  // A thumb under the pointer is never moved by a refresh.
  input.focus();
  syncSliderBlock(container, sliderDescriptor({ value: 0 }));
  assert.equal(input.value, '434');

  syncSliderBlock(container, null);
  assert.equal(container.children.length, 0);
});

test('the segmented group is a radiogroup whose active option reads checked, reconciled by id', () => {
  const f = railFixture();
  const container = f.document.createElement('div');
  const group = syncSegmentedGroup(container, segmentedDescriptor('all'));
  assert.equal(group.getAttribute('role'), 'radiogroup');
  assert.equal(group.getAttribute('aria-label'), 'Detection confidence');
  assert.ok(group.className.split(' ').includes('gev-segmented'));
  const caption = container.children[container.children.indexOf(group) - 1];
  assert.equal(caption.className, 'data-toggle-segmented-label');
  assert.equal(caption.textContent, 'Confidence');
  const buttons = group.children;
  assert.deepEqual(
    buttons.map((b) => [
      b.dataset.chipId,
      b.textContent,
      b.getAttribute('aria-checked'),
      b.getAttribute('tabindex'),
    ]),
    [
      ['confidence-all', 'ALL', 'true', '0'],
      ['confidence-nominal', 'NOMINAL', 'false', '-1'],
      ['confidence-high', 'HIGH', 'false', '-1'],
    ],
  );
  assert.equal(buttons[0].getAttribute('role'), 'radio');
  assert.equal(buttons[1].title, 'nominal title');

  syncSegmentedGroup(container, segmentedDescriptor('high'));
  assert.equal(group.children[0], buttons[0], 'buttons are reused');
  assert.equal(buttons[0].getAttribute('aria-checked'), 'false');
  assert.equal(buttons[2].getAttribute('aria-checked'), 'true');
  assert.ok(buttons[2].classList.contains('active'));
  assert.equal(container.children.length, 2, 'caption and group');

  syncSegmentedGroup(container, { ...segmentedDescriptor('high'), label: '' });
  assert.equal(
    container.querySelector('.data-toggle-segmented-label'),
    null,
    'an empty label removes the caption',
  );
  assert.equal(container.children.length, 1);

  syncSegmentedGroup(container, null);
  assert.equal(container.children.length, 0, 'null removes group and caption');
});

test('a layer row dispatches slider input and switch clicks as user params', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const f = railFixture();
  const previousDocument = globalThis.document;
  globalThis.document = f.document;
  const calls = [];
  let controls = {
    slider: sliderDescriptor(),
    segmented: segmentedDescriptor('all'),
    info: '12 of 40 shown',
  };
  const panel = new LayerPanel({
    getLayers: () => [
      {
        id: 'local-firms',
        name: 'Active Fires',
        icon: '▲',
        source: 'NASA FIRMS',
        enabled: true,
        showInTogglePanel: true,
        stats: {},
      },
    ],
    isEnabled: () => true,
    setEnabled: () => {},
    setLayerParams: (...args) => calls.push(args),
    hasRowControls: () => true,
    subscribeRowControls: () => {},
    getRowControls: () => controls,
  });
  try {
    panel.mount(f.container);
    const row = f.find((n) => n.dataset.layerId === 'local-firms');
    const container = row.querySelector('.data-toggle-controls');
    assert.equal(container.hidden, false);
    assert.equal(
      row.querySelector('.data-toggle-controls-info').textContent,
      '12 of 40 shown',
    );
    // Order: switch caption, switch, slider, info.
    assert.deepEqual(
      container.children.map((node) => node.className.split(' ')[0]),
      [
        'data-toggle-segmented-label',
        'gev-segmented',
        'data-toggle-slider',
        'data-toggle-controls-info',
      ],
    );

    const input = row.querySelector('.data-toggle-slider-input');
    input.value = '434';
    const inputEvent = new Event('input');
    Object.defineProperty(inputEvent, 'target', { value: input });
    container.dispatchEvent(inputEvent);
    assert.deepEqual(calls.at(-1), [
      'local-firms',
      { minFrp: 434 },
      { origin: 'user' },
    ]);

    const high = row
      .querySelector('.data-toggle-segmented')
      .children.find((b) => b.dataset.chipId === 'confidence-high');
    high.click();
    assert.deepEqual(calls.at(-1), [
      'local-firms',
      { confidence: 'high' },
      { origin: 'user' },
    ]);

    // A stale descriptor never applies: the live one decides.
    controls = { ...controls, segmented: segmentedDescriptor('high') };
    // The fixture DOM has no attribute selectors, so sync the row directly.
    panel._syncRowControls(container, { id: 'local-firms', enabled: true });
    assert.equal(high.getAttribute('aria-checked'), 'true');
    assert.equal(
      row.querySelector('.data-toggle-slider-input'),
      input,
      'the slider survives a refresh',
    );
  } finally {
    panel.destroy();
    globalThis.document = previousDocument;
  }
});
