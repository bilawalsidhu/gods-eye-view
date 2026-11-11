import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhotoSlots } from './photos.js';

function clock() {
  let time = 0;
  let next = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(fn, delay) {
      const id = ++next;
      timers.set(id, { fn, at: time + delay });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    tick(ms) {
      const until = time + ms;
      while (true) {
        const pending = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!pending || pending[1].at > until) break;
        time = pending[1].at;
        timers.delete(pending[0]);
        pending[1].fn();
      }
      time = until;
    },
    count: () => timers.size,
  };
}

const row = (index) => ({
  stableId: `inat:${index}`,
  quality: 'research',
  observedAt: 0,
  favesCount: 100 - index,
  identificationAgreements: 0,
  photo: {
    square: `https://inaturalist-open-data.s3.amazonaws.com/photos/${index}/square.jpg`,
    medium: `https://inaturalist-open-data.s3.amazonaws.com/photos/${index}/medium.jpg`,
    licence: 'cc-by',
    attribution: '(c) Synthetic Photographer',
  },
});

function harness() {
  const time = clock();
  const launches = [];
  const images = [];
  let changes = 0;
  const slots = createPhotoSlots({
    ...time,
    onChange: () => changes++,
    imageFactory: () => {
      const image = {
        set src(url) {
          this.url = url;
          if (url) launches.push({ at: time.now(), url });
        },
      };
      images.push(image);
      return image;
    },
  });
  return { slots, time, images, launches, changes: () => changes };
}

test('24 photos start in rank order: eight immediately, then one per 250 ms', () => {
  const h = harness();
  const rows = Array.from({ length: 24 }, (_, index) => row(index + 1));
  h.slots.setAmbient([...rows].reverse());
  assert.equal(h.launches.length, 8);
  h.time.tick(249);
  assert.equal(h.launches.length, 8);
  h.time.tick(1);
  assert.equal(h.launches.length, 9);
  h.time.tick(3750);
  assert.equal(h.launches.length, 24);
  assert.deepEqual(
    h.launches.map(({ url }) => Number(url.match(/photos\/(\d+)/)[1])),
    rows.map((_, index) => index + 1),
  );
  assert.deepEqual(
    h.launches.slice(8).map(({ at }) => at),
    Array.from({ length: 16 }, (_, i) => (i + 1) * 250),
  );
  h.slots.destroy();
});

test('same-cohort refresh keeps the ambient queue pacing without restarting its burst', () => {
  const h = harness();
  const rows = Array.from({ length: 24 }, (_, i) => row(i + 1));
  h.slots.setAmbient(rows);
  assert.equal(h.launches.length, 8);
  h.time.tick(100);
  h.slots.setAmbient(rows);
  assert.equal(h.launches.length, 8);
  h.time.tick(150);
  assert.equal(h.launches.length, 9);
  assert.ok(h.launches.every(({ url }) => /square.jpg$/.test(url)));
  h.slots.destroy();
});

test('images settle through slots, are pruned to 96, and late loads cannot publish after clear', () => {
  const h = harness();
  h.slots.setAmbient([row(1)]);
  const loaded = h.images[0];
  loaded.onload();
  assert.equal(h.slots.get(row(1)), loaded);
  assert.equal(h.changes(), 1);
  for (let index = 2; index <= 130; index++) h.slots.setAmbient([row(index)]);
  assert.equal(h.slots.diagnostics().slots, 96);
  const last = h.images.at(-1);
  const late = last.onload;
  h.slots.clear();
  late();
  assert.equal(h.changes(), 1);
  assert.equal(h.slots.diagnostics().slots, 0);
  assert.equal(h.time.count(), 0);
  assert.ok(h.images.every((image) => image.url === ''));
});

test('returning cards reuse their decoded frame after a pan or height-band hide', () => {
  const h = harness();
  const first = row(1);
  h.slots.setAmbient([first]);
  const frame = h.images[0];
  frame.onload();
  assert.equal(h.slots.get(first), frame);
  h.slots.setAmbient([]);
  h.slots.setAmbient([row(2)]);
  h.images[1].onload();
  for (let index = 3; index < 105; index++) h.slots.setAmbient([row(index)]);
  h.slots.setAmbient([first]);
  assert.equal(
    h.slots.get(first),
    frame,
    'the returning image is already ready, with no empty frame',
  );
  assert.equal(
    h.launches.filter(({ url }) => url.includes('/photos/1/')).length,
    1,
  );
  h.slots.destroy();
});
