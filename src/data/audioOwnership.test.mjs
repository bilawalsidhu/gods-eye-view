import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  claimAudio,
  releaseAudio,
  audioOwner,
  isAudioFree,
  isAudioOwnedBy,
  isAudioLeaseCurrent,
  subscribeAudioOwnership,
  resetAudioOwnership,
} from './audioOwnership.js';

beforeEach(() => {
  resetAudioOwnership();
});

test('initial state is unowned', () => {
  assert.equal(isAudioFree(), true);
  assert.equal(audioOwner(), null);
  assert.equal(isAudioOwnedBy('atc'), false);
  assert.equal(isAudioOwnedBy('radio'), false);
});

test('claimAudio acquires lease when free', () => {
  const lease = claimAudio('atc');
  assert.ok(lease);
  assert.equal(lease.owner, 'atc');
  assert.equal(isAudioFree(), false);
  assert.equal(audioOwner(), 'atc');
  assert.equal(isAudioOwnedBy('atc'), true);
  assert.equal(isAudioLeaseCurrent(lease), true);
});

test('releaseAudio frees the lease', () => {
  const lease = claimAudio('atc');
  assert.equal(releaseAudio(lease), true);
  assert.equal(isAudioFree(), true);
  assert.equal(audioOwner(), null);
  assert.equal(isAudioLeaseCurrent(lease), false);
});

test('stale or mismatching lease cannot release', () => {
  const lease1 = claimAudio('atc');
  const fakeLease = { owner: 'atc', id: 99999 };
  assert.equal(releaseAudio(fakeLease), false);
  assert.equal(isAudioOwnedBy('atc'), true);
  assert.equal(isAudioLeaseCurrent(lease1), true);
});

test('preempt displaces existing lease and notifies subscribers', () => {
  const changes = [];
  const unsubscribe = subscribeAudioOwnership((change) => {
    changes.push(change);
  });

  const lease1 = claimAudio('atc');
  assert.equal(audioOwner(), 'atc');

  const lease2 = claimAudio('radio', { preempt: true });
  assert.ok(lease2);
  assert.equal(audioOwner(), 'radio');
  assert.equal(isAudioLeaseCurrent(lease1), false);
  assert.equal(isAudioLeaseCurrent(lease2), true);

  assert.equal(changes.length, 2);
  assert.equal(changes[0].owner, 'atc');
  assert.equal(changes[0].previousOwner, null);
  assert.equal(changes[1].owner, 'radio');
  assert.equal(changes[1].previousOwner, 'atc');
  assert.equal(changes[1].displacedLease.id, lease1.id);

  unsubscribe();
});

test('claimAudio with preempt=false fails when already owned', () => {
  const lease1 = claimAudio('atc');
  const lease2 = claimAudio('radio', { preempt: false });
  assert.equal(lease2, null);
  assert.equal(audioOwner(), 'atc');
  assert.equal(isAudioLeaseCurrent(lease1), true);
});

test('empty or invalid owner strings are rejected', () => {
  assert.equal(claimAudio(''), null);
  assert.equal(claimAudio('   '), null);
  assert.equal(claimAudio(null), null);
  assert.equal(claimAudio(123), null);
  assert.equal(isAudioFree(), true);
});
