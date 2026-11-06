import '../testSupport/registerDom.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { nextTick } from 'vue';
import { readFileSync } from 'node:fs';
import { getLocale, setLocale, t } from '../i18n/index.js';
import { LOCALES } from '../i18n/locale.js';
import { createSelection } from '../layers/wildlifeSightings/selection.js';
import { buildWildlifeThumbnailEntry } from '../layers/wildlifeSightings/cards.js';
import { createWildlifeSightingCard } from './wildlifeSightingCard.js';
import {
  panWildlifeSighting,
  placeWildlifeSightingCard,
  readWildlifeCardSafeArea,
} from './wildlifeSightingPlacement.js';
import { createUiRuntime } from './vueRuntime.js';
import { PANEL_RAIL_ITEMS } from './panelRailCatalog.js';
import { sheetForPanelId } from './mobileShell.js';

const NOW = Date.parse('2026-11-04T13:00:00Z');
const square =
  'https://inaturalist-open-data.s3.amazonaws.com/photos/456/square.jpg';
const row = {
  stableId: 'inat:456',
  origin: 'inaturalist',
  lat: 0,
  lon: 0,
  commonName: 'Synthetic bird',
  scientificName: 'Avis imaginaria',
  iconic: 'Aves',
  observedAt: NOW - 3_600_000,
  observedOn: '2026-11-04',
  obscured: false,
  photo: {
    square,
    attribution: '(c) Synthetic Photographer, some rights reserved (CC BY-SA)',
    licence: 'cc-by-sa',
  },
  link: 'https://www.inaturalist.org/observations/456',
};
const rect = (left, top, width, height) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});
const events = () => {
  const listeners = new Set();
  return {
    addEventListener(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit() {
      for (const fn of listeners) fn();
    },
    size: () => listeners.size,
  };
};
const settle = async () => {
  await nextTick();
  await Promise.resolve();
  await nextTick();
};

// All scene rows, media events and rectangles are synthetic. Browser image
// requests are disabled; decode resolution below proves the photo is exposed
// only after it has loaded into the compact card.
function fixture(
  context,
  initialRow = row,
  point = { x: 600, y: 450 },
  extraWindow = {},
) {
  document.body.replaceChildren();
  const opener = document.body.appendChild(document.createElement('button'));
  opener.textContent = 'Globe';
  opener.focus();
  const canvas = document.body.appendChild(document.createElement('canvas'));
  canvas.getBoundingClientRect = () => rect(0, 0, 1200, 900);
  const windowRef = {
    innerWidth: 1200,
    innerHeight: 900,
    getComputedStyle: window.getComputedStyle.bind(window),
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false }),
    ...extraWindow,
  };
  const ui = createUiRuntime();
  const overlays = new Map();
  const moveStart = events();
  const moveEnd = events();
  const changed = events();
  const preRender = events();
  const viewer = {
    scene: { canvas, preRender, pick: () => picked },
    camera: { moveStart, moveEnd, changed },
  };
  const state = {
    enabled: true,
    destroyed: false,
    selectedId: null,
    selectedRow: null,
    ambientRows: [],
    rowById: new Map([[initialRow.stableId, initialRow]]),
    positions: new Map([[initialRow.stableId, { x: 1, y: 2, z: 3 }]]),
    contextIds: new Set(),
    viewer,
  };
  let picked = null;
  let hit = null;
  let onClick;
  let clears = 0;
  let staleListener;
  const subscriptions = new Set();
  const flights = [];
  const pans = [];
  const selection = createSelection({
    state,
    services: {
      now: () => NOW,
      cesium: { ScreenSpaceEventType: { LEFT_CLICK: 0 } },
      overlayHost: {
        setEntries: (id, entries) => overlays.set(id, entries),
        hitTest: (_x, _y, { sourceId }) =>
          hit?.sourceId === sourceId ? hit : null,
      },
      screenSpaceEventHandlerFactory: () => ({
        setInputAction(fn) {
          onClick = fn;
        },
        destroy() {},
      }),
      focus: { requestWorldFocus: (value) => flights.push(value) },
    },
    parts: {
      rendering: { refreshSelection() {}, requestRender() {} },
    },
  });
  const layer = {
    getParams: () => ({ taxa: 'all' }),
    subscribeSelection(listener) {
      staleListener = listener;
      subscriptions.add(listener);
      const off = selection.subscribe(listener);
      return () => {
        subscriptions.delete(listener);
        off();
      };
    },
    clearSightingSelection() {
      clears++;
      selection.clearAndRebuild();
    },
  };
  let currentPoint = point;
  let projections = 0;
  const card = createWildlifeSightingCard({
    layer,
    ui,
    viewer,
    documentRef: document,
    windowRef,
    now: () => NOW,
    project: () => {
      projections++;
      return currentPoint;
    },
    pan: (_viewer, from, to, reduced) => {
      pans.push({ from, to, reduced });
      currentPoint = to;
      return true;
    },
  });
  selection.install();
  context.after(() => {
    card.destroy();
    selection.destroy();
    ui.destroy();
  });
  return {
    state,
    selection,
    layer,
    card,
    viewer,
    windowRef,
    overlays,
    flights,
    pans,
    projections: () => projections,
    subscriptions,
    opener,
    canvas,
    moveStart,
    moveEnd,
    preRender,
    cardElement: () => document.querySelector('[data-wildlife-sighting-card]'),
    host: () => document.querySelector('[data-wildlife-sighting-card-host]'),
    staleListener: () => staleListener,
    clears: () => clears,
    async click(kind = 'dot', target = initialRow) {
      picked =
        kind === 'icon'
          ? { primitive: { id: `wildlife:${target.stableId}` } }
          : { id: `wildlife:${target.stableId}` };
      hit =
        kind === 'ambient photo card'
          ? {
              sourceId: 'wildlife-sightings',
              entry: buildWildlifeThumbnailEntry(target, NOW, {
                select: selection.selectAndFocus,
              }),
            }
          : null;
      onClick({ position: { x: 50, y: 50 } });
      await settle();
    },
    async publish(next) {
      if (next) {
        state.rowById.set(next.stableId, next);
        if (state.selectedId === next.stableId) state.selectedRow = next;
      }
      selection.notify();
      await settle();
    },
    obstacle(selector, bounds) {
      const element = document.body.appendChild(document.createElement('div'));
      if (selector.startsWith('#')) element.id = selector.slice(1);
      else element.className = selector.slice(1);
      element.getBoundingClientRect = () => bounds;
      return element;
    },
    setPoint(next) {
      currentPoint = next;
    },
  };
}

