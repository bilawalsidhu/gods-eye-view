import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { useNavControlStore } from './navControl.js';

const VIEW = { heading: 10, tilt: 20, following: false, dragging: false };
const owner = (answer) => ({ press: () => answer });

test('nothing shows until an owner publishes, and the view is a frozen copy', () => {
  const nav = useNavControlStore(createPinia());
  assert.equal(nav.view, null);
  const token = nav.connect(owner('a'));
  nav.publish(token, VIEW);
  assert.deepEqual({ ...nav.view }, VIEW);
  assert.equal(Object.isFrozen(nav.view), true);
});

test('a newer owner answers the actions and an older owner no longer publishes', () => {
  const nav = useNavControlStore(createPinia());
  const older = nav.connect(owner('older'));
  const newer = nav.connect(owner('newer'));
  assert.equal(nav.act('press'), 'newer');
  nav.publish(older, VIEW);
  assert.equal(nav.view, null, 'the replaced owner is ignored');
  nav.publish(newer, VIEW);
  assert.equal(nav.view.heading, 10);
});

test('the control goes only when no owner is left to answer it', () => {
  const nav = useNavControlStore(createPinia());
  const older = nav.connect(owner('older'));
  const newer = nav.connect(owner('newer'));
  nav.publish(newer, VIEW);
  nav.detach(newer);
  assert.ok(nav.view, 'an older owner still answers, so the control stays');
  assert.equal(nav.act('press'), 'older');
  nav.detach(older);
  assert.equal(nav.view, null);
  assert.equal(nav.act('press'), undefined);
});
