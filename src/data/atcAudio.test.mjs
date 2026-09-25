// src/data/atcAudio.test.mjs
// Gates on the ATC audio controller — above all, that it really does share the
// audio claim rather than talking over whatever else is playing.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ATC_AUDIO_STATE, createAtcAudio } from './atcAudio.js';
import {
  audioOwner,
  claimAudio,
  isAudioFree,
  resetAudioOwnership,
} from './audioOwnership.js';

/** A media element stand-in whose play() can be made to settle either way. */
function fakeAudio({ failWith = null, pending = false } = {}) {
  const element = {
    src: '',
    paused: true,
    calls: [],
    play() {
      element.calls.push('play');
      if (pending) return new Promise(() => {});
      if (failWith) return Promise.reject(failWith);
      element.paused = false;
      return Promise.resolve();
    },
    pause() {
      element.calls.push('pause');
      element.paused = true;
    },
    removeAttribute(name) {
      element.calls.push(`removeAttribute:${name}`);
      if (name === 'src') element.src = '';
    },
    load() {
      element.calls.push('load');
    },
  };
  return element;
}

const URL_A = 'https://sdr.example.org/kaus.mp3';
const URL_B = 'https://sdr.example.org/kden.mp3';

beforeEach(() => resetAudioOwnership());

test('playing takes the audio claim and reports playing', async () => {
  const element = fakeAudio();
  const atc = createAtcAudio({ createAudio: () => element });
  assert.deepEqual(atc.getState(), {
    state: ATC_AUDIO_STATE.IDLE,
    url: null,
    error: null,
  });
  assert.equal(await atc.play(URL_A), true);
  assert.equal(audioOwner(), 'atc', 'ATC must hold the claim while it plays');
  assert.deepEqual(atc.getState(), {
    state: ATC_AUDIO_STATE.PLAYING,
    url: URL_A,
    error: null,
  });
  assert.equal(element.src, URL_A);
});

test('stopping gives the claim back so the next producer is not preempting', async () => {
  const atc = createAtcAudio({ createAudio: () => fakeAudio() });
  await atc.play(URL_A);
  atc.stop();
  assert.equal(isAudioFree(), true);
  assert.deepEqual(atc.getState(), {
    state: ATC_AUDIO_STATE.IDLE,
    url: null,
    error: null,
  });
});

test('ATC starting stops whatever was already playing', async () => {
  // The whole reason the claim exists. Without it the radio and ATC talk over
  // each other and the issue's "one audio source at a time" is a comment.
  let radioStopped = 0;
  claimAudio('radio', {
    onRevoked: () => {
      radioStopped += 1;
    },
  });
  const atc = createAtcAudio({ createAudio: () => fakeAudio() });
  await atc.play(URL_A);
  assert.equal(radioStopped, 1);
  assert.equal(audioOwner(), 'atc');
});

test('something else starting stops ATC, without ATC having to watch for it', async () => {
  const element = fakeAudio();
  const atc = createAtcAudio({ createAudio: () => element });
  await atc.play(URL_A);
  claimAudio('radio');
  assert.equal(atc.getState().state, ATC_AUDIO_STATE.IDLE);
  assert.equal(atc.getState().url, null);
  assert.ok(
    element.calls.includes('pause'),
    'the element must actually be silenced',
  );
  assert.equal(audioOwner(), 'radio', 'and ATC must not have taken it back');
});

test('a revoked ATC does not free the claim its successor now holds', async () => {
  // The trap: ATC is revoked, then its teardown runs and calls releaseAudio
  // with the lease it still remembers. That lease is stale, and freeing on it
  // would leave the radio audible with the module reporting nobody playing.
  const atc = createAtcAudio({ createAudio: () => fakeAudio() });
  await atc.play(URL_A);
  claimAudio('radio');
  atc.stop();
  assert.equal(audioOwner(), 'radio', 'the radio keeps the audio it took');
});

test('changing stream renews the claim instead of revoking itself', async () => {
  // A plain re-claim fires ATC's own onRevoked in the middle of the start it
  // is performing. The reported state recovers — the assignments after the
  // claim overwrite what the callback cleared — so the damage is only visible
  // on the ELEMENT: the callback tears it down (pause, drop src, load)
  // between the two plays, for no reason, on every station change.
  const element = fakeAudio();
  const atc = createAtcAudio({ createAudio: () => element });
  await atc.play(URL_A);
  const before = element.calls.length;
  assert.equal(await atc.play(URL_B), true);
  const during = element.calls.slice(before);
  assert.deepEqual(
    during,
    ['play'],
    `changing stream must not tear the element down first, got ${during.join()}`,
  );
  assert.deepEqual(atc.getState(), {
    state: ATC_AUDIO_STATE.PLAYING,
    url: URL_B,
    error: null,
  });
  assert.equal(audioOwner(), 'atc');
});

test('a rejected play reports a reason and leaves nothing playing', async () => {
  const element = fakeAudio({ failWith: new Error('404') });
  const atc = createAtcAudio({ createAudio: () => element });
  assert.equal(await atc.play(URL_A), false);
  assert.equal(atc.getState().state, ATC_AUDIO_STATE.ERROR);
  assert.match(atc.getState().error, /would not play/);
  assert.ok(element.calls.includes('pause'));
});

