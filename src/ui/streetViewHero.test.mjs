// A street-level photo's card opens its photo again when picked from a list:
// it says so while the photo loads, and why when it cannot, with Retry.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSameNode } from '../testSupport/domAssert.mjs';
import { createPinia } from 'pinia';
import { bindLocale, setLocale, t as tr } from '../i18n/index.js';
import { createApp, h, nextTick, ref } from 'vue';
import StreetViewHero from './views/panels/StreetViewHero.vue';
import { useEntityCardStore } from './stores/entityCard.js';
import { useStreetLevelStore } from './stores/streetLevel.js';
import { usePinnedStore } from './stores/pinned.js';
import { presentStreetLevel } from './streetLevelPresentation.js';
import { createStreetLevelLayer } from '../layers/streetLevel/index.js';
import {
  fakeCesiumViewer,
  fakeStreetLevelProvider,
} from '../testSupport/streetLevelFakes.mjs';

bindLocale(ref('en'));

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function connectLayer(cards, record) {
  let publish;
  const manager = {
    layers: new Map([[record.id, record]]),
    isEnabled: () => record.enabled,
    getAll: () => [record],
    subscribe: (fn) => {
      publish = fn;
      return () => {};
    },
  };
  cards.connect({
    dataManager: () => manager,
    regionalBrief: async () => null,
    previews: () => null,
    canFollow: () => false,
    follow() {},
    flyTo() {},
    ask() {},
  });
  return (enabled) => {
    record.enabled = enabled;
    publish({ type: 'visibility', layerId: record.id, enabled });
  };
}

function mountHero(
  t,
  id,
  {
    providerOn = true,
    billed = false,
    alreadyOpen = false,
    layerEnabled = true,
    savedStill = null,
    recordStill = null,
    savedCredit = null,
  } = {},
) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const cards = useEntityCardStore(pinia);
  const layer = {
    id: 'street-level',
    name: 'Street Level',
    enabled: layerEnabled,
    module: { photo: () => (recordStill ? { still: recordStill } : null) },
  };
  const setEnabled = connectLayer(cards, layer);
  const street = useStreetLevelStore(pinia);
  const view = (error = null) => ({
    enabled: layerEnabled,
    error,
    providers: [
      {
        id: id.replace(/^near:/, '').split(':')[0],
        active: providerOn,
        billed,
      },
    ],
    viewer: { open: alreadyOpen, photo: alreadyOpen ? { id } : null },
  });
  street.publish(view());
  if (savedStill) {
    cards.fromPin = true;
    usePinnedStore(pinia).pin({
      key: `street-level:${id}`,
      title: 'Saved street photo',
      kind: 'street',
      identity: { layerId: 'street-level', id },
      still: savedStill,
      ...(savedCredit && { photoCredit: savedCredit }),
    });
  }
  const asked = [];
  let answer = null;
  street.attach({
    openPhoto: (photoId) => {
      asked.push(photoId);
      return new Promise((resolve) => {
        answer = resolve;
      });
    },
  });
  const mountKey = ref(0);
  const app = createApp({
    render: () =>
      h(StreetViewHero, {
        key: mountKey.value,
        card: {
          key: `street-level:${id}`,
          layerId: 'street-level',
          identity: { layerId: 'street-level', id },
        },
      }),
  }).use(pinia);
  app.mount(host);
  t.after(() => {
    app.unmount();
    cards.connect(null);
  });
  return {
    host,
    remount: () => mountKey.value++,
    cards,
    street,
    view,
    asked,
    setEnabled,
    answer: async (value) => {
      answer(value);
      await settle();
      await nextTick();
    },
    fail: async (error) => {
      street.publish(view(error));
      answer(false);
      await settle();
      await nextTick();
    },
  };
}

test('a Nearby line’s card says its photo is loading, then why there is none, and Retry asks again', async (t) => {
  const id = 'near:kartaview:59.33,18.06';
  const { host, asked, fail, street, view } = mountHero(t, id);
  await nextTick();
  assert.deepEqual(asked, [id]);
  assert.equal(
    host.querySelector('.sl-hero__state[role="status"]')?.textContent,
    'Loading photo...',
  );
  await fail('No street-level imagery within 50 m of that point');
  const alert = host.querySelector('.sl-hero__state[role="alert"]');
  assert.match(alert?.textContent ?? '', /No street-level imagery within 50 m/);
  street.publish(view('Another lookup failed'));
  await nextTick();
  assert.match(alert.textContent, /No street-level imagery within 50 m/);
  alert.querySelector('button').click();
  await nextTick();
  assert.deepEqual(asked, [id, id], 'Retry asks for the photo again');
  assert.ok(host.querySelector('.sl-hero__state[role="status"]'));
});

