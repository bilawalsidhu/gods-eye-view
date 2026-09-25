import test from 'node:test';
import assert from 'node:assert/strict';

import { RadialMenu, RADIAL_ACTIONS } from './radialMenu.js';

test('RADIAL_ACTIONS contains 8 defined tactical actions', () => {
  assert.equal(RADIAL_ACTIONS.length, 8);
  const actionIds = RADIAL_ACTIONS.map((a) => a.id);
  assert.deepEqual(actionIds, [
    'lock',
    'chase',
    'cockpit',
    'cctv',
    'trajectory',
    'inspect',
    'watchlist',
    'dismiss',
  ]);
});

test('RadialMenu handles action selection and lifecycle without DOM errors', () => {
  let triggeredAction = null;
  let triggeredEntity = null;

  const menu = new RadialMenu({
    onAction: (action, entity) => {
      triggeredAction = action;
      triggeredEntity = entity;
    },
  });

  menu._currentEntity = { id: 'FLIGHT-99', name: 'TEST-JET' };
  menu._handleAction('lock');

  assert.equal(triggeredAction, 'lock');
  assert.equal(triggeredEntity.id, 'FLIGHT-99');

  // Dismiss should not fire onAction callback
  triggeredAction = null;
  menu._currentEntity = { id: 'FLIGHT-100' };
  menu._handleAction('dismiss');
  assert.equal(triggeredAction, null);

  menu.destroy();
});
