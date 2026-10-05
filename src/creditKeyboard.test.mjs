import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configureCreditKeyboardAccess } from './creditKeyboard.js';

function fakeElement() {
  const attributes = new Map();
  const listeners = new Map();
  return {
    dataset: {},
    focused: false,
    id: '',
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    dispatch(type, event = {}) {
      const dispatched = {
        currentTarget: this,
        target: this,
        defaultPrevented: false,
        propagationStopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.propagationStopped = true; },
        ...event,
      };
      for (const listener of listeners.get(type) || []) listener(dispatched);
      return dispatched;
    },
    click() {
      this.onclick?.();
      this.dispatch('click');
    },
    focus() { this.focused = true; },
    listenerCount(type) { return listeners.get(type)?.length || 0; },
  };
}

function fixture() {
  const expand = fakeElement();
  const close = fakeElement();
  const lightbox = fakeElement();
  lightbox.querySelector = () => close;
  lightbox.contains = (target) => target === lightbox || target === close;
  const overlay = fakeElement();
  lightbox.parentElement = overlay;
  const root = {
    querySelector(selector) {
      if (selector === '#cesium-credits .cesium-credit-expand-link') return expand;
      if (selector === '.cesium-credit-lightbox') return lightbox;
      return null;
    },
  };
  return { close, expand, lightbox, overlay, root };
}

test('Cesium Data attribution and close controls join the keyboard tab order', () => {
  const f = fixture();
  assert.equal(configureCreditKeyboardAccess(f.root), true);
  assert.equal(f.expand.getAttribute('role'), 'button');
  assert.equal(f.expand.getAttribute('tabindex'), '0');
  assert.equal(f.expand.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(f.expand.getAttribute('aria-expanded'), 'false');
  assert.equal(f.close.getAttribute('role'), 'button');
  assert.equal(f.close.getAttribute('tabindex'), '0');
  assert.equal(f.close.getAttribute('aria-label'), 'Close data attribution');
});

test('Enter opens and closes attribution on initial keydown', () => {
  const f = fixture();
  let opened = 0;
  let closed = 0;
  f.expand.onclick = () => { opened++; };
  f.close.onclick = () => { closed++; };
  configureCreditKeyboardAccess(f.root);
  const openEvent = f.expand.dispatch('keydown', { key: 'Enter' });
  assert.equal(openEvent.defaultPrevented, true);
  assert.equal(opened, 1);
  assert.equal(f.expand.getAttribute('aria-expanded'), 'true');
  assert.equal(f.close.focused, true);
  const closeEvent = f.close.dispatch('keydown', { key: 'Enter' });
  assert.equal(closeEvent.defaultPrevented, true);
  assert.equal(closed, 1);
  assert.equal(f.expand.getAttribute('aria-expanded'), 'false');
  assert.equal(f.expand.focused, true);
});

test('Space opens and closes attribution only on key release', () => {
  const f = fixture();
  let opened = 0;
  let closed = 0;
  f.expand.onclick = () => { opened++; };
  f.close.onclick = () => { closed++; };
  configureCreditKeyboardAccess(f.root);

  const openDown = f.expand.dispatch('keydown', { key: ' ' });
  assert.equal(openDown.defaultPrevented, true);
  assert.equal(opened, 0);
  assert.equal(f.expand.getAttribute('aria-expanded'), 'false');
  const openUp = f.expand.dispatch('keyup', { key: ' ' });
  assert.equal(openUp.defaultPrevented, true);
  assert.equal(opened, 1);
  assert.equal(f.expand.getAttribute('aria-expanded'), 'true');
  assert.equal(f.close.focused, true);

  const closeDown = f.close.dispatch('keydown', { key: ' ' });
  assert.equal(closeDown.defaultPrevented, true);
  assert.equal(closed, 0);
  const closeUp = f.close.dispatch('keyup', { key: ' ' });
  assert.equal(closeUp.defaultPrevented, true);
  assert.equal(closed, 1);
  assert.equal(f.expand.getAttribute('aria-expanded'), 'false');
  assert.equal(f.expand.focused, true);
});

test('held activation keys do not repeat open or close actions', () => {
  const f = fixture();
  let opened = 0;
  f.expand.onclick = () => { opened++; };
  configureCreditKeyboardAccess(f.root);

  f.expand.dispatch('keydown', { key: ' ' });
  const repeated = f.expand.dispatch('keydown', { key: ' ', repeat: true });
  assert.equal(repeated.defaultPrevented, true);
  assert.equal(opened, 0);
  f.expand.dispatch('keyup', { key: ' ' });
  assert.equal(opened, 1);
  f.expand.dispatch('keyup', { key: ' ' });
  assert.equal(opened, 1);

  const g = fixture();
  let enterOpened = 0;
  g.expand.onclick = () => { enterOpened++; };
  configureCreditKeyboardAccess(g.root);
  g.expand.dispatch('keydown', { key: 'Enter' });
  g.expand.dispatch('keydown', { key: 'Enter', repeat: true });
  assert.equal(enterOpened, 1);
});

test('losing focus during a Space hold cancels release activation', () => {
  const f = fixture();
  let opened = 0;
  f.expand.onclick = () => { opened++; };
  configureCreditKeyboardAccess(f.root);

  f.expand.dispatch('keydown', { key: ' ' });
  f.expand.dispatch('blur');
  const release = f.expand.dispatch('keyup', { key: ' ' });
  assert.equal(release.defaultPrevented, true);
  assert.equal(opened, 0);
  assert.equal(f.expand.getAttribute('aria-expanded'), 'false');
});

test('Escape and backdrop dismissal close attribution and restore its disclosure', () => {
  const f = fixture();
  let closed = 0;
  f.close.onclick = () => { closed++; };
  configureCreditKeyboardAccess(f.root);
  f.expand.click();
  const escape = f.lightbox.dispatch('keydown', { key: 'Escape', target: f.close });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(escape.propagationStopped, true);
  assert.equal(closed, 1);
  assert.equal(f.expand.getAttribute('aria-expanded'), 'false');
  assert.equal(f.expand.focused, true);

  f.expand.focused = false;
  f.expand.click();
  f.overlay.dispatch('click', { target: f.overlay });
  assert.equal(f.expand.getAttribute('aria-expanded'), 'false');
  assert.equal(f.expand.focused, true);
});

test('credit keyboard setup is idempotent and safely declines incomplete markup', () => {
  const f = fixture();
  assert.equal(configureCreditKeyboardAccess(f.root), true);
  assert.equal(configureCreditKeyboardAccess(f.root), true);
  assert.equal(f.expand.listenerCount('keydown'), 1);
  assert.equal(f.expand.listenerCount('keyup'), 1);
  assert.equal(f.expand.listenerCount('blur'), 1);
  assert.equal(f.close.listenerCount('keydown'), 1);
  assert.equal(f.close.listenerCount('keyup'), 1);
  assert.equal(f.close.listenerCount('blur'), 1);
  assert.equal(f.lightbox.listenerCount('keydown'), 1);
  assert.equal(f.overlay.listenerCount('click'), 1);
  assert.equal(configureCreditKeyboardAccess({ querySelector: () => null }), false);
});
