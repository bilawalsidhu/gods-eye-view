// src/ui/stores/owners.test.mjs — the newest connected owner with an action
// answers it; detaching hands the action back to the one before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwners } from './owners.js';

test('the newest owner with an action answers it, and detach hands it back', () => {
  const { connect, detach, act } = createOwners();
  const calls = [];
  const first = connect({
    play: (n) => calls.push(['first.play', n]),
    stop: () => calls.push(['first.stop']),
  });
  const second = connect({ play: (n) => calls.push(['second.play', n]) });
  act('play', 1);
  act('stop');
  act('missing');
  detach(second);
  act('play', 2);
  detach(second);
  detach(first);
  act('play', 3);
  assert.deepEqual(calls, [
    ['second.play', 1],
    ['first.stop'],
    ['first.play', 2],
  ]);
});

test('act returns what the answering action returned', () => {
  const { connect, act } = createOwners();
  connect({ pick: (tag) => `kept ${tag}` });
  assert.equal(act('pick', 'jazz'), 'kept jazz');
  assert.equal(act('missing'), undefined);
});

test('owns names the owner that answers an action', () => {
  const { connect, detach, owns } = createOwners();
  const older = connect({ tilt() {}, share() {} });
  const newer = connect({ tilt() {} });
  assert.equal(owns(newer, 'tilt'), true);
  assert.equal(owns(older, 'tilt'), false);
  assert.equal(owns(older, 'share'), true);
  assert.equal(owns(newer, 'missing'), false);
  assert.equal(owns(null, 'tilt'), false);
  detach(newer);
  assert.equal(owns(older, 'tilt'), true);
});

test('ownerOf names the token that answers an action', () => {
  const { connect, ownerOf } = createOwners();
  const older = connect({ clear() {}, share() {} });
  const newer = connect({ clear() {} });
  assert.equal(ownerOf('clear'), newer);
  assert.equal(ownerOf('share'), older);
  assert.equal(ownerOf('missing'), undefined);
});