test('a pinned photo waits for both the layer manager and provider, and billed photos wait for Open', async (t) => {
  for (const billed of [true, false]) {
    const id = billed ? 'google:saved' : 'mapillary:saved';
    const { street, view, setEnabled, host, asked } = mountHero(t, id, {
      layerEnabled: false,
      billed,
      savedStill: 'data:image/png;base64,',
    });
    const publishProvider = () => street.publish({ ...view(), enabled: true });
    publishProvider();
    await nextTick();
    assert.deepEqual(asked, []);
    setEnabled(true);
    await nextTick();
    if (billed) {
      assert.deepEqual(asked, []);
      const button = host.querySelector('.sl-hero__retry');
      assert.equal(button?.textContent, 'Open');
      button.click();
    }
    publishProvider();
    await nextTick();
    assert.deepEqual(asked, [id]);
  }
});

test('a remembered billed photo opens only on request, even after the card remounts', async (t) => {
  const id = 'google:remembered';
  const { asked, host, remount } = mountHero(t, id, { billed: true });
  await nextTick();
  assert.deepEqual(asked, []);
  remount();
  await nextTick();
  assert.deepEqual(asked, []);
  const open = host.querySelector('.sl-hero__retry');
  assert.equal(open?.textContent, 'Open');
  open.click();
  await nextTick();
  assert.deepEqual(asked, [id]);
});

test('remounting with its provider off never opens a photo', async (t) => {
  const { asked } = mountHero(t, 'google:A', { providerOn: false });
  await nextTick();
  assert.deepEqual(asked, []);
});

test('losing the accepted frame shows a Retry for that card', async (t) => {
  const { street, view, host, asked } = mountHero(t, 'mapillary:A', {
    alreadyOpen: true,
  });
  await nextTick();
  assert.deepEqual(asked, []);
  street.publish({ ...view(), viewer: { open: false, photo: null } });
  await nextTick();
  const retry = host.querySelector('.sl-hero__retry');
  assert.ok(retry);
  retry.click();
  await nextTick();
  assert.deepEqual(asked, ['mapillary:A']);
});

test('a photo that cannot open says so even without an error from the layer', async (t) => {
  const { host, fail } = mountHero(t, 'kartaview:42');
  await nextTick();
  await fail(null);
  assert.equal(
    host.querySelector('.sl-hero__state[role="alert"] span')?.textContent,
    'No imagery',
  );
  t.after(() => setLocale('en'));
  setLocale('fr');
  await nextTick();
  assert.equal(
    host.querySelector('[role="alert"] span').textContent,
    tr('No imagery'),
  );
});

test('after Retry, focus stays in the hero, and returns to Retry when the photo still cannot open', async (t) => {
  const { host, fail } = mountHero(t, 'kartaview:42');
  await nextTick();
  await fail(null);
  const hero = host.querySelector('.sl-hero');
  const retry = () => host.querySelector('.sl-hero__retry');
  retry().focus();
  retry().click();
  await nextTick();
  assert.ok(
    !host.querySelector('.sl-hero__retry'),
    'Retry is gone while loading',
  );
  assertSameNode(document.activeElement, hero, 'focus waits on the hero');
  await fail(null);
  await nextTick();
  assertSameNode(document.activeElement, retry(), 'focus is back on Retry');
});

test('a photo the viewer cannot load shows its failure and Retry in the card, not an empty viewer', async (t) => {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  // A real layer whose viewer rejects every image.
  const provider = fakeStreetLevelProvider({ id: 'mapillary' });
  const create = provider.create;
  let opens = 0;
  provider.create = (context) => {
    const instance = create(context);
    instance.viewer.open = async () => {
      opens++;
      throw new Error('Image could not be opened');
    };
    return instance;
  };
  const viewer = fakeCesiumViewer();
  viewer.canvas = viewer.scene.canvas;
  const layer = createStreetLevelLayer({ providers: [provider] });
  layer.init(viewer);
  layer.enable(viewer);
  layer.attachViewerHost(
    document.body.appendChild(document.createElement('div')),
  );
  await settle();
  const street = useStreetLevelStore(pinia);
  const unsubscribe = layer.subscribe((state) =>
    street.publish(presentStreetLevel(state)),
  );
  street.publish(presentStreetLevel(layer.getUIState()));
  street.attach({ openPhoto: (id) => layer.openPhoto(id) });
  const cards = useEntityCardStore(pinia);
  const record = {
    id: 'street-level',
    name: 'Street Level',
    enabled: true,
    module: layer,
  };
  connectLayer(cards, record);
  const id = 'mapillary:img-1';
  const app = createApp({
    render: () =>
      h(StreetViewHero, {
        card: {
          key: `street-level:${id}`,
          layerId: 'street-level',
          identity: { layerId: 'street-level', id },
        },
      }),
  }).use(pinia);
  app.mount(host);
  t.after(() => {
    app.unmount();
    unsubscribe?.();
    cards.connect(null);
    layer.destroy();
  });
  await settle();
  await nextTick();
  assert.equal(opens, 1);
  assert.ok(!host.querySelector('#sl-viewer-slot'), 'no empty viewer slot');
  const retry = () => host.querySelector('.sl-hero__retry');
  assert.match(
    host.querySelector('.sl-hero__state[role="alert"]')?.textContent ?? '',
    /Image could not be opened/,
  );
  retry().focus();
  retry().click();
  await settle();
  await nextTick();
  assert.equal(opens, 2, 'Retry asks again');
  assertSameNode(document.activeElement, retry(), 'focus is back on Retry');
});

