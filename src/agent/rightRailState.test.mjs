import test from 'node:test';
import assert from 'node:assert/strict';
import { readRightRailState, rightRailReply } from './rightRailState.js';
function fixture() {
  const classes = new Set();
  const rail = { hidden: false, getAttribute: () => 'vertical' };
  const panel = (id, collapsed) => ({
    id,
    parentElement: rail,
    hidden: false,
    classList: { contains: (name) => name === 'collapsed' && collapsed },
  });
  const nodes = new Map([
    ['right-context-rail', rail],
    ['pp-toggles', panel('pp-toggles', true)],
    ['cctv-panel', panel('cctv-panel', true)],
    ['global-context-panel', panel('global-context-panel', false)],
  ]);
  return {
    rail,
    nodes,
    classes,
    doc: {
      getElementById: (id) => nodes.get(id),
      body: { classList: { contains: (name) => classes.has(name) } },
    },
  };
}
test('snapshot reads current collapsed classes and names the final owner', () => {
  const f = fixture(),
    state = readRightRailState(f.doc);
  assert.deepEqual(state.openPanelIds, ['global-context-panel']);
  assert.equal(
    rightRailReply(state),
    'Right rail: Context open. Closed: Display, CCTV.',
  );
});
test('observation excludes hidden and nested panels without changing preferences or focus', () => {
  const f = fixture();
  f.nodes.get('cctv-panel').hidden = true;
  f.nodes.get('pp-toggles').parentElement = {};
  assert.deepEqual(readRightRailState(f.doc).closedPanelIds, []);
  assert.equal(f.nodes.get('cctv-panel').hidden, true);
});
test('mobile expansion is independent and is not described as simultaneous sheet visibility', () => {
  const f = fixture();
  f.classes.add('mobile-shell');
  f.nodes.get('cctv-panel').classList.contains = () => false;
  const state = readRightRailState(f.doc);
  assert.equal(state.layout, 'mobile');
  assert.equal(
    rightRailReply(state),
    'Expanded panels: CCTV, Context. Closed panels: Display.',
  );
});
test('older shells and non-DOM users do not acquire the new exclusive policy', () => {
  assert.equal(readRightRailState(null), null);
  const f = fixture();
  f.rail.getAttribute = () => null;
  assert.equal(readRightRailState(f.doc), null);
  assert.equal(rightRailReply(null), null);
});
test('Cockpit and CSS-hidden rail are not reported visible', () => {
  const f = fixture();
  f.classes.add('cockpit-mode');
  assert.equal(readRightRailState(f.doc).visible, false);
  assert.match(rightRailReply(readRightRailState(f.doc)), /hidden/);
  f.classes.clear();
  f.doc.defaultView = { getComputedStyle: () => ({ display: 'none' }) };
  assert.equal(readRightRailState(f.doc).visible, false);
});
test('an invariant violation is reported without mutating the panels', () => {
  const f = fixture();
  f.nodes.get('cctv-panel').classList.contains = () => false;
  const state = readRightRailState(f.doc);
  assert.equal(state.openPanelIds.length, 2);
  assert.match(rightRailReply(state), /could not be confirmed/);
  assert.deepEqual(readRightRailState(f.doc), state);
});
