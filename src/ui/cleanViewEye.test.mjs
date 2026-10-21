import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { bindCleanViewEye, CLEAN_VIEW_EYE_IDLE_MS } from './cleanViewEye.js';
import { bindApplicationShortcuts } from './applicationShortcuts.js';
import { bindDisplayControls } from './displayControls.js';
import { expandApplicationHtml } from '../../build/application-html.js';
import { readStylesheet } from '../testSupport/readStylesheet.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

class ClassList {
  constructor() {
    this.set = new Set();
  }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : Boolean(force);
    if (on) this.set.add(name);
    else this.set.delete(name);
    return on;
  }
  contains(name) {
    return this.set.has(name);
  }
}

class FakeElement extends EventTarget {
  constructor(id) {
    super();
    this.id = id;
    this.attributes = new Map();
    this.classList = new ClassList();
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  matches() {
    return false;
  }
}

class FakeDocument extends EventTarget {
  constructor() {
    super();
    this.body = new FakeElement('body');
    this.listenerLog = [];
  }
  addEventListener(type, listener, options) {
    this.listenerLog.push({ type, options });
    super.addEventListener(type, listener, options);
  }
}

function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...pending])
        if (t.at <= now) {
          pending.delete(id);
          t.fn();
        }
    },
    get size() {
      return pending.size;
    },
  };
}

/**
 * The shell's real toggleCleanView, lifted from applicationShell.js (the
 * class imports Cesium and the whole app, so the method runs alone here
 * against a fake document and a `this` that records every member it reads).
 */
function loadToggleCleanView(documentRef) {
  const src = read('src/ui/applicationShell.js');
  const start = src.indexOf('  toggleCleanView(forceEnabled) {');
  assert.ok(start > 0, 'toggleCleanView(forceEnabled) is still in the shell');
  const end = src.indexOf('\n  }\n', start) + 4;
  const method = src.slice(start, end).trim();
  return new Function('document', `return { ${method} }.toggleCleanView;`)(
    documentRef,
  );
}

/** A shell-shaped `this`: viewer/layer access throws, reads are recorded. */
function fakeShell(documentRef, timers) {
  const reads = new Set();
  const cleanViewBtn = new FakeElement('clean-view-toggle');
  cleanViewBtn.setAttribute('aria-pressed', 'false'); // as in the markup
  const eyeBtn = new FakeElement('clean-view-eye');
  const exitBtn = new FakeElement('clean-view-exit');
  const toggle = loadToggleCleanView(documentRef);
  const layoutCalls = [];
  const target = {
    _cleanViewBtn: cleanViewBtn,
    _cleanViewEye: bindCleanViewEye({
      button: eyeBtn,
      documentRef,
      timers,
    }),
    // Clean view holds the hidden rails' layout instead of re-laying them.
    _panelChrome: {
      holdPanelLayout: (held) => layoutCalls.push(`hold:${held}`),
    },
  };
  const shell = new Proxy(target, {
    get(obj, key) {
      if (typeof key === 'string') reads.add(key);
      if (key === 'toggleCleanView') return (...a) => toggle.apply(shell, a);
      if (!(key in obj))
        throw new Error(`toggleCleanView touched this.${String(key)}`);
      return obj[key];
    },
  });
  return { shell, reads, cleanViewBtn, eyeBtn, exitBtn, layoutCalls };
}

/** Wire the real shortcuts + Display controls to the shell like DisplayBindings. */
function wiredApp() {
  const documentRef = new FakeDocument();
  const timers = fakeTimers();
  const f = fakeShell(documentRef, timers);
  const actions = {
    setStyle() {},
    dismissSearch() {},
    toggleHud: () => f.hudToggles.push('hud'),
    toggleOrbit() {},
    toggleCleanView: () => f.shell.toggleCleanView(),
    exitCleanView: () => {
      if (documentRef.body.classList.contains('ui-clean-view'))
        f.shell.toggleCleanView(false);
    },
    toggleLayers() {},
    cycleDetection() {},
    toggleCctv() {},
  };
  f.hudToggles = [];
  bindApplicationShortcuts({
    documentRef,
    searchInput: new FakeElement('search'),
    actions,
  });
  bindDisplayControls({
    elements: {
      cleanViewButton: f.cleanViewBtn,
      cleanViewExitButton: f.exitBtn,
      cleanViewEyeButton: f.eyeBtn,
    },
    actions: {
      toggleCleanView: () => f.shell.toggleCleanView(),
      exitCleanView: () => f.shell.toggleCleanView(false),
    },
  });
  f.shell._cleanViewEye.sync(false);
  const key = (k, extra = {}) => {
    const event = new Event('keydown');
    Object.assign(event, { key: k }, extra);
    Object.defineProperty(event, 'target', {
      value: new FakeElement('canvas'),
    });
    documentRef.dispatchEvent(event);
  };
  const state = () => ({
    clean: documentRef.body.classList.contains('ui-clean-view'),
    eye: f.eyeBtn.getAttribute('aria-pressed'),
    button: f.cleanViewBtn.getAttribute('aria-pressed'),
    active: f.cleanViewBtn.classList.contains('active'),
  });
  const on = { clean: true, eye: 'true', button: 'true', active: true };
  const off = { clean: false, eye: 'false', button: 'false', active: false };
  return { ...f, documentRef, timers, key, state, on, off };
}

