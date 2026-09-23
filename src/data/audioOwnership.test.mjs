// src/data/audioOwnership.test.mjs
// Gates on the single audio claim: who is making sound, and what happens to
// the producer that was.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  audioOwner,
  claimAudio,
  isAudioFree,
  isAudioLeaseCurrent,
  isAudioOwnedBy,
  releaseAudio,
  resetAudioOwnership,
} from './audioOwnership.js';

beforeEach(() => resetAudioOwnership());

test('a claim names its owner and a release gives it back', () => {
  assert.equal(isAudioFree(), true);
  assert.equal(audioOwner(), null);
  const lease = claimAudio('radio');
  assert.ok(lease);
  assert.equal(audioOwner(), 'radio');
  assert.equal(isAudioOwnedBy('radio'), true);
  assert.equal(isAudioOwnedBy('atc'), false);
  assert.equal(isAudioFree(), false);
  assert.equal(releaseAudio(lease), true);
  assert.equal(isAudioFree(), true);
  assert.equal(releaseAudio(lease), false, 'releasing twice frees nothing');
});

test('an unusable owner name is refused rather than taking the audio anonymously', () => {
  for (const bad of ['', '   ', null, undefined, 42, {}]) {
    assert.equal(claimAudio(bad), null, `${String(bad)} must not claim`);
    assert.equal(isAudioFree(), true);
  }
});

test('a later claim takes the audio and tells the incumbent to stop', () => {
  // The rule that separates this from inputOwnership: the pointer claim is
  // REFUSED while held, the audio claim preempts. Two soundtracks at once is
  // worse than either one alone, and the thing the user just asked for is the
  // thing that should be audible.
  const stopped = [];
  const radio = claimAudio('radio', { onRevoked: () => stopped.push('radio') });
  const atc = claimAudio('atc', { onRevoked: () => stopped.push('atc') });
  assert.ok(atc, 'the second claim must succeed');
  assert.equal(audioOwner(), 'atc');
  assert.deepEqual(
    stopped,
    ['radio'],
    'the incumbent is told, the newcomer is not',
  );
  assert.equal(isAudioLeaseCurrent(radio), false);
  assert.equal(isAudioLeaseCurrent(atc), true);
});

test('a revoked producer cannot silence the one that replaced it', () => {
  // The failure this prevents: radio is revoked, its teardown runs a beat
  // later and calls releaseAudio with the lease it still holds. Without the
  // lease identity check that frees ATC's claim, and the next thing to ask
  // "is anyone playing?" is told no while ATC is audible.
  const radio = claimAudio('radio');
  const atc = claimAudio('atc');
  assert.equal(releaseAudio(radio), false, 'a stale lease frees nothing');
  assert.equal(audioOwner(), 'atc');
  assert.equal(releaseAudio(atc), true);
});

test('two live instances of one producer are two owners', () => {
  // An old instance mid-teardown and its replacement already running are not
  // the same owner just because they share a name — the lease is what tells
  // them apart.
  const first = claimAudio('radio');
  const second = claimAudio('radio');
  assert.notEqual(first.id, second.id);
  assert.equal(isAudioLeaseCurrent(first), false);
  assert.equal(releaseAudio(first), false);
  assert.equal(audioOwner(), 'radio', 'the successor still holds it');
});

test('a voluntary release does not revoke — nobody tells a producer it stopped', () => {
  let revocations = 0;
  const lease = claimAudio('radio', {
    onRevoked: () => {
      revocations += 1;
    },
  });
  releaseAudio(lease);
  assert.equal(revocations, 0);
  // ...and claiming into a FREE slot revokes nothing either, so the previous
  // owner's callback cannot fire late against a claim it never lost.
  claimAudio('atc');
  assert.equal(revocations, 0);
});

test('a revocation callback fires at most once', () => {
  let revocations = 0;
  claimAudio('radio', {
    onRevoked: () => {
      revocations += 1;
    },
  });
  claimAudio('atc');
  claimAudio('cctv');
  claimAudio('voice');
  assert.equal(
    revocations,
    1,
    'radio is only revoked the one time it loses the claim',
  );
});

test('the callback sees the finished state, not a half-swapped one', () => {
  // Installing the new owner before revoking means a callback that asks who
  // owns the audio gets the truth — and one that tries to release sees its own
  // lease is already stale. A revoke-then-install order would let the
  // incumbent's cleanup free its successor's brand-new claim.
  let seenOwner = 'unset';
  let selfReleaseWorked = 'unset';
  const radio = claimAudio('radio', {
    onRevoked: () => {
      seenOwner = audioOwner();
      selfReleaseWorked = releaseAudio(radio);
    },
  });
  claimAudio('atc');
  assert.equal(seenOwner, 'atc');
  assert.equal(selfReleaseWorked, false);
  assert.equal(
    audioOwner(),
    'atc',
    'the new owner survives the old one cleaning up',
  );
});

