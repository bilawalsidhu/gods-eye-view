import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HUD_TARGET_LOCKED_EVENT,
  installLockSound,
  LOCK_SOUND_IDS,
  lockSoundUrl,
  selectedLockSound,
} from './lockSound.js';

function fakeWindow() {
  const listeners = new Map();
  return {
    addEventListener: (n, fn) => listeners.set(n, fn),
    removeEventListener: (n) => listeners.delete(n),
    fire: (n) => listeners.get(n)?.(),
    listeners,
  };
}

function fakeAudio(src) {
  return {
    src,
    plays: 0,
    paused: 0,
    currentTime: 0.2,
    play() {
      this.plays++;
      return Promise.reject(new Error('NotAllowedError'));
    },
    pause() {
      this.paused++;
    },
  };
}

test('the target sounds are none, hud-lock and sci-fi-click', () => {
  assert.deepEqual(LOCK_SOUND_IDS, ['none', 'hud-lock', 'sci-fi-click']);
});

test('clip URLs sit under the app base path', () => {
  assert.equal(lockSoundUrl('hud-lock', '/'), '/sounds/hud-lock.wav');
  assert.equal(
    lockSoundUrl('sci-fi-click', '/gev'),
    '/gev/sounds/sci-fi-click.wav',
  );
  assert.equal(lockSoundUrl('none', '/'), null);
});

test('the selection falls back to hud-lock', () => {
  const doc = { documentElement: { dataset: {} } };
  assert.equal(selectedLockSound(doc), 'hud-lock');
  doc.documentElement.dataset.hudLockSound = 'sci-fi-click';
  assert.equal(selectedLockSound(doc), 'sci-fi-click');
  doc.documentElement.dataset.hudLockSound = 'none';
  assert.equal(selectedLockSound(doc), 'none');
  doc.documentElement.dataset.hudLockSound = 'bogus';
  assert.equal(selectedLockSound(doc), 'hud-lock');
});

test('each lock restarts the selected clip, none is silent, uninstall detaches', () => {
  const win = fakeWindow();
  const audios = new Map();
  let soundId = 'hud-lock';
  const uninstall = installLockSound({
    win,
    urlFor: (id) => `/sounds/${id}.wav`,
    getSoundId: () => soundId,
    createAudio: (url) => {
      const audio = fakeAudio(url);
      audios.set(url, audio);
      return audio;
    },
  });
  const lock = audios.get('/sounds/hud-lock.wav');
  const click = audios.get('/sounds/sci-fi-click.wav');
  assert.equal(audios.size, 2, 'both clips preload');
  assert.equal(lock.preload, 'auto');
  assert.ok(lock.volume > 0 && lock.volume < 1);

  win.fire(HUD_TARGET_LOCKED_EVENT);
  assert.equal(lock.plays, 1);
  assert.equal(lock.currentTime, 0);

  soundId = 'sci-fi-click';
  win.fire(HUD_TARGET_LOCKED_EVENT);
  assert.equal(click.plays, 1);
  assert.equal(lock.plays, 1);
  assert.ok(lock.paused > 0, 'the other clip is stopped');

  soundId = 'none';
  win.fire(HUD_TARGET_LOCKED_EVENT);
  assert.equal(lock.plays + click.plays, 2, 'none is silent');

  uninstall();
  assert.equal(win.listeners.size, 0);
});

test('no audio support installs a no-op', () => {
  const win = fakeWindow();
  const uninstall = installLockSound({ win, createAudio: () => null });
  assert.equal(win.listeners.size, 0);
  uninstall();
});
