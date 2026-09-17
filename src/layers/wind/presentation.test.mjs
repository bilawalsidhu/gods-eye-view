import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindPresentation } from './presentation.js';

function fixture() {
  class Element extends EventTarget {
    constructor(tag, ownerDocument) {
      super();
      this.tagName = tag;
      this.ownerDocument = ownerDocument;
      this.children = [];
      this.attributes = new Map();
      this.textContent = '';
      this.hidden = false;
    }
    get isConnected() {
      return this.tagName === 'root' || Boolean(this.parent?.isConnected);
    }
    contains(element) {
      return (
        this === element ||
        this.children.some((child) => child.contains(element))
      );
    }
    focus(options) {
      this.ownerDocument.activeElement = this;
      this.focusOptions = options;
    }
    setAttribute(name, value) {
      this.attributes.set(name, value);
    }
    appendChild(child) {
      child.parent = this;
      this.children.push(child);
      return child;
    }
    remove() {
      if (this.parent) {
        this.parent.children = this.parent.children.filter(
          (child) => child !== this,
        );
        this.parent = null;
      }
    }
  }
  const document = { createElement: (tag) => new Element(tag, document) };
  const container = document.createElement('root');
  const find = (className, root = container) => {
    if (root.className === className) return root;
    for (const child of root.children) {
      const match = find(className, child);
      if (match) return match;
    }
    return null;
  };
  return { container, find };
}

const reading = {
  coordinates: '41.9° N, 87.6° W',
  wind: '18 km/h · W',
  scalarLabel: 'Temperature',
  scalarValue: '12 °C',
  model: 'GFS · surface wind',
  validTime: '2026-09-15 12:00 UTC',
  status: 'Cached · stale',
  explanation: 'Nearest model grid cell; not a station observation.',
};

test('reading is hidden until requested and renders supplied values as text', () => {
  const f = fixture();
  const view = createWindPresentation({ container: f.container });
  const card = f.find('gev-wind-reading');
  assert.equal(card.hidden, true);
  view.show({ ...reading, explanation: '<img src=x onerror=alert(1)>' });
  assert.equal(card.hidden, false);
  assert.equal(f.find('gev-wind-reading__wind').textContent, reading.wind);
  assert.equal(
    f.find('gev-wind-reading__coordinates').textContent,
    reading.coordinates,
  );
  assert.equal(
    f.find('gev-wind-reading__valid-time').textContent,
    `Valid ${reading.validTime}`,
  );
  assert.equal(f.find('gev-wind-reading__status').textContent, reading.status);
  const explanation = f.find('gev-wind-reading__explanation');
  assert.equal(explanation.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(explanation.children.length, 0);
  view.show({ wind: 'Unavailable', status: 'No sample', scalarValue: null });
  assert.equal(f.find('gev-wind-reading__coordinates').textContent, '');
  assert.equal(f.find('gev-wind-reading__scalar').hidden, true);
  assert.equal(f.find('gev-wind-reading__valid-time').hidden, true);
  view.destroy();
});

test('close button and scoped Escape dismiss; destroy releases all owned DOM and listeners', () => {
  const f = fixture();
  let closes = 0;
  const view = createWindPresentation({
    container: f.container,
    onClose: () => closes++,
  });
  const card = f.find('gev-wind-reading');
  const close = f.find('gev-wind-reading__close');
  assert.equal(close.tagName, 'button');
  assert.equal(close.attributes.get('aria-label'), 'Close weather reading');
  view.show(reading);
  close.dispatchEvent(new Event('click'));
  assert.equal(card.hidden, true);
  assert.equal(closes, 1);
  view.show(reading);
  const escape = new Event('keydown', { cancelable: true });
  Object.defineProperty(escape, 'key', { value: 'Escape' });
  card.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(card.hidden, true);
  assert.equal(closes, 2);
  view.show(reading);
  view.hide();
  assert.equal(closes, 2);
  assert.equal(card.hidden, true);
  view.destroy();
  view.destroy();
  close.dispatchEvent(new Event('click'));
  view.show(reading);
  assert.equal(closes, 2);
  assert.equal(f.container.children.length, 0);
});

test('independent instances do not share state or remove sibling content', () => {
  const f = fixture();
  const a = createWindPresentation({ container: f.container });
  const b = createWindPresentation({ container: f.container });
  const cards = f.container.children.filter(
    (node) => node.tagName === 'section',
  );
  a.show(reading);
  assert.equal(cards[0].hidden, false);
  assert.equal(cards[1].hidden, true);
  a.destroy();
  assert.equal(f.container.children.length, 2);
  b.show(reading);
  assert.equal(cards[1].hidden, false);
  b.destroy();
  assert.equal(f.container.children.length, 0);
});

test('inspection focuses close and explicit dismissal restores its connected trigger', () => {
  const f = fixture();
  const document = f.container.ownerDocument;
  const trigger = document.createElement('button');
  f.container.appendChild(trigger);
  const view = createWindPresentation({ container: f.container });
  const close = f.find('gev-wind-reading__close');
  const card = f.find('gev-wind-reading');
  trigger.focus();
  view.show(reading);
  assert.equal(document.activeElement, close);
  assert.deepEqual(close.focusOptions, { preventScroll: true });
  view.show(reading);
  const escape = new Event('keydown', { cancelable: true });
  Object.defineProperty(escape, 'key', { value: 'Escape' });
  card.dispatchEvent(escape);
  assert.equal(document.activeElement, trigger);
  assert.deepEqual(trigger.focusOptions, { preventScroll: true });
  view.show(reading);
  close.dispatchEvent(new Event('click'));
  assert.equal(document.activeElement, trigger);
  view.show(reading);
  trigger.remove();
  close.dispatchEvent(new Event('click'));
  assert.equal(document.activeElement, close);
  view.destroy();
});

test('layer-driven hide does not move focus to an old trigger', () => {
  const f = fixture();
  const document = f.container.ownerDocument;
  const trigger = document.createElement('button');
  const modelControl = document.createElement('button');
  f.container.appendChild(trigger);
  f.container.appendChild(modelControl);
  const view = createWindPresentation({ container: f.container });
  trigger.focus();
  view.show(reading);
  modelControl.focus();
  view.hide();
  assert.equal(document.activeElement, modelControl);
  view.destroy();
});

test('selected scalar is the primary reading and missing scalar restores wind emphasis', () => {
  const f = fixture();
  const view = createWindPresentation({ container: f.container });
  const card = f.find('gev-wind-reading');
  for (const [scalarLabel, scalarValue] of [['Temperature', '12 °C'], ['Sea-level pressure', '1012 hPa']]) {
    view.show({ ...reading, scalarLabel, scalarValue });
    assert.equal(card.attributes.get('data-scalar'), 'true');
    assert.equal(f.find('gev-wind-reading__scalar-value').textContent, scalarValue);
    assert.ok(card.children.indexOf(f.find('gev-wind-reading__scalar')) < card.children.indexOf(f.find('gev-wind-reading__wind')));
  }
  view.show({ ...reading, scalarValue: null });
  assert.equal(card.attributes.get('data-scalar'), 'false');
  assert.equal(f.find('gev-wind-reading__scalar').hidden, true);
  assert.equal(f.find('gev-wind-reading__wind').textContent, reading.wind);
  view.destroy();
});