test('dot, icon and ambient photo clicks open one contained medium-photo card at the sighting', async (context) => {
  for (const kind of ['dot', 'icon', 'ambient photo card'])
    await context.test(kind, async (context) => {
      const f = fixture(context);
      await f.click(kind);
      const card = f.cardElement();
      const image = card.querySelector('img');
      assert.equal(f.state.selectedId, row.stableId);
      assert.equal(
        document.querySelector('dialog'),
        null,
        'there is no fullscreen or modal dialog',
      );
      assert.equal(image.src, square.replace('/square.', '/medium.'));
      assert.equal(image.referrerPolicy, 'no-referrer');
      assert.equal(card.querySelector('h2').textContent, row.commonName);
      assert.equal(card.querySelector('i').textContent, row.scientificName);
      assert.equal(card.querySelector('time').textContent, 'observed 1h ago');
      assert.ok(
        card.textContent.includes('© Synthetic Photographer · CC BY-SA'),
      );
      const link = card.querySelector('a');
      assert.equal(link.href, row.link);
      assert.equal(link.target, '_blank');
      assert.equal(link.rel, 'noopener noreferrer');
      assert.equal(
        link.getAttribute('aria-label'),
        `Open ${row.commonName} on iNaturalist`,
      );
      assert.equal(
        link.querySelector('.wildlife-sighting-card-source').textContent,
        'iNaturalist ↗',
      );
      assert.ok(
        link.contains(image),
        'the photograph and text are one external action',
      );
      assert.equal(f.flights.length, 1);
      assert.equal(f.flights[0].kind, 'sighting');
      assert.deepEqual(
        f.flights[0].position,
        f.state.positions.get(row.stableId),
      );
      assert.equal(f.pans.length, 0);
      assert.equal(
        f.preRender.size(),
        0,
        'an idle card installs no frame work',
      );
      let decoded;
      image.decode = () =>
        new Promise((resolve) => {
          decoded = resolve;
        });
      image.dispatchEvent(new Event('load'));
      await settle();
      assert.equal(
        image.classList.contains('loaded'),
        false,
        'a request alone does not expose an empty frame',
      );
      decoded();
      await settle();
      assert.equal(
        image.classList.contains('loaded'),
        true,
        'the loaded medium photo is painted inside the card',
      );
      assert.equal(card.querySelector('[role=status]'), null);
      const style = readFileSync(
        new URL('./views/panels/WildlifeSightingCard.vue', import.meta.url),
        'utf8',
      );
      assert.match(style, /object-fit: contain/);
      assert.match(style, /height: 180px/);
    });
});