test('the Nearby empty-photo alert keeps its radius and follows locale changes', async (t) => {
  setLocale('fr');
  t.after(() => setLocale('en'));
  const id = 'near:mapillary:59.330000,18.060000';
  const { host, street } = mountHero(t, id, { providerOn: false });
  const provider = fakeStreetLevelProvider();
  const layer = createStreetLevelLayer({ providers: [provider] });
  const viewer = fakeCesiumViewer();
  layer.init(viewer);
  layer.enable(viewer);
  const publish = () => street.publish(presentStreetLevel(layer.getUIState()));
  const unsubscribe = layer.subscribe(publish);
  street.attach({ openPhoto: (photoId) => layer.openPhoto(photoId) });
  t.after(() => {
    unsubscribe();
    layer.destroy();
  });
  publish();
  await settle();
  await nextTick();
  const message = () => host.querySelector('[role="alert"] span')?.textContent;
  const key = 'No street-level imagery within {radius} m of that point';
  assert.equal(message(), tr(key, { radius: 50 }));
  setLocale('en');
  await nextTick();
  assert.equal(message(), tr(key, { radius: 50 }));
});

test('a superseded Nearby card offers Retry without adopting the other lookup error', async (t) => {
  const id = 'near:mapillary:48.000000,2.000000:S';
  const { host, asked, answer, street, view } = mountHero(t, id);
  street.publish(view('Another lookup found no photo'));
  await answer(null);
  const state = host.querySelector('.sl-hero__state');
  assert.ok(state);
  assert.doesNotMatch(state.textContent, /Another lookup/);
  const retry = state.querySelector('button');
  assert.ok(retry);
  retry.click();
  await nextTick();
  assert.deepEqual(asked, [id, id]);
});

test('when Street Level is off only a pin can supply the hero still', async (t) => {
  const saved = 'data:image/png;base64,AA==';
  const { host, asked } = mountHero(t, 'mapillary:saved', {
    layerEnabled: false,
    savedStill: saved,
    recordStill: 'https://example.invalid/forgotten-live.jpg',
  });
  await nextTick();
  const image = host.querySelector('.sl-hero__still img');
  assert.equal(image?.getAttribute('src'), saved);
  assert.equal(image.getAttribute('referrerpolicy'), 'no-referrer');
  assert.match(
    host.querySelector('.paused-chip')?.getAttribute('aria-label') ?? '',
    /Street Level off · last image/,
  );
  image.dispatchEvent(new Event('error'));
  await nextTick();
  assert.equal(host.querySelector('.sl-hero__still img'), null);
  assert.deepEqual(asked, []);
});

test('with Street Level off a remote pinned still is not asked for: the card says the layer is off', async (t) => {
  const { host, asked } = mountHero(t, 'panoramax:saved', {
    layerEnabled: false,
    savedStill: 'https://example.invalid/street.jpg',
  });
  await nextTick();
  assert.equal(host.querySelector('.sl-hero__still img'), null, 'no request');
  const chip =
    host.querySelector('.paused-chip')?.getAttribute('aria-label') ?? '';
  assert.match(chip, /Street Level off/);
  assert.doesNotMatch(chip, /last image/);
  assert.deepEqual(asked, []);
});

test('a pinned photo keeps its saved credit while Street Level is off', async (t) => {
  const { host } = mountHero(t, 'panoramax:saved', {
    layerEnabled: false,
    savedStill: 'https://example.invalid/street.jpg',
    savedCredit: {
      source: 'Panoramax',
      creator: 'Ana',
      license: 'Licence Ouverte 2.0',
    },
  });
  await nextTick();
  assert.equal(
    host.querySelector('.sl-hero__credit')?.textContent,
    'Panoramax · Image by Ana · Licence Ouverte 2.0',
  );
});

test('a card whose source is switched off stays with “Source off”, and opens again with its source', async (t) => {
  const id = 'kartaview:A';
  const { host, street, asked, cards } = mountHero(t, id, {
    alreadyOpen: true,
  });
  cards.card = {
    key: `street-level:${id}`,
    layerId: 'street-level',
    identity: { layerId: 'street-level', id },
  };
  const publish = (active) =>
    street.publish({
      enabled: true,
      error: null,
      providers: [{ id: 'kartaview', active }],
      viewer: { open: false, photo: null },
    });
  publish(false);
  await nextTick();
  assert.equal(cards.card?.key, `street-level:${id}`, 'the card stays');
  assert.match(
    host.querySelector('.paused-chip')?.getAttribute('aria-label') ?? '',
    /Source off/,
  );
  assert.deepEqual(asked, []);
  publish(true);
  await nextTick();
  assert.deepEqual(asked, [id], 'with its source back the photo opens again');
});
