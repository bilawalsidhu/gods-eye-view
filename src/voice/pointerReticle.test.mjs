import assert from 'node:assert/strict';
import test from 'node:test';
import { readStylesheet } from '../testSupport/readStylesheet.mjs';
import { PointerReticle, RETICLE_LINGER_MS, RETICLE_MAX_MS } from './pointerReticle.js';

const css = readStylesheet(new URL('../../style.css', import.meta.url));

function fakeDoc() {
  const appended = [];
  return {
    appended,
    body: { appendChild: (node) => appended.push(node) },
    createElement: (tag) => ({
      tag,
      hidden: false,
      style: {},
      dataset: {},
      attributes: {},
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      removed: false,
      remove() {
        this.removed = true;
      },
    }),
  };
}

function harness() {
  const doc = fakeDoc();
  const timers = new Map();
  let next = 1;
  const reticle = new PointerReticle({
    doc,
    rectOf: () => ({ left: 10, top: 20 }),
    setTimer: (fn, ms) => {
      const id = next++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });
  const fire = () => {
    const [[id, timer]] = [...timers];
    timers.delete(id);
    timer.fn();
  };
  return { doc, timers, reticle, fire };
}

const pointer = { kind: 'this', label: 'UPS793', screenPx: { x: 600, y: 200 } };

test('reticle: shows at the pointed pixel and caps its lifetime', () => {
  const { doc, timers, reticle, fire } = harness();
  reticle.handle({ type: 'pointer', pointer });
  const node = doc.appended[0];
  assert.equal(node.className, 'gev-pointer-reticle');
  assert.equal(node.attributes['aria-hidden'], 'true');
  assert.equal(node.hidden, false);
  assert.equal(node.style.left, '610px');
  assert.equal(node.style.top, '220px');
  assert.equal(node.dataset.target, 'entity');
  assert.equal([...timers.values()][0].ms, RETICLE_MAX_MS);
  fire();
  assert.equal(node.hidden, true);
});

test('reticle: leaves when a tool moves the camera, lingers after a reply', () => {
  const { doc, timers, reticle, fire } = harness();
  reticle.handle({ type: 'pointer', pointer: { ...pointer, kind: 'here' } });
  const node = doc.appended[0];
  assert.equal(node.dataset.target, 'ground');
  reticle.handle({ type: 'action-call', name: 'analyst_query', callId: 'c1' });
  reticle.handle({ type: 'action-call', name: 'analyst_query', callId: 'c2' });
  reticle.handle({ type: 'action-result', name: 'analyst_query', callId: 'c1' });
  reticle.handle({ type: 'completion' });
  assert.equal([...timers.values()][0].ms, RETICLE_MAX_MS, 'a sibling call still running keeps it');
  reticle.handle({ type: 'action-result', name: 'analyst_query', callId: 'c2' });
  reticle.handle({ type: 'completion' });
  assert.equal([...timers.values()][0].ms, RETICLE_LINGER_MS);
  fire();
  assert.equal(node.hidden, true);
  reticle.handle({ type: 'pointer', pointer });
  reticle.handle({ type: 'action-call', name: 'track_entity' });
  assert.equal(node.hidden, true, 'camera tools hide it at once');
  reticle.handle({ type: 'pointer', pointer });
  reticle.handle({ type: 'state', state: 'idle' });
  assert.equal(node.hidden, true, 'session end hides it');
  assert.equal(timers.size, 0);
  reticle.destroy();
  reticle.destroy();
  assert.equal(node.removed, true);
  reticle.handle({ type: 'pointer', pointer });
  assert.equal(doc.appended.length, 1, 'destroyed reticle ignores events');
});

test('reticle css: overlay is inert and hidden in Clean-UI and recording', () => {
  assert.match(css, /\.gev-pointer-reticle\s*\{[^}]*pointer-events:\s*none/);
  assert.match(css, /body\.ui-clean-view \.gev-pointer-reticle/);
  assert.match(css, /body\.recording-mode \.gev-pointer-reticle/);
  assert.match(css, /\.gev-pointer-reticle\[hidden\]/);
});