test('autoplay refusal is named as itself, not as a broken stream', async () => {
  // NotAllowedError means the browser wants a user gesture. Telling the viewer
  // their stream is broken would send them to fix the wrong thing.
  const blocked = Object.assign(new Error('blocked'), {
    name: 'NotAllowedError',
  });
  const atc = createAtcAudio({
    createAudio: () => fakeAudio({ failWith: blocked }),
  });
  await atc.play(URL_A);
  assert.match(atc.getState().error, /interact with the page/);
});

test('a superseded play cannot stamp its outcome over the one that replaced it', async () => {
  // Same controller, two overlapping starts: the viewer switches stream while
  // the first is still connecting. The first settles LAST, and must not write
  // PLAYING with the old url — or ERROR — over the stream that is now live.
  const settle = [];
  const element = fakeAudio();
  element.play = () => {
    element.calls.push('play');
    return new Promise((resolve, reject) => settle.push({ resolve, reject }));
  };
  const atc = createAtcAudio({ createAudio: () => element });

  const first = atc.play(URL_A);
  const second = atc.play(URL_B);
  assert.equal(settle.length, 2, 'both attempts are in flight');

  settle[1].resolve();
  assert.equal(await second, true);
  assert.deepEqual(atc.getState(), {
    state: ATC_AUDIO_STATE.PLAYING,
    url: URL_B,
    error: null,
  });

  // Now the abandoned first attempt finishes — successfully, which is the
  // dangerous case: without the generation check it would report PLAYING and
  // leave the panel naming a stream that is not the one in the element.
  settle[0].resolve();
  assert.equal(
    await first,
    false,
    'a superseded attempt must not claim success',
  );
  assert.deepEqual(atc.getState(), {
    state: ATC_AUDIO_STATE.PLAYING,
    url: URL_B,
    error: null,
  });
});

test('a superseded play that FAILS cannot silence the stream that replaced it', async () => {
  const settle = [];
  const element = fakeAudio();
  element.play = () => {
    element.calls.push('play');
    return new Promise((resolve, reject) => settle.push({ resolve, reject }));
  };
  const atc = createAtcAudio({ createAudio: () => element });
  const first = atc.play(URL_A);
  const second = atc.play(URL_B);
  settle[1].resolve();
  await second;
  settle[0].reject(new Error('404'));
  assert.equal(await first, false);
  assert.equal(atc.getState().state, ATC_AUDIO_STATE.PLAYING);
  assert.equal(
    atc.getState().error,
    null,
    'the dead attempt must not post an error',
  );
  assert.equal(audioOwner(), 'atc');
});

test('a stop mid-flight wins over the play it interrupted', async () => {
  let resolvePlay;
  const element = fakeAudio();
  element.play = () => {
    element.calls.push('play');
    return new Promise((resolve) => {
      resolvePlay = resolve;
    });
  };
  const atc = createAtcAudio({ createAudio: () => element });
  const started = atc.play(URL_A);
  atc.stop();
  resolvePlay();
  assert.equal(
    await started,
    false,
    'the interrupted play must not claim success',
  );
  assert.equal(atc.getState().state, ATC_AUDIO_STATE.IDLE);
  assert.equal(isAudioFree(), true);
});

test('an empty url is refused without taking the claim', async () => {
  const atc = createAtcAudio({ createAudio: () => fakeAudio() });
  for (const empty of ['', '   ', null, undefined]) {
    assert.equal(await atc.play(empty), false);
    assert.equal(atc.getState().state, ATC_AUDIO_STATE.ERROR);
    assert.equal(isAudioFree(), true, 'a refused play must not hold the audio');
  }
});

test('no Audio constructor is an error, not a crash', async () => {
  const atc = createAtcAudio({ createAudio: () => null });
  assert.equal(await atc.play(URL_A), false);
  assert.match(atc.getState().error, /not available/);
});

test('subscribers see every transition, and a broken one does not silence the rest', async () => {
  const atc = createAtcAudio({ createAudio: () => fakeAudio() });
  const seen = [];
  const unsubscribe = atc.subscribe(() => {
    throw new Error('subscriber exploded');
  });
  atc.subscribe((value) => seen.push(value.state));
  await atc.play(URL_A);
  atc.stop();
  assert.deepEqual(seen, [
    ATC_AUDIO_STATE.LOADING,
    ATC_AUDIO_STATE.PLAYING,
    ATC_AUDIO_STATE.IDLE,
  ]);
  unsubscribe();
  await atc.play(URL_A);
  assert.equal(seen.at(-1), ATC_AUDIO_STATE.PLAYING);
  assert.equal(atc.subscribe('not a function')(), undefined);
});

test('destroy releases the audio and forgets its subscribers', async () => {
  const atc = createAtcAudio({ createAudio: () => fakeAudio() });
  const seen = [];
  atc.subscribe((value) => seen.push(value.state));
  await atc.play(URL_A);
  const before = seen.length;
  atc.destroy();
  assert.equal(isAudioFree(), true);
  assert.equal(
    seen.length,
    before + 1,
    'the idle transition is still delivered',
  );
  await atc.play(URL_A);
  assert.equal(seen.length, before + 1, 'and nothing after destroy is');
});
