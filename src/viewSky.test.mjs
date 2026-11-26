import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bindRenderer } from './render/rendererOf.js';
import { createStubRenderer } from './render/stub/index.js';
import { createViewSky } from './viewSky.js';

function setup(saved = new Map()) {
  const renderer = createStubRenderer();
  const host = {};
  const unbind = bindRenderer(host, renderer);
  const published = [];
  const owners = [];
  const store = {
    publishSky: (view) => published.push(view),
    connect: (actions) => (owners.push(actions), actions),
    detach: (token) => owners.splice(owners.indexOf(token), 1),
  };
  const storage = {
    getItem: (k) => saved.get(k) ?? null,
    setItem: (k, v) => saved.set(k, v),
  };
  const act = (name, ...args) => owners.at(-1)?.[name](...args);
  const sky = createViewSky(host, { store, storage });
  return {
    renderer,
    published,
    owners,
    act,
    saved,
    sky,
    done() {
      sky.destroy();
      unbind();
      renderer.destroy();
    },
  };
}

test('the Sky group shows the renderer’s sky, untouched until the user sets it', () => {
  const s = setup();
  const before = s.renderer.globe.sky.get();
  const shown = s.published.at(-1);
  assert.equal(shown.switches.atmosphere, before.atmosphere);
  assert.equal(shown.switches.lighting, before.lighting);
  assert.equal(shown.milkyWay, Math.round(before.milkyWay * 100));
  assert.equal(s.saved.size, 0, 'nothing saved before a change');
  s.done();
});

test('a switch or the Milky Way slider sets the sky, shows it and is kept for the next visit', () => {
  const s = setup();
  s.act('setSkySwitch', 'lighting', true);
  s.act('setSkySwitch', 'stars', false);
  s.act('setSkyMilkyWay', 40);
  const sky = s.renderer.globe.sky.get();
  assert.equal(sky.lighting, true);
  assert.equal(sky.stars, false);
  assert.equal(sky.milkyWay, 0.4);
  const shown = s.published.at(-1);
  assert.equal(shown.switches.lighting, true);
  assert.equal(shown.switches.stars, false);
  assert.equal(shown.milkyWay, 40);
  s.act('setSkySwitch', 'fog', false);
  assert.equal(
    s.renderer.globe.sky.get().fog,
    sky.fog,
    'fog is not a panel switch',
  );
  s.act('setSkyMilkyWay', 'x');
  assert.equal(
    s.renderer.globe.sky.get().milkyWay,
    0.4,
    'a bad value changes nothing',
  );
  const saved = s.saved;
  s.done();

  const next = setup(saved);
  const again = next.renderer.globe.sky.get();
  assert.equal(again.lighting, true);
  assert.equal(again.stars, false);
  assert.equal(again.milkyWay, 0.4);
  next.done();
});

test('destroy hides the group and stops answering its controls', () => {
  const s = setup();
  s.done();
  assert.equal(s.published.at(-1), null);
  assert.equal(s.owners.length, 0);
});