test('a producer that claims from inside its own revocation does not lose the audio', () => {
  // A plausible reentrancy: a producer told to stop decides to restart itself.
  // The claim it makes inside the callback must be the one that stands, not be
  // overwritten by the outer call finishing.
  const radio = claimAudio('radio', {
    onRevoked: () => {
      claimAudio('radio-restarted');
    },
  });
  assert.ok(radio);
  const atc = claimAudio('atc');
  assert.equal(audioOwner(), 'radio-restarted');
  // ATC gets back the lease ITS call issued, which is already stale — not the
  // live one. Handing it the live lease would let ATC's own teardown release
  // a claim it never held and silence the restarted radio.
  assert.equal(atc.owner, 'atc');
  assert.equal(isAudioLeaseCurrent(atc), false);
  assert.equal(releaseAudio(atc), false);
  assert.equal(audioOwner(), 'radio-restarted');
});

test('a callback that throws does not stop the new sound from starting', () => {
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    claimAudio('radio', {
      onRevoked: () => {
        throw new Error('teardown exploded');
      },
    });
    const atc = claimAudio('atc');
    assert.ok(atc, 'the new claim must survive a broken incumbent');
    assert.equal(audioOwner(), 'atc');
    assert.equal(
      warnings.length,
      1,
      'and the failure is reported, not swallowed silently',
    );
  } finally {
    console.warn = warn;
  }
});

test('resetAudioOwnership drops the claim without calling back into a disposed producer', () => {
  // Teardown reaches a half-disposed producer; calling its stop path there is
  // how you get an error thrown out of application shutdown.
  let revocations = 0;
  claimAudio('radio', {
    onRevoked: () => {
      revocations += 1;
    },
  });
  assert.equal(resetAudioOwnership(), 'radio');
  assert.equal(revocations, 0);
  assert.equal(isAudioFree(), true);
  assert.equal(resetAudioOwnership(), null);
});

test('isAudioLeaseCurrent rejects junk instead of guessing', () => {
  const lease = claimAudio('radio');
  assert.equal(isAudioLeaseCurrent(lease), true);
  for (const junk of [null, undefined, {}, { id: lease.id + 1 }, 'lease']) {
    assert.equal(isAudioLeaseCurrent(junk), false);
  }
  // A forged object carrying the live id is accepted — the lease is a token,
  // not a capability check against a hostile caller. Pinned so the boundary is
  // a decision rather than an accident.
  assert.equal(isAudioLeaseCurrent({ id: lease.id }), true);
});

test('the holder changing what it plays renews instead of revoking itself', () => {
  // The footgun this closes: Radio is playing station A and the user picks
  // station B. Radio claims again — and without `renew` its OWN onRevoked
  // fires and stops the playback it is starting. A producer cannot be expected
  // to notice it is arguing with itself.
  let selfStops = 0;
  const stop = () => {
    selfStops += 1;
  };
  const first = claimAudio('radio', { onRevoked: stop });
  const second = claimAudio('radio', { onRevoked: stop, renew: first });
  assert.equal(selfStops, 0, 'renewing must not revoke the renewer');
  assert.equal(audioOwner(), 'radio');
  // A fresh lease all the same: the previous attempt's queued teardown must
  // not be able to free the claim the new attempt now holds.
  assert.notEqual(second.id, first.id);
  assert.equal(releaseAudio(first), false);
  assert.equal(isAudioLeaseCurrent(second), true);
  // ...and renewing has not cost the producer its revocation: someone else
  // taking over still stops it.
  claimAudio('atc');
  assert.equal(selfStops, 1);
});

test('a stale lease cannot be used to renew past a takeover', () => {
  // Radio loses the audio to ATC, then a late continuation of its old play
  // attempt claims with `renew: staleLease`. That is a takeover, not a
  // renewal, so ATC must be told it lost the audio rather than silently
  // sharing it.
  let atcStops = 0;
  const radio = claimAudio('radio');
  claimAudio('atc', {
    onRevoked: () => {
      atcStops += 1;
    },
  });
  claimAudio('radio', { renew: radio });
  assert.equal(
    atcStops,
    1,
    'ATC must be revoked, not bypassed by a stale renewal',
  );
  assert.equal(audioOwner(), 'radio');
});
