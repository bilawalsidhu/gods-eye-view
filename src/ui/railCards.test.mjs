import test from 'node:test';
import assert from 'node:assert/strict';
import { createRailCards } from './railCards.js';
import { railFixture } from './railTestFixture.mjs';

const legend = {
  colors: ['#112233', '#ffffff', '#abcdef'],
  labels: ['-10', '0', '10'],
  units: '°C',
  zeroIndex: 1,
};
const card = {
  id: 'a',
  title: 'Temperature',
  badge: 'Global',
  open: true,
  blocks: [
    { id: 'details', type: 'lines', lines: [{ id: 'status', text: '' }] },
    { id: 'legend', type: 'legend', legend },
    {
      id: 'actions',
      type: 'actions',
      actions: [{ id: 'view', label: 'View coverage' }],
    },
  ],
};
test('keyed cards and optional blocks reorder without redundant writes', () => {
  let writes = 0;
  const f = railFixture(() => writes++);
  const view = createRailCards(f);
  view.update([card]);
  const article = f.container.children[0];
  assert.equal(article.tagName, 'ARTICLE');
  const header = article.children[0];
  assert.equal(header.tagName, 'BUTTON');
  assert.equal(header.getAttribute('aria-expanded'), 'true');
  assert.ok(header.getAttribute('aria-controls'));
  for (const cards of [
    [card],
    [
      {
        ...card,
        blocks: [
          { id: 'summary', type: 'summary', text: '<img onerror=alert(1)>' },
        ],
      },
    ],
    [card, { ...card, id: 'b', open: false }],
    [{ ...card, id: 'b' }, card],
    [],
  ]) {
    view.update(cards);
    writes = 0;
    view.update(cards);
    assert.equal(writes, 0);
  }
  view.update([{ ...card, blocks: [...card.blocks].reverse() }]);
  assert.deepEqual(
    f.container.children[0].children[1].children.map((n) => n.dataset.blockId),
    ['actions', 'legend', 'details'],
  );
  view.destroy();
  assert.equal(f.container.children.length, 0);
  assert.equal(createRailCards(), null);
});
test('footer buttons retain focus and current callbacks; links use safe new tabs', () => {
  const f = railFixture();
  const view = createRailCards(f);
  const calls = [];
  const model = (actions) => ({
    ...card,
    blocks: [{ id: 'actions', type: 'actions', actions }],
  });
  view.update([
    model([{ id: 'view', label: 'First', onClick: () => calls.push(1) }]),
  ]);
  const button = f.find((n) => n.dataset.actionId === 'view');
  button.focus();
  view.update([
    model([
      {
        id: 'view',
        label: 'Read wind here',
        hint: 'at map center',
        onClick: () => calls.push(2),
      },
      {
        id: 'link',
        label: 'Official advisory ↗',
        href: 'https://example.org/advisory',
      },
    ]),
  ]);
  assert.equal(f.document.activeElement, button);
  assert.equal(button.parent.tagName, 'FOOTER');
  assert.equal(
    f.find((n) => n.className === 'rail-card-action-hint').textContent,
    'at map center',
  );
  button.click();
  assert.deepEqual(calls, [2]);
  const link = f.find((n) => n.dataset.actionId === 'link');
  assert.equal(link.tagName, 'A');
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener');
  view.update([
    model([
      {
        id: 'view',
        label: 'Read wind here',
        disabled: true,
        onClick: () => calls.push(3),
      },
    ]),
  ]);
  button.click();
  assert.deepEqual(calls, [2]);
  view.destroy();
  button.click();
  assert.deepEqual(calls, [2]);
});
test('legend validates colors, preserves the freezing anchor and ignores CSSOM normalization', () => {
  let writes = 0;
  const f = railFixture(() => writes++);
  const view = createRailCards(f);
  const show = (legend) =>
    view.update([
      { ...card, blocks: [{ id: 'legend', type: 'legend', legend }] },
    ]);
  show(legend);
  const zero = f.find((n) => n.className === 'rail-card-zero');
  const ramp = f.find((n) => n.className === 'rail-card-ramp');
  assert.equal(zero.hidden, false);
  assert.equal(zero.style.left, '50%');
  Object.defineProperty(ramp.style, 'background', {
    get: () =>
      'linear-gradient(to right, rgb(17, 34, 51), rgb(255, 255, 255), rgb(171, 205, 239))',
    set() {
      writes++;
    },
    configurable: true,
  });
  Object.defineProperty(zero.style, 'left', {
    get: () => '50.0%',
    set() {
      writes++;
    },
    configurable: true,
  });
  writes = 0;
  show(legend);
  assert.equal(writes, 0);
  delete ramp.style.background;
  delete zero.style.left;
  show({
    ...legend,
    colors: Array(10).fill('#abcdef'),
    labels: Array.from({ length: 10 }, (_, i) => String(i * 10 - 40)),
    zeroIndex: 4,
  });
  assert.ok(Math.abs(parseFloat(zero.style.left) - 44.444444) < 0.001);
  show({ ...legend, units: 'km/h' });
  assert.equal(zero.hidden, true);
  show({ ...legend, colors: ['url(https://example.org)', '#ffffff'] });
  assert.equal(ramp.hidden, true);
  assert.equal(ramp.style.background, '');
  view.destroy();
});
test('labelled rows, lists and results retain focus and dispatch current params', () => {
  let writes = 0;
  const f = railFixture(() => writes++);
  const calls = [];
  const view = createRailCards({
    ...f,
    onParams: (...args) => calls.push(args),
  });
  const model = (paused = false) => ({
    ...card,
    blocks: [
      {
        id: 'storms',
        type: 'list',
        list: {
          ariaLabel: 'Storms',
          items: [
            {
              id: 'a',
              text: 'Storm A',
              active: !paused,
              params: { stormId: 'a', focus: true },
            },
            {
              id: 'b',
              text: 'Storm B',
              active: paused,
              params: { stormId: 'b', focus: true },
            },
          ],
        },
      },
      {
        id: 'settings',
        type: 'settings',
        settings: [
          {
            id: 'motion',
            label: 'MOTION',
            chips: [
              {
                id: 'motion',
                label: paused ? 'Resume' : 'Pause',
                params: { paused: !paused },
              },
            ],
          },
        ],
      },
      {
        id: 'reading',
        type: 'result',
        label: 'WIND AT SAMPLED LOCATION · 41°N 87°W',
        lines: [{ id: 'wind', text: '<b>18 km/h</b>' }],
        clear: { params: { inspect: false } },
      },
    ],
  });
  view.update([model()]);
  const setting = f.find((n) => n.dataset.blockId === 'motion');
  assert.equal(setting.children[0].textContent, 'MOTION');
  assert.equal(setting.children[1].getAttribute('role'), 'group');
  assert.equal(setting.children[1].getAttribute('aria-label'), 'MOTION');
  const chip = f.find((n) => n.dataset.chipId === 'motion');
  chip.focus();
  view.update([model(true)]);
  assert.equal(f.document.activeElement, chip);
  chip.click();
  assert.deepEqual(calls.at(-1), ['a', { paused: false }]);
  const storm = f.find(
    (n) => n.tagName === 'BUTTON' && n.dataset.listItemId === 'b',
  );
  assert.equal(storm.getAttribute('aria-pressed'), 'true');
  storm.click();
  assert.deepEqual(calls.at(-1), ['a', { stormId: 'b', focus: true }]);
  const clear = f.find((n) => n.dataset.actionId === 'clear');
  assert.equal(clear.textContent, '×');
  assert.equal(clear.getAttribute('aria-label'), 'Clear reading');
  clear.click();
  assert.deepEqual(calls.at(-1), ['a', { inspect: false }]);
  assert.equal(f.find((n) => n.dataset.lineId === 'wind').children.length, 0);
  writes = 0;
  view.update([model(true)]);
  assert.equal(writes, 0);
  view.destroy();
  const before = calls.length;
  chip.click();
  clear.click();
  storm.click();
  assert.equal(calls.length, before);
});
