import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PanelChrome } from './panelChrome.js';
import { PanelLayoutController } from './panelLayoutController.js';

// Clean view hides both side rails. Toggling it must not re-measure or resize
// them (no ResizeObserver churn), and leaving it must show the rails exactly
// as they were. Regression: the toggle used
// to schedule a left-rail layout, and the observers re-laid both rails
// against the hidden chrome on every enter and exit.

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

/** Fake rAF, timers, clock and a running-transition list. */
function harness() {
  const keys = [
    'document',
    'window',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'setTimeout',
    'clearTimeout',
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, globalThis[k]]));
  const savedNow = Date.now;
  const frames = new Map();
  const timers = new Map();
  const transitions = [];
  let next = 0;
  let clock = 1_000_000;
  const classes = new Set();
  const node = () => ({ id: 'n', style: {}, querySelectorAll: () => [] });
  globalThis.document = {
    body: {
      classList: {
        contains: (name) => classes.has(name),
        toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      },
    },
    getElementById: (id) =>
      id === 'left-panel-stack' || id === 'right-context-rail' ? node() : null,
    querySelectorAll: () => [],
    getAnimations: () => transitions,
  };
  globalThis.window = { innerWidth: 915, innerHeight: 412 };
  globalThis.requestAnimationFrame = (cb) => {
    frames.set(++next, cb);
    return next;
  };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  globalThis.setTimeout = (cb, ms = 0) => {
    timers.set(++next, { cb, at: clock + ms });
    return next;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  Date.now = () => clock;
  const owner = new PanelLayoutController({
    readHud: () => ({ visible: true, variant: 'tactical' }),
    scheduleCockpitLayout() {},
    syncPanelCollapseButton() {},
    readDisplayScrollTop: () => 0,
  });
  const layouts = [];
  owner._syncLeftPanelAdaptiveLayout = () => layouts.push('left');
  owner._syncRightPanelAdaptiveLayout = () => layouts.push('right');
  const flushFrames = () => {
    for (let guard = 0; frames.size && guard < 20; guard += 1) {
      const batch = [...frames.values()];
      frames.clear();
      batch.forEach((cb) => cb());
    }
  };
  const advance = (ms) => {
    const end = clock + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      clock = Math.max(clock, due[1].at);
      due[1].cb();
    }
    clock = end;
    flushFrames();
  };
  // The real shell method, run against a shell-shaped `this` whose rails are
  // this controller (through the real PanelChrome forwarding method).
  const src = fs.readFileSync(
    path.join(ROOT, 'src/ui/applicationShell.js'),
    'utf8',
  );
  const start = src.indexOf('  toggleCleanView(forceEnabled) {');
  const end = src.indexOf('\n  }\n', start) + 4;
  const toggleCleanView = new Function(
    'document',
    `return { ${src.slice(start, end).trim()} }.toggleCleanView;`,
  )(globalThis.document);
  const chrome = Object.create(PanelChrome.prototype);
  chrome._panelLayout = owner;
  const shell = {
    _cleanViewBtn: null,
    _cleanViewEye: null,
    _panelChrome: chrome,
    _scheduleLeftPanelLayout: (o) => owner._scheduleLeftPanelLayout(o),
    toggleCleanView(force) {
      return toggleCleanView.call(this, force);
    },
  };
  // What the rail/obstacle observers do when clean view hides the chrome.
  const observersFire = () => {
    owner._scheduleLeftPanelLayout();
    owner._scheduleRightPanelLayout({ reconsiderAutoCollapse: true });
  };
  return {
    owner,
    shell,
    layouts,
    frames,
    timers,
    transitions,
    flushFrames,
    advance,
    observersFire,
    restore() {
      owner.destroy();
      Object.assign(globalThis, saved);
      Date.now = savedNow;
    },
  };
}

test('entering clean view runs no rail layout, even when the observers fire', () => {
  const h = harness();
  try {
    h.shell.toggleCleanView();
    h.observersFire();
    h.advance(5000);
    assert.deepEqual(h.layouts, [], 'rails are not re-laid while hidden');
    assert.equal(h.frames.size, 0);
  } finally {
    h.restore();
  }
});

test('a clean-view round trip with nothing to redo leaves the rails untouched', () => {
  const h = harness();
  try {
    h.shell.toggleCleanView(true);
    h.advance(1000);
    h.shell.toggleCleanView(false);
    h.advance(5000);
    assert.deepEqual(h.layouts, []);
    assert.equal(h.frames.size + h.timers.size, 0);
  } finally {
    h.restore();
  }
});

test('leaving clean view waits for the fade, then runs held work once', () => {
  const h = harness();
  try {
    h.shell.toggleCleanView(true);
    h.observersFire();
    h.observersFire();
    h.shell.toggleCleanView(false);
    // Mid-fade: the chrome is half shown, so the rails keep their geometry.
    h.observersFire();
    h.advance(300);
    assert.deepEqual(h.layouts, []);
    h.transitions.push({ playState: 'running', transitionProperty: 'opacity' });
    h.advance(300);
    assert.deepEqual(h.layouts, [], 'still fading');
    h.transitions.length = 0;
    h.advance(300);
    assert.deepEqual(h.layouts.sort(), ['left', 'right']);
    h.advance(5000);
    assert.equal(h.layouts.length, 2, 'once, not per observer callback');
  } finally {
    h.restore();
  }
});

test('the release is capped if a transition never ends', () => {
  const h = harness();
  try {
    h.shell.toggleCleanView(true);
    h.observersFire();
    h.transitions.push({ playState: 'running', transitionProperty: 'opacity' });
    h.shell.toggleCleanView(false);
    h.advance(1900);
    assert.deepEqual(h.layouts, []);
    h.advance(400);
    assert.deepEqual(h.layouts.sort(), ['left', 'right']);
  } finally {
    h.restore();
  }
});

test('a frame queued before clean view is carried over, not run hidden', () => {
  const h = harness();
  try {
    h.owner._scheduleLeftPanelLayout();
    assert.equal(h.frames.size, 1);
    h.shell.toggleCleanView(true);
    assert.equal(h.frames.size, 0, 'the queued frame is cancelled');
    h.advance(2000);
    assert.deepEqual(h.layouts, []);
    h.shell.toggleCleanView(false);
    h.advance(3000);
    assert.deepEqual(h.layouts, ['left']);
  } finally {
    h.restore();
  }
});

test('re-entering clean view during the exit fade keeps the hold', () => {
  const h = harness();
  try {
    h.shell.toggleCleanView(true);
    h.observersFire();
    h.shell.toggleCleanView(false);
    h.advance(200);
    h.shell.toggleCleanView(true);
    h.advance(5000);
    assert.deepEqual(h.layouts, []);
    assert.equal(h.timers.size, 0, 'the pending release is cancelled');
    h.shell.toggleCleanView(false);
    h.advance(3000);
    assert.deepEqual(h.layouts.sort(), ['left', 'right']);
  } finally {
    h.restore();
  }
});

test('outside clean view the rails lay out as before', () => {
  const h = harness();
  try {
    h.observersFire();
    h.flushFrames();
    assert.deepEqual(h.layouts.sort(), ['left', 'right']);
  } finally {
    h.restore();
  }
});

test('destroy drops a pending release', () => {
  const h = harness();
  try {
    h.shell.toggleCleanView(true);
    h.observersFire();
    h.shell.toggleCleanView(false);
    h.owner.destroy();
    assert.equal(h.timers.size, 0);
    h.advance(5000);
    assert.deepEqual(h.layouts, []);
  } finally {
    h.restore();
  }
});
