// src/ui/cockpitOrbital.test.mjs — the orbital view HUD shows what the
// Cockpit controller publishes to the store, over happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import { useCockpitStore } from './stores/cockpit.js';
import CockpitOrbital from './views/panels/CockpitOrbital.vue';

const VIEW = Object.freeze({
  name: 'ISS (ZARYA)',
  classLabel: 'STATION · ISS',
  altitudeM: 418_400,
  velocityMps: 7_662,
  latitude: 12.3456,
  longitude: -45.6789,
  zoom: 4,
  zoomSteps: [1, 2, 4, 8],
  footprintKm: 61.4,
  transition: { active: false, blurPx: 0, lockTick: false },
});

function fixture(t) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(CockpitOrbital).use(pinia);
  app.mount(host);
  t.after(() => app.unmount());
  const store = useCockpitStore(pinia);
  const section = () => document.getElementById('cockpit-orbital');
  const text = (selector) =>
    section().querySelector(selector)?.textContent.trim() ?? null;
  return { store, section, text };
}

test('the orbital HUD is hidden until a satellite view is published', async (t) => {
  const f = fixture(t);
  assert.equal(f.section().hidden, true);
  assert.equal(f.section().querySelector('#cockpit-orbital-zoom-in'), null);
});

test('a published orbital view renders its readouts and zoom controls', async (t) => {
  const f = fixture(t);
  f.store.publishOrbital({ ...VIEW });
  await nextTick();
  assert.equal(f.section().hidden, false);
  assert.equal(f.text('.cockpit-orbital-kicker'), 'ORBITAL VIEW · NADIR');
  assert.equal(f.text('.cockpit-orbital-name'), 'ISS (ZARYA)');
  assert.equal(f.text('.cockpit-orbital-class'), 'STATION · ISS');
  assert.equal(f.text('.cockpit-orbital-altitude'), '418 KM');
  assert.equal(f.text('.cockpit-orbital-velocity'), '7.66 KM/S');
  assert.match(f.text('.cockpit-orbital-subpoint'), /12\.346°N.*45\.679°W/);
  assert.equal(f.text('.cockpit-orbital-north'), 'NORTH UP');
  assert.equal(f.text('.cockpit-orbital-zoom'), 'ZOOM 4×');
  assert.equal(f.text('.cockpit-orbital-swath'), 'SWATH 61 KM');

  const zoomIn = document.getElementById('cockpit-orbital-zoom-in');
  const zoomOut = document.getElementById('cockpit-orbital-zoom-out');
  assert.equal(zoomIn.getAttribute('aria-label'), 'Zoom in');
  assert.equal(zoomOut.getAttribute('aria-label'), 'Zoom out');
  assert.equal(zoomIn.disabled, false);
  assert.equal(zoomOut.disabled, false);
  assert.ok(f.section().querySelector('.cockpit-orbital-reticle'));
});

test('zoom buttons stop at the ends of the zoom steps', async (t) => {
  const f = fixture(t);
  f.store.publishOrbital({ ...VIEW, zoom: 8, footprintKm: 7.25 });
  await nextTick();
  assert.equal(
    document.getElementById('cockpit-orbital-zoom-in').disabled,
    true,
  );
  assert.equal(f.text('.cockpit-orbital-swath'), 'SWATH 7.3 KM');
  f.store.publishOrbital({ ...VIEW, zoom: 1 });
  await nextTick();
  assert.equal(
    document.getElementById('cockpit-orbital-zoom-out').disabled,
    true,
  );
  assert.equal(
    document.getElementById('cockpit-orbital-zoom-in').disabled,
    false,
  );
});

test('an unknown velocity leaves its row out', async (t) => {
  const f = fixture(t);
  f.store.publishOrbital({ ...VIEW, velocityMps: null });
  await nextTick();
  assert.equal(f.section().querySelector('.cockpit-orbital-velocity'), null);
  assert.equal(f.text('.cockpit-orbital-altitude'), '418 KM');
});

test('a zoom step reflects its blur and lock tick', async (t) => {
  const f = fixture(t);
  f.store.publishOrbital({
    ...VIEW,
    transition: { active: true, blurPx: 4.5, lockTick: false },
  });
  await nextTick();
  assert.ok(f.section().classList.contains('cockpit-orbital-focusing'));
  assert.equal(
    f.section().style.getPropertyValue('--cockpit-orbital-blur'),
    '4.50px',
  );
  const reticle = f.section().querySelector('.cockpit-orbital-reticle');
  assert.equal(
    reticle.classList.contains('cockpit-orbital-reticle-lock'),
    false,
  );

  f.store.publishOrbital({
    ...VIEW,
    transition: { active: false, blurPx: 0, lockTick: true },
  });
  await nextTick();
  assert.ok(!f.section().classList.contains('cockpit-orbital-focusing'));
  assert.equal(
    f.section().style.getPropertyValue('--cockpit-orbital-blur'),
    '0px',
  );
  assert.ok(
    f
      .section()
      .querySelector('.cockpit-orbital-reticle')
      .classList.contains('cockpit-orbital-reticle-lock'),
  );
});

