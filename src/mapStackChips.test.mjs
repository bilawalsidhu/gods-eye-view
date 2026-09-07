import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESENTED_MAP_STACK_IDS,
  mapStackChipModels,
  renderMapStackChips,
  syncMapStackChips,
} from './mapStackChips.js';

function element(tagName = 'div') {
  const el = {
    tagName,
    dataset: {},
    attributes: {},
    children: [],
    className: '',
    classList: {
      toggle(name, enabled) {
        const names = new Set(el.className.split(/\s+/).filter(Boolean));
        if (enabled) names.add(name); else names.delete(name);
        el.className = [...names].join(' ');
      },
      contains(name) { return el.className.split(/\s+/).includes(name); },
    },
    appendChild(child) { el.children.push(child); },
    setAttribute(name, value) { el.attributes[name] = String(value); },
    getAttribute(name) { return el.attributes[name]; },
    addEventListener(name, handler) { el[name] = handler; },
    click() { el.click?.(); },
  };
  Object.defineProperty(el, 'innerHTML', { set() { el.children = []; } });
  return el;
}

const doc = { createElement: (tag) => element(tag) };
const stacks = [
  { id: 'azure-satellite', label: 'Azure Satellite', available: true },
  { id: 'azure-hybrid', label: 'Azure Hybrid', available: true },
  { id: 'azure-streets', label: 'Azure Streets', available: true },
  { id: 'osm', label: 'OpenStreetMap', available: true },
];

test('map source tray exposes only Azure raster stacks and OSM', () => {
  assert.deepEqual(PRESENTED_MAP_STACK_IDS, [
    'azure-satellite', 'azure-hybrid', 'azure-streets', 'osm',
  ]);
  assert.deepEqual(mapStackChipModels(stacks, 'azure-satellite').map(({ id }) => id), PRESENTED_MAP_STACK_IDS);
});

test('chips dispatch selection and synchronize active state', () => {
  const container = element();
  const selected = [];
  renderMapStackChips(container, stacks, {
    activeId: 'azure-satellite',
    onSelect: (id) => selected.push(id),
    doc,
  });
  container.children[1].click();
  assert.deepEqual(selected, ['azure-hybrid']);
  syncMapStackChips(container, 'azure-hybrid');
  assert.equal(container.children[1].getAttribute('aria-pressed'), 'true');
  assert.equal(container.children[0].getAttribute('aria-pressed'), 'false');
});

test('unavailable providers remain honest and inert', () => {
  const container = element();
  renderMapStackChips(container, [{ ...stacks[0], available: false, unavailableReason: 'BFF unavailable' }], {
    activeId: 'osm',
    onSelect: () => assert.fail('unavailable source selected'),
    doc,
  });
  assert.equal(container.children[0].getAttribute('aria-disabled'), 'true');
  assert.equal(container.children[0].title, 'BFF unavailable');
});
