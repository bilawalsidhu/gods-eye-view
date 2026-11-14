import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSelection } from './selection.js';
import { bindFakeGroundRenderer } from '../../testSupport/fakeGroundRenderer.mjs';
import { fromDegrees } from '../../geo/ellipsoid.js';

test('a double-click follows the selected station, as its highlight entity was; deselecting ends it', (t) => {
  const viewer = {};
  const fake = bindFakeGroundRenderer(viewer);
  t.after(fake.unbind);
  const listeners = {};
  fake.renderer.input = {
    on(type, fn) {
      listeners[type] = fn;
      return () => delete listeners[type];
    },
    behaviours: { dblclickFollow: { enabled: true } },
  };
  const press = (type) =>
    listeners[type]({
      button: 0,
      modifiers: { shift: false, ctrl: false, alt: false, meta: false },
      position: { x: 5, y: 5 },
    });
  const position = fromDegrees(2, 41, 20);
  const state = {
    _enabled: true,
    _selectedKey: null,
    _stationRenderMap: new Map([['bcn:1', { position, stationId: '1' }]]),
    _stationSet: fake.renderer.draw.points({ id: 'bikeshare:stations' }),
    _selectedSet: fake.renderer.draw.points({ id: 'bikeshare:selected' }),
    _overlayHost: { setEntries() {}, clearSource() {} },
    _clickSubscription: null,
  };
  const selection = createSelection({
    state,
    services: {},
    parts: {
      rendering: { stationItem: (r) => ({ id: 'bcn:1', pos: r.position }) },
    },
    source: {},
  });
  const priorDocument = globalThis.document;
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  t.after(() => {
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
  });
  selection._installClickHandler(viewer);

  // A station dot itself (a point primitive before) is never followed.
  fake.setPick(() => ({ set: 'bikeshare:stations', id: 'bcn:1' }));
  press('dblclick');
  assert.equal(fake.follows.length, 0);

  // Its first click selects it; the double-click lands on the highlight.
  press('click');
  assert.equal(state._selectedKey, 'bcn:1');
  fake.setPick(() => ({ set: 'bikeshare:selected', id: 'selected' }));
  press('dblclick');
  assert.equal(fake.follows.length, 1);
  assert.deepEqual(fake.renderer.camera.followed.position(), { ...position });

  selection._clearSelection();
  assert.equal(fake.renderer.camera.followed, null, 'the highlight went');

  // Disabled: a double-click on it follows nothing.
  state._clickSubscription();
  selection._selectStation('bcn:1');
  press('dblclick');
  assert.equal(fake.follows.length, 2, 'only the stop since');
});