test('missing, restricted, obscured and Acartia photos all use the same compact text card', async (context) => {
  for (const [label, extra] of [
    ['missing', { photo: null }],
    ['restricted', { photo: { ...row.photo, licence: 'cc-by-nd' } }],
    [
      'untrusted',
      { photo: { ...row.photo, square: 'https://other.example/square.jpg' } },
    ],
    ['uncredited', { photo: { ...row.photo, attribution: '' } }],
    ['obscured', { obscured: true }],
    [
      'Acartia',
      {
        origin: 'acartia',
        stableId: 'acartia:456',
        provider: { name: 'Synthetic network' },
        link: 'https://acartia.io',
      },
    ],
  ])
    await context.test(label, async (context) => {
      const f = fixture(context, { ...row, ...extra });
      await f.click();
      const card = f.cardElement();
      assert.equal(card.querySelector('img'), null);
      assert.equal(card.querySelector('[role=status]'), null);
      assert.equal(card.querySelector('h2').textContent, row.commonName);
      assert.equal(card.querySelector('i').textContent, row.scientificName);
      assert.equal(document.querySelector('dialog'), null);
      if (extra.obscured) {
        assert.doesNotMatch(card.textContent, /ago|Photographer/);
        assert.ok(
          card.textContent.includes('Location obscured to a 0.2° cell'),
        );
        assert.equal(
          card.querySelector('time').getAttribute('datetime'),
          row.observedOn,
        );
      }
      if (extra.origin === 'acartia') {
        assert.ok(card.textContent.includes('seen 1h ago'));
        assert.ok(card.textContent.includes('Reported by Synthetic network'));
        assert.ok(
          card.textContent.includes('Acartia · CC BY 4.0 · Salish Sea'),
        );
        assert.ok(card.querySelector('a[href="https://www.bewhalewise.org"]'));
        assert.equal(
          card.querySelector('a').getAttribute('aria-label'),
          `Open ${row.commonName} on Acartia`,
        );
      }
    });
});

test('an Acartia card labels only the Acartia site as Acartia', async (context) => {
  for (const link of [
    'https://provider.example/photos/synthetic.jpg',
    'https://acartia.io.attacker.example/',
    'https://acartia.io/',
  ])
    await context.test(link, async (context) => {
      const f = fixture(context, {
        ...row,
        origin: 'acartia',
        stableId: 'acartia:456',
        provider: { name: 'Synthetic network' },
        link,
      });
      await f.click();
      const card = f.cardElement();
      const hrefs = [...card.querySelectorAll('a')].map((a) =>
        a.getAttribute('href'),
      );
      assert.deepEqual(hrefs, [
        'https://acartia.io/',
        'https://www.bewhalewise.org',
      ]);
      assert.equal(
        card.querySelector('.wildlife-sighting-card-source').textContent,
        'Acartia ↗',
      );
    });
});