test('the eye mirrors clean view: aria-pressed, label and title', () => {
  const documentRef = new FakeDocument();
  const button = new FakeElement('clean-view-eye');
  const eye = bindCleanViewEye({ button, documentRef, timers: fakeTimers() });
  eye.sync(false);
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.match(button.getAttribute('aria-label'), /hide the controls/);
  assert.match(button.getAttribute('title'), /\(V\)$/);
  eye.sync(true);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.match(button.getAttribute('aria-label'), /show the controls/);
  eye.destroy();
});

test('the eye fades after the idle time only while clean view is on', () => {
  const documentRef = new FakeDocument();
  const timers = fakeTimers();
  const button = new FakeElement('clean-view-eye');
  const eye = bindCleanViewEye({ button, documentRef, timers });
  assert.equal(CLEAN_VIEW_EYE_IDLE_MS, 3000);
  eye.sync(false);
  timers.advance(10_000);
  assert.equal(
    button.getAttribute('data-idle'),
    null,
    'normal mode never fades',
  );
  eye.sync(true);
  timers.advance(2999);
  assert.equal(button.getAttribute('data-idle'), null);
  timers.advance(1);
  assert.equal(button.getAttribute('data-idle'), 'true');
  eye.sync(false);
  assert.equal(
    button.getAttribute('data-idle'),
    null,
    'leaving clears the fade',
  );
  assert.equal(timers.size, 0, 'no timer left in normal mode');
  eye.destroy();
});

for (const type of [
  'pointerdown',
  'pointermove',
  'touchstart',
  'keydown',
  'wheel',
]) {
  test(`${type} wakes the faded eye and restarts the idle clock`, () => {
    const documentRef = new FakeDocument();
    const timers = fakeTimers();
    const button = new FakeElement('clean-view-eye');
    const eye = bindCleanViewEye({ button, documentRef, timers });
    eye.sync(true);
    timers.advance(3000);
    assert.equal(button.getAttribute('data-idle'), 'true');
    const event = new Event(type, { cancelable: true });
    documentRef.dispatchEvent(event);
    assert.equal(button.getAttribute('data-idle'), null);
    assert.equal(event.defaultPrevented, false, 'wake never claims input');
    timers.advance(2999);
    assert.equal(button.getAttribute('data-idle'), null);
    timers.advance(1);
    assert.equal(button.getAttribute('data-idle'), 'true');
    eye.destroy();
  });
}

test('wake listeners are passive capture listeners and destroy removes them', () => {
  const documentRef = new FakeDocument();
  const timers = fakeTimers();
  const button = new FakeElement('clean-view-eye');
  const eye = bindCleanViewEye({ button, documentRef, timers });
  for (const { options } of documentRef.listenerLog)
    assert.deepEqual(options, { capture: true, passive: true });
  eye.sync(true);
  eye.destroy();
  eye.destroy();
  assert.equal(timers.size, 0);
  eye.sync(true);
  timers.advance(5000);
  assert.equal(button.getAttribute('data-idle'), null, 'no fade after destroy');
  documentRef.dispatchEvent(new Event('pointerdown'));
  assert.equal(button.getAttribute('data-idle'), null);
});

test('a missing button binds nothing', () => {
  const documentRef = new FakeDocument();
  const eye = bindCleanViewEye({ button: null, documentRef });
  eye.sync(true);
  eye.destroy();
  assert.equal(documentRef.listenerLog.length, 0);
});

test('eye, V, Escape, Clean UI and EXIT drive one state and stay in sync', () => {
  const app = wiredApp();
  assert.deepEqual(app.state(), app.off);
  app.eyeBtn.dispatchEvent(new Event('click'));
  assert.deepEqual(app.state(), app.on, 'eye enters');
  app.eyeBtn.dispatchEvent(new Event('click'));
  assert.deepEqual(app.state(), app.off, 'eye exits');
  app.key('v');
  assert.deepEqual(app.state(), app.on, 'V enters');
  app.key('V');
  assert.deepEqual(app.state(), app.off, 'V exits');
  app.cleanViewBtn.dispatchEvent(new Event('click'));
  assert.deepEqual(app.state(), app.on, 'Clean UI enters');
  app.key('Escape');
  assert.deepEqual(app.state(), app.off, 'Escape restores');
  app.key('Escape');
  assert.deepEqual(app.state(), app.off, 'Escape never enters');
  app.key('v');
  app.exitBtn.dispatchEvent(new Event('click'));
  assert.deepEqual(app.state(), app.off, 'EXIT restores');
});