test('publishing null hides the orbital HUD again', async (t) => {
  const f = fixture(t);
  f.store.publishOrbital({ ...VIEW });
  await nextTick();
  assert.equal(f.section().hidden, false);
  f.store.publishOrbital(null);
  await nextTick();
  assert.equal(f.section().hidden, true);
  assert.equal(f.section().querySelector('.cockpit-orbital-name'), null);
});

const ISS_TLE = Object.freeze({
  line1:
    '1 25544U 98067A   26308.34166667  .00016717  00000-0  30306-3 0  9993',
  line2:
    '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.50377579477310',
  epochMs: Date.UTC(2026, 10, 4, 8, 12, 0),
});

test('the place below shows at the top once known', async (t) => {
  const f = fixture(t);
  f.store.publishOrbital({ ...VIEW, place: undefined });
  await nextTick();
  assert.equal(f.section().querySelector('#cockpit-orbital-over'), null);
  const over = () =>
    f.section().querySelector('#cockpit-orbital-over strong')?.textContent;
  f.store.publishOrbital({
    ...VIEW,
    place: { kind: 'country', name: 'France', countryCode: 'FR' },
  });
  await nextTick();
  assert.match(f.text('#cockpit-orbital-over'), /^CURRENTLY OVER/);
  assert.equal(over(), 'France');
  // The division as Natural Earth names it, the country localized.
  const sichuan = {
    kind: 'country',
    name: 'China',
    countryCode: 'CN',
    division: 'Sichuan',
    near: null,
  };
  f.store.publishOrbital({ ...VIEW, place: sichuan });
  await nextTick();
  assert.equal(over(), 'Sichuan, China');
  // From 8x, the populated place in view.
  f.store.publishOrbital({ ...VIEW, place: { ...sichuan, near: 'Chengdu' } });
  await nextTick();
  assert.equal(over(), 'Sichuan, China · near Chengdu');
  f.store.publishOrbital({
    ...VIEW,
    place: { kind: 'sea', name: 'Caspian Sea', countryCode: null },
  });
  await nextTick();
  assert.equal(over(), 'Caspian Sea');
  // No feature holds the point (a gap at a simplified coastline): the band
  // says nothing rather than call land open ocean.
  f.store.publishOrbital({ ...VIEW, place: null });
  await nextTick();
  assert.equal(document.querySelector('#cockpit-orbital-over'), null);
});

test('the readout names the owner, operator and element set', async (t) => {
  const f = fixture(t);
  f.store.publishOrbital({
    ...VIEW,
    noradId: 25544,
    cosparId: '1998-067A',
    tle: ISS_TLE,
    // Under node there is no flag glob, so a country shows as a badge.
    owner: { countryCode: 'US', label: 'USA' },
    operator: 'NASA',
  });
  await nextTick();
  assert.equal(f.text('.cockpit-orbital-name'), 'ISS (ZARYA)');
  assert.equal(f.text('.cockpit-orbital-owner-badge'), 'USA');
  assert.equal(
    f.section().querySelector('.cockpit-orbital-owner-badge').title,
    'United States',
  );
  assert.equal(f.text('.cockpit-orbital-operator'), 'NASA');
  assert.equal(
    f.text('.cockpit-orbital-ident-text'),
    'NORAD 25544 · 1998-067A · EPOCH 2026-11-04 08:12Z',
  );
  const toggle = document.getElementById('cockpit-orbital-tle-toggle');
  const tle = document.getElementById('cockpit-orbital-tle');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(tle.style.display, 'none', 'folded');
  toggle.click();
  await nextTick();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.notEqual(tle.style.display, 'none');
  assert.equal(tle.textContent, `${ISS_TLE.line1}\n${ISS_TLE.line2}`);
  // Another satellite starts folded.
  f.store.publishOrbital({ ...VIEW, noradId: 48274, tle: ISS_TLE });
  await nextTick();
  assert.equal(
    document
      .getElementById('cockpit-orbital-tle-toggle')
      .getAttribute('aria-expanded'),
    'false',
  );
});

test('unknown identity fields leave their rows out', async (t) => {
  const f = fixture(t);
  f.store.publishOrbital({
    ...VIEW,
    noradId: null,
    cosparId: null,
    tle: null,
    owner: null,
    operator: null,
  });
  await nextTick();
  for (const selector of [
    '.cockpit-orbital-flag',
    '.cockpit-orbital-owner-badge',
    '.cockpit-orbital-operator',
    '.cockpit-orbital-ident',
    '#cockpit-orbital-tle',
  ])
    assert.equal(f.section().querySelector(selector), null, selector);
  // An element set with no NORAD id still dates itself.
  f.store.publishOrbital({ ...VIEW, tle: ISS_TLE });
  await nextTick();
  assert.equal(
    f.text('.cockpit-orbital-ident-text'),
    'EPOCH 2026-11-04 08:12Z',
  );
});