test('safe placements near each viewport edge exclude actual HUD, toolbar and rail rects', () => {
  const obstacles = [
    rect(0, 0, 260, 160),
    rect(450, 0, 300, 80),
    rect(1050, 200, 150, 500),
    rect(0, 760, 300, 140),
  ];
  const safe = { bounds: rect(6, 6, 1188, 888), obstacles };
  for (const point of [
    { x: 7, y: 450 },
    { x: 1193, y: 750 },
    { x: 850, y: 7 },
    { x: 600, y: 893 },
  ]) {
    const result = placeWildlifeSightingCard(
      point,
      { width: 258, height: 300 },
      safe,
    );
    assert.ok(result);
    assert.deepEqual(result.pan, { x: 0, y: 0 });
    assert.ok(
      result.left >= safe.bounds.left && result.right <= safe.bounds.right,
    );
    assert.ok(
      result.top >= safe.bounds.top && result.bottom <= safe.bounds.bottom,
    );
    assert.ok(
      obstacles.every(
        (r) =>
          !(
            result.left < r.right &&
            result.right > r.left &&
            result.top < r.bottom &&
            result.bottom > r.top
          ),
      ),
    );
  }
});

test('a selected dot flies to its true position and its card pans clear of chrome', async (context) => {
  const f = fixture(context, row, { x: 100, y: 100 });
  const hud = f.obstacle('.hud-top-left', rect(0, 0, 260, 160));
  f.obstacle('#right-context-rail', rect(1040, 200, 160, 700));
  f.windowRef.matchMedia = () => ({ matches: true });
  await f.click();
  assert.equal(f.pans.length, 1);
  assert.equal(f.pans[0].reduced, true);
  assert.deepEqual(
    f.pans[0].to,
    { x: 100, y: 178 },
    'nearest clear point follows the measured HUD bottom',
  );
  const safe = readWildlifeCardSafeArea({
    documentRef: document,
    viewer: f.viewer,
    windowRef: f.windowRef,
  });
  assert.equal(
    safe.obstacles[0].bottom,
    hud.getBoundingClientRect().bottom + 6,
  );
  assert.equal(f.flights.length, 1);
  assert.deepEqual(f.flights[0].position, f.state.positions.get(row.stableId));
  f.moveEnd.emit();
  await settle();
  assert.equal(f.pans.length, 1);
  f.layer.clearSightingSelection();
  await settle();
  f.setPoint({ x: -20, y: 400 });
  await f.click();
  assert.equal(f.pans.length, 2);
  assert.deepEqual(f.pans[1].to, { x: 18, y: 400 });
});

test('the camera correction preserves altitude and orientation and honors reduced motion', () => {
  const flights = [];
  const camera = {
    positionWC: Cesium.Cartesian3.fromDegrees(0, 0, 250_000),
    positionCartographic: { height: 250_000 },
    heading: 0.2,
    pitch: -1.2,
    roll: 0.1,
    pickEllipsoid: (p) => Cesium.Cartesian3.fromDegrees(p.x / 100, p.y / 100),
    flyTo: (value) => flights.push(value),
  };
  const viewer = {
    camera,
    scene: {
      canvas: { getBoundingClientRect: () => rect(0, 0, 1200, 900) },
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
    },
  };
  for (const reduced of [false, true]) {
    assert.equal(
      panWildlifeSighting(viewer, { x: 10, y: 10 }, { x: 30, y: 50 }, reduced),
      true,
    );
    const flight = flights.at(-1);
    assert.ok(
      Math.abs(
        Cesium.Cartographic.fromCartesian(flight.destination).height - 250_000,
      ) < 0.001,
    );
    assert.deepEqual(flight.orientation, {
      heading: 0.2,
      pitch: -1.2,
      roll: 0.1,
    });
    assert.equal(flight.duration, reduced ? 0 : 0.22);
  }
});

test('the browser click that follows a globe selection does not close the card it opened', async (context) => {
  const f = fixture(context);
  await f.click();
  assert.ok(f.cardElement(), 'the globe click opened the card');
  assert.equal(
    document.activeElement,
    f.cardElement(),
    'focus lands on the card, not as a ring on its close button',
  );
  // Cesium selects on pointer-up; the DOM click event lands on the canvas
  // afterwards and must not count as an outside click.
  f.canvas.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await settle();
  assert.ok(f.cardElement(), 'the card stays open');
  assert.equal(f.clears(), 0);
  document.body.click();
  await settle();
  assert.equal(f.cardElement(), null, 'a real outside click still closes it');
});

