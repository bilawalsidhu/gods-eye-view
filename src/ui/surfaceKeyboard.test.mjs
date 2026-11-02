import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurfaceKeyboard } from './surfaceKeyboard.js';

function fixture() {
  const listeners = new Set();
  const documentRef = {
    activeElement: null,
    addEventListener(type, handler, capture) {
      assert.equal(type, 'keydown');
      assert.equal(capture, true);
      listeners.add(handler);
    },
    removeEventListener(type, handler, capture) {
      assert.equal(type, 'keydown');
      assert.equal(capture, true);
      listeners.delete(handler);
    },
  };
  const node = () => ({
    isConnected: true,
    hidden: false,
    disabled: false,
    focusCalls: [],
    hasAttribute(name) {
      return name === 'disabled' && this.disabled;
    },
    getClientRects() {
      return this.hidden ? [] : [{}];
    },
    focus(options) {
      documentRef.activeElement = this;
      this.focusCalls.push(options);
    },
  });
  const opener = node();
  const fallback = node();
  const first = node();
  const middle = node();
  const last = node();
  let controls = [first, middle, last];
  const root = {
    ownerDocument: documentRef,
    querySelectorAll: () => controls,
    contains: (target) => controls.includes(target),
  };
  let visible = true;
  let escapes = 0;
  let onEscape = () => {
    escapes += 1;
  };
  const controller = createSurfaceKeyboard({
    root,
    isActive: () => visible,
    onEscape: () => onEscape(),
    fallbackFocus: () => fallback,
  });
  opener.focus();
  const event = (key, extra = {}) => ({
    key,
    defaultPrevented: false,
    stopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
    ...extra,
  });
  const send = (key, extra) => {
    const e = event(key, extra);
    for (const listener of [...listeners]) listener(e);
    return e;
  };
  return {
    controller,
    listeners,
    documentRef,
    opener,
    fallback,
    first,
    middle,
    last,
    node,
    event,
    send,
    setVisible(value) {
      visible = value;
    },
    setControls(value) {
      controls = value;
    },
    setEscape(value) {
      onEscape = value;
    },
    escapes: () => escapes,
  };
}

test('construction is inert; activation is idempotent and captures the opener once', () => {
  const f = fixture();
  assert.equal(f.listeners.size, 0);
  f.controller.activate();
  f.first.focus();
  f.controller.activate();
  assert.equal(f.listeners.size, 1);
  f.controller.deactivate({ restoreFocus: true });
  assert.equal(f.listeners.size, 0);
  assert.equal(f.documentRef.activeElement, f.opener);
  assert.deepEqual(f.opener.focusCalls.at(-1), { preventScroll: true });
});

test('Tab enters from outside in either direction and wraps only at an edge', () => {
  const f = fixture();
  f.controller.activate();
  assert.equal(f.send('Tab').defaultPrevented, true);
  assert.equal(f.documentRef.activeElement, f.first);
  assert.equal(f.send('Tab').defaultPrevented, false);
  f.middle.focus();
  assert.equal(f.send('Tab', { shiftKey: true }).defaultPrevented, false);
  f.last.focus();
  f.send('Tab');
  assert.equal(f.documentRef.activeElement, f.first);
  f.send('Tab', { shiftKey: true });
  assert.equal(f.documentRef.activeElement, f.last);
  f.opener.focus();
  f.send('Tab', { shiftKey: true });
  assert.equal(f.documentRef.activeElement, f.last);
  assert.equal(
    f.last.focusCalls.at(-1),
    undefined,
    'wrapping permits native scroll into view',
  );
});

test('Tab uses current controls and skips hidden/disabled nodes without changing native middle movement', () => {
  const f = fixture();
  f.controller.activate();
  f.first.hidden = true;
  f.last.disabled = true;
  f.send('Tab');
  assert.equal(f.documentRef.activeElement, f.middle);
  const replacement = f.node();
  f.setControls([replacement]);
  f.send('Tab');
  assert.equal(f.documentRef.activeElement, replacement);
  f.setControls([]);
  assert.equal(f.send('Tab').defaultPrevented, false);
});

test('hidden or covered surfaces and already-claimed keys never dismiss or redirect focus', () => {
  const f = fixture();
  f.controller.activate();
  f.setVisible(false);
  assert.equal(f.send('Escape').defaultPrevented, false);
  assert.equal(f.send('Tab').defaultPrevented, false);
  f.setVisible(true);
  f.send('Escape', { defaultPrevented: true });
  f.send('Tab', { defaultPrevented: true });
  assert.equal(f.escapes(), 0);
  assert.equal(f.documentRef.activeElement, f.opener);
  assert.equal(f.send('x').defaultPrevented, false);
});

test('Escape claims input before calling dismissal; reentrant destruction is safe', () => {
  const f = fixture();
  f.controller.activate();
  const handler = [...f.listeners][0];
  const e = f.event('Escape');
  f.setEscape(() => {
    assert.equal(e.defaultPrevented, true);
    assert.equal(e.stopped, true);
    f.controller.destroy();
  });
  handler(e);
  assert.equal(f.listeners.size, 0);
  const late = f.event('Escape');
  handler(late);
  assert.equal(late.defaultPrevented, false);
});

test('deactivation can yield without stealing focus, then reopen with a new return target', () => {
  const f = fixture();
  f.controller.activate();
  f.first.focus();
  f.controller.deactivate();
  assert.equal(f.documentRef.activeElement, f.first);
  f.last.focus();
  f.controller.activate();
  f.middle.focus();
  f.controller.deactivate({ restoreFocus: true });
  assert.equal(f.documentRef.activeElement, f.last);
  const calls = f.last.focusCalls.length;
  f.controller.deactivate({ restoreFocus: true });
  assert.equal(f.last.focusCalls.length, calls);
});

test('a disconnected opener uses the caller fallback', () => {
  const f = fixture();
  f.controller.activate();
  f.opener.isConnected = false;
  f.controller.deactivate({ restoreFocus: true });
  assert.equal(f.documentRef.activeElement, f.fallback);
});

test('destroy is permanent, releases its listener and never restores focus', () => {
  const f = fixture();
  f.controller.activate();
  const handler = [...f.listeners][0];
  f.first.focus();
  f.controller.destroy();
  f.controller.destroy();
  f.controller.activate();
  f.controller.deactivate({ restoreFocus: true });
  assert.equal(f.listeners.size, 0);
  assert.equal(f.documentRef.activeElement, f.first);
  const e = f.event('Tab');
  handler(e);
  assert.equal(e.defaultPrevented, false);
});