test('a held V (autorepeat keydowns) toggles clean view once', () => {
  const app = wiredApp();
  app.key('v');
  for (let i = 0; i < 11; i += 1) app.key('v', { repeat: true });
  assert.deepEqual(app.state(), app.on);
  assert.equal(app.layoutCalls.length, 1, 'one toggle for one press');
  assert.deepEqual(app.hudToggles, [], 'V never reaches the HUD');
});

test('Escape typed in a form control does not leave clean view', () => {
  const documentRef = new FakeDocument();
  const calls = [];
  bindApplicationShortcuts({
    documentRef,
    searchInput: new FakeElement('search'),
    actions: {
      dismissSearch: () => calls.push('dismiss'),
      exitCleanView: () => calls.push('exit'),
    },
  });
  const event = new Event('keydown');
  Object.defineProperty(event, 'target', {
    value: Object.assign(new FakeElement('i'), { matches: () => true }),
  });
  event.key = 'Escape';
  documentRef.dispatchEvent(event);
  assert.deepEqual(calls, ['dismiss']);
});

test('toggling touches only the body class, the buttons and the rail layout hold', () => {
  const app = wiredApp();
  app.reads.clear();
  app.eyeBtn.dispatchEvent(new Event('click'));
  app.key('v');
  // The proxy throws on any other member (viewer, camera, layers, data):
  // clean view never moves the camera, refetches or changes layer state.
  assert.deepEqual([...app.reads].sort(), [
    '_cleanViewBtn',
    '_cleanViewEye',
    '_panelChrome',
    'toggleCleanView',
  ]);
  // Enter holds the rail layout, leaving releases it; no layout is scheduled.
  assert.deepEqual(app.layoutCalls, ['hold:true', 'hold:false']);
  assert.deepEqual(
    [...app.documentRef.body.classList.set],
    [],
    'only ui-clean-view is ever written to <body>',
  );
});

test('markup: the eye is a labelled toggle button beside EXIT CLEAN VIEW', () => {
  const html = expandApplicationHtml(read('index.html'));
  const eye = html.match(/<button id="clean-view-eye"[^>]*>/)?.[0];
  assert.ok(eye, 'eye button in the page');
  assert.match(eye, /type="button"/);
  assert.match(eye, /aria-pressed="false"/);
  assert.match(eye, /aria-label="[^"]+"/);
  assert.doesNotMatch(eye, /tabindex="-1"/);
  assert.match(html, /id="clean-view-toggle"[^>]*aria-pressed="false"/);
  assert.ok(
    html.indexOf('id="clean-view-exit"') < html.indexOf('id="clean-view-eye"'),
  );
});

test('styles: 44 px corner eye, safe areas, fade, and the modes that own the screen', () => {
  const css = readStylesheet(path.join(ROOT, 'style.css'));
  const rule = (selector) => {
    const i = css.indexOf(`${selector} {`);
    assert.ok(i >= 0, `rule ${selector}`);
    return css.slice(i, css.indexOf('}', i));
  };
  const base = rule('#clean-view-eye');
  assert.match(base, /position: fixed/);
  assert.match(base, /width: 44px/);
  assert.match(base, /height: 44px/);
  assert.match(base, /env\(safe-area-inset-right/);
  assert.match(base, /env\(safe-area-inset-bottom/);
  assert.match(
    rule("body.ui-clean-view #clean-view-eye[data-idle='true']"),
    /opacity: 0\.2/,
  );
  assert.match(
    css,
    /body:is\(\.cockpit-mode, \.scene-playback-mode, \.recording-mode, \.ui-embed\)\s+#clean-view-eye \{\s*display: none !important;/,
  );
  // Phones: the eye replaces the EXIT pill.
  assert.match(
    css,
    /@media \(max-width: 720px\), \(max-height: 520px\) \{\s*body\.ui-clean-view #clean-view-exit \{\s*display: none;/,
  );
  // The HUD is hidden with visibility (boxes kept: no reflow, no resize).
  const hud = rule('body.ui-clean-view #intel-hud');
  assert.match(hud, /visibility: hidden !important/);
  assert.doesNotMatch(hud, /display:/);
  // The attribution wraps instead of running off screen.
  assert.match(
    rule('body.ui-clean-view #cesium-credits .cesium-widget-credits'),
    /white-space: normal/,
  );
});