test('one card at a time, Escape, outside clicks and close all clear the selection', async (context) => {
  const f = fixture(context);
  await f.click();
  const second = {
    ...row,
    stableId: 'inat:789',
    commonName: 'Another synthetic bird',
  };
  f.state.rowById.set(second.stableId, second);
  await f.click('dot', second);
  assert.equal(
    document.querySelectorAll('[data-wildlife-sighting-card]').length,
    1,
  );
  assert.equal(
    f.cardElement().querySelector('h2').textContent,
    second.commonName,
  );
  for (const close of ['Escape', 'outside', 'button']) {
    if (close === 'Escape')
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    if (close === 'outside') document.body.click();
    if (close === 'button') f.cardElement().querySelector('button').click();
    await settle();
    assert.equal(f.cardElement(), null);
    assert.equal(f.state.selectedId, null);
    assert.deepEqual(f.overlays.get('wildlife-sightings-selected'), []);
    assert.equal(document.activeElement, f.opener);
    await f.click();
  }
  assert.equal(f.clears(), 3);
});

test('camera movement repositions the same card and removes frame work at rest', async (context) => {
  const f = fixture(context);
  await f.click();
  const card = f.cardElement();
  const before = f.host().style.left;
  f.moveStart.emit();
  assert.equal(f.preRender.size(), 1);
  f.setPoint({ x: 800, y: 450 });
  f.preRender.emit();
  assert.equal(f.cardElement(), card);
  assert.notEqual(f.host().style.left, before);
  f.moveEnd.emit();
  assert.equal(f.preRender.size(), 0);
  await f.publish({ ...row, commonName: 'Updated synthetic bird' });
  assert.equal(f.cardElement(), card);
  assert.equal(card.querySelector('h2').textContent, 'Updated synthetic bird');
  f.state.rowById.delete(row.stableId);
  await f.publish(null);
  assert.equal(
    f.cardElement(),
    card,
    'a refreshed sample cannot close the selected card',
  );
  f.layer.clearSightingSelection();
  await settle();
  assert.equal(f.cardElement(), null);
});

test('replacement photo loads cannot expose the previous image and failures retain the text card', async (context) => {
  const f = fixture(context);
  await f.click();
  const previous = f.cardElement().querySelector('img');
  let decoded;
  previous.decode = () =>
    new Promise((resolve) => {
      decoded = resolve;
    });
  previous.dispatchEvent(new Event('load'));
  await f.publish({
    ...row,
    photo: { ...row.photo, square: square.replace('/456/', '/789/') },
  });
  const current = f.cardElement().querySelector('img');
  decoded();
  await settle();
  assert.equal(current.classList.contains('loaded'), false);
  current.dispatchEvent(new Event('error'));
  await settle();
  assert.equal(
    f.cardElement().querySelector('[role=status]').textContent,
    'Photo unavailable',
  );
  assert.equal(current.style.display, 'none');
  assert.equal(f.cardElement().querySelector('a').href, row.link);
});

test('teardown removes subscriptions, placement listeners and host, and ignores stale notifications', async (context) => {
  const f = fixture(context);
  await f.click();
  f.moveStart.emit();
  const stale = f.staleListener();
  f.card.destroy();
  assert.equal(f.cardElement(), null);
  assert.equal(f.host(), null);
  assert.equal(f.subscriptions.size, 0);
  assert.equal(f.preRender.size(), 0);
  stale(row);
  await f.click();
  assert.equal(f.cardElement(), null);
  assert.equal(document.activeElement, f.opener);
});

test('locale changes translate the card without replacing the image or credit', async (context) => {
  const before = getLocale();
  context.after(() => setLocale(before));
  const f = fixture(context);
  await f.click();
  const card = f.cardElement();
  const image = card.querySelector('img');
  for (const locale of LOCALES) {
    setLocale(locale);
    await settle();
    assert.equal(f.cardElement(), card);
    assert.equal(card.querySelector('img'), image);
    assert.equal(
      card.querySelector('button').getAttribute('aria-label'),
      t('Close sighting'),
    );
    assert.ok(card.textContent.includes('© Synthetic Photographer · CC BY-SA'));
  }
});

