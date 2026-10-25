import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAudioVisualizer,
  frequencyBands,
  frequencyPosition,
  rmsDecibels,
} from './audioVisualizer.js';
import {
  createRadioAudioSource,
  radioVisualizerMode,
  radioVisualizerState,
} from './radioAudioSource.js';

function fakeElement() {
  return {
    hidden: false,
    dataset: {},
    style: {},
    textContent: '',
    children: [],
    removed: false,
    setAttribute() {},
    appendChild(child) {
      this.children.push(child);
    },
    remove() {
      this.removed = true;
    },
  };
}

function fakeDom() {
  const parts = new Map();
  const documentRef = {
    createElement() {
      const element = fakeElement();
      element.querySelector = (selector) => {
        if (!parts.has(selector)) parts.set(selector, fakeElement());
        return parts.get(selector);
      };
      return element;
    },
  };
  const frames = { next: 1, pending: new Set(), cancelled: [] };
  const windowRef = {
    devicePixelRatio: 1,
    requestAnimationFrame() {
      const id = frames.next++;
      frames.pending.add(id);
      return id;
    },
    cancelAnimationFrame(id) {
      frames.pending.delete(id);
      frames.cancelled.push(id);
    },
  };
  return { documentRef, windowRef, parts, frames };
}

test('frequency helpers map a log axis, average bands and measure RMS', () => {
  assert.equal(frequencyPosition(40), 0);
  assert.equal(frequencyPosition(16000), 1);
  assert.equal(frequencyPosition(5), 0);
  assert.ok(frequencyPosition(1000) > 0.5 && frequencyPosition(1000) < 0.6);

  const full = frequencyBands(new Uint8Array(1024).fill(255), 48000, 8);
  assert.equal(full.length, 8);
  assert.ok(full.every((value) => value === 1));
  assert.ok(frequencyBands(new Uint8Array(1024), 48000).every((v) => v === 0));

  assert.equal(rmsDecibels(new Uint8Array(64).fill(128)), -Infinity);
  const square = Uint8Array.from({ length: 64 }, (_, i) => (i % 2 ? 0 : 255));
  assert.ok(Math.abs(rmsDecibels(square)) < 0.1);
});

test('Radio adapter reports live, opaque, acquiring and hidden states', () => {
  const station = { id: 's1', name: 'KUT 90.5' };
  const base = {
    enabled: true,
    playingStationId: 's1',
    selected: station,
    audioState: 'playing',
    audioReadable: true,
  };
  assert.equal(radioVisualizerMode(base), 'live');
  assert.equal(
    radioVisualizerMode({ ...base, audioReadable: false }),
    'opaque',
  );
  assert.equal(
    radioVisualizerMode({ ...base, audioState: 'loading' }),
    'acquiring',
  );
  assert.equal(
    radioVisualizerMode({ ...base, audioState: 'paused' }),
    'hidden',
  );
  assert.equal(radioVisualizerMode({ ...base, enabled: false }), 'hidden');
  assert.equal(
    radioVisualizerMode({ ...base, playingStationId: null }),
    'hidden',
  );
  assert.equal(radioVisualizerState(base).label, 'KUT 90.5');
  assert.equal(
    radioVisualizerState({ ...base, selected: { id: 's2', name: 'Other' } })
      .label,
    '',
    'a browsed station is not labelled as the playing one',
  );

  let radioListener = null;
  const analyser = {};
  const source = createRadioAudioSource({
    subscribe(listener) {
      radioListener = listener;
      return () => {};
    },
    getAnalyser: () => analyser,
  });
  const seen = [];
  source.subscribe((state) => seen.push(state.mode));
  radioListener(base);
  assert.deepEqual(seen, ['live']);
  assert.equal(source.getAnalyser(), analyser);
});

test('visualizer follows its source and tears down cleanly', () => {
  const { documentRef, windowRef, parts, frames } = fakeDom();
  const host = fakeElement();
  let listener = null;
  let unsubscribed = false;
  const visualizer = createAudioVisualizer({
    source: {
      subscribe(next) {
        listener = next;
        return () => {
          unsubscribed = true;
        };
      },
      getAnalyser: () => null,
    },
    host,
    documentRef,
    windowRef,
  });
  const root = host.children[0];
  assert.ok(root, 'mounted into the host');

  listener({ mode: 'hidden' });
  assert.equal(root.hidden, true);
  assert.equal(frames.pending.size, 0, 'no animation while hidden');

  listener({ mode: 'opaque', label: 'Station', notice: 'BLOCKED' });
  assert.equal(root.hidden, false);
  assert.equal(root.dataset.mode, 'opaque');
  assert.equal(parts.get('.hud-audio-viz__label').textContent, 'Station');
  assert.equal(parts.get('.hud-audio-viz__notice').textContent, 'BLOCKED');
  assert.equal(parts.get('.hud-audio-viz__status').textContent, 'NO SIGNAL');
  assert.equal(frames.pending.size, 1);

  listener({ mode: 'live' });
  assert.equal(frames.pending.size, 1, 'one animation loop at a time');
  assert.equal(parts.get('.hud-audio-viz__status').textContent, 'LIVE');

  listener({ mode: 'bogus' });
  assert.equal(root.hidden, true, 'unknown modes hide the panel');

  visualizer.destroy();
  assert.equal(unsubscribed, true);
  assert.equal(root.removed, true);
  assert.equal(frames.pending.size, 0);
});

test('visualizer is inert without a host or source', () => {
  assert.doesNotThrow(() => createAudioVisualizer({ host: null }).destroy());
  assert.doesNotThrow(() =>
    createAudioVisualizer({ source: null, host: fakeElement() }).destroy(),
  );
});