test('date-only and unsafe-link rows remain readable, and no sighting rail or lightbox is shipped', async (context) => {
  const f = fixture(context, {
    ...row,
    observedAt: null,
    photo: null,
    link: 'javascript:alert(1)',
  });
  await f.click();
  assert.equal(f.cardElement().querySelector('a'), null);
  assert.equal(
    f.cardElement().querySelector('time').getAttribute('datetime'),
    row.observedOn,
  );
  assert.equal(PANEL_RAIL_ITEMS['wildlife-sighting-panel'], undefined);
  assert.equal(sheetForPanelId('wildlife-sighting-panel'), null);
  const source = readFileSync(
    new URL('./wildlifeSightingCard.js', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /Lightbox|showModal|requestAnimationFrame|setInterval/,
  );
});

test('WHALES cards retain compact whale guidance outside the observation action', async (context) => {
  const f = fixture(context);
  f.layer.getParams = () => ({ taxa: 'whales' });
  await f.click();
  const guidance = f
    .cardElement()
    .querySelector('a[href="https://www.bewhalewise.org"]');
  assert.equal(guidance.textContent, 'Be Whale Wise');
  assert.equal(
    guidance.parentElement.closest('a'),
    null,
    'the external guidance link never nests inside the observation action',
  );
});

test('opening during camera motion tracks the card and closing stops frame work immediately', async (context) => {
  const f = fixture(context);
  f.moveStart.emit();
  assert.equal(f.preRender.size(), 0);
  await f.click();
  assert.equal(f.preRender.size(), 1);
  f.layer.clearSightingSelection();
  await settle();
  assert.equal(f.preRender.size(), 0);
});

test('newly mounted chrome repositions the open card without camera events or idle text work', async (context) => {
  const observers = [];
  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      observers.push(this);
    }
    observe(target, options) {
      this.targets.push({ target, options });
    }
    disconnect() {
      this.targets = [];
    }
  }
  const f = fixture(context, row, { x: 600, y: 450 }, { MutationObserver });
  await f.click();
  const structural = observers.find((observer) =>
    observer.targets.some(
      ({ target, options }) =>
        target === document.body && options.childList && options.subtree,
    ),
  );
  assert.ok(
    structural,
    'structural observation exists only while a card is open',
  );
  const original = f.cardElement();
  const before = f.host().style.top;
  const hudWrapper = document.body.appendChild(document.createElement('div'));
  const hud = hudWrapper.appendChild(document.createElement('div'));
  hud.className = 'hud-top-left';
  hud.getBoundingClientRect = () => rect(500, 350, 200, 200);
  structural.callback([{ addedNodes: [hudWrapper], removedNodes: [] }]);
  await settle();
  assert.equal(
    f.pans.length,
    1,
    'chrome newly covering the dot triggers one minimal pan',
  );
  assert.equal(f.cardElement(), original);
  assert.notEqual(f.host().style.top, before);
  assert.equal(f.preRender.size(), 0);
  const placed = rect(
    Number.parseFloat(f.host().style.left),
    Number.parseFloat(f.host().style.top),
    258,
    300,
  );
  assert.ok(
    placed.right <= 494 ||
      placed.left >= 706 ||
      placed.bottom <= 344 ||
      placed.top >= 556,
    'the card clears the measured HUD rect',
  );
  const afterChrome = f.projections();
  // The observer ignores text nodes, ordinary clock wrappers and the card's
  // own image/caption patches even though body observation sees their records.
  const clock = hud.appendChild(document.createElement('span'));
  const text = clock.appendChild(document.createTextNode('13:00:01'));
  structural.callback([
    {
      addedNodes: [clock, text, f.cardElement().querySelector('img')],
      removedNodes: [],
    },
  ]);
  assert.equal(f.projections(), afterChrome);
  f.layer.clearSightingSelection();
  await settle();
  assert.equal(
    structural.targets.length,
    0,
    'closing disconnects structural observation',
  );
});
