// A street-level photo's picture away from its viewer (a pinned tile, the
// dock) carries its provider's credit, with who took it and its licence when
// known, for as long as the picture shows.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { useStreetLevelStore } from './stores/streetLevel.js';
import { h, nextTick } from 'vue';
import { savedStillShown, streetPhotoCredit } from './streetPhotoCredit.js';
import { createPhotoHistory } from '../layers/streetLevel/photos.js';
import { createStreetLevelLayer } from '../layers/streetLevel/index.js';
import { KARTAVIEW_CREDIT_HTML } from '../layers/streetLevel/providers/kartaview/policy.js';
import { fakeStreetLevelProvider } from '../testSupport/streetLevelFakes.mjs';
import PinnedGrid from './views/panels/PinnedGrid.vue';
import DockedView from './views/panels/DockedView.vue';
import StreetViewHero from './views/panels/StreetViewHero.vue';
import { usePinnedStore } from './stores/pinned.js';
import { useDockedStore } from './stores/docked.js';
import {
  mountCreditView,
  connectCreditLayer,
} from '../testSupport/pictureCredit.mjs';

const KARTAVIEW_TEXT =
  'Street Level: imagery © KartaView contributors, CC BY-SA 4.0';

const record = (overrides = {}) => ({
  id: 'kartaview:42',
  providerId: 'kartaview',
  provider: 'KartaView',
  creator: null,
  license: null,
  still: 'https://example.org/42.jpg',
  ...overrides,
});

/** A Street Level module as the card reads it: its photos and credits. */
const streetModule = (photos, credits = { kartaview: KARTAVIEW_TEXT }) => ({
  getAnalystRecords: () => [],
  photo: (id) => photos[id] || null,
  providerCredit: (id) => credits[id] || '',
});

test('the credit is the provider’s own, then who took it and the picture’s licence', () => {
  const photos = {
    'kartaview:42': record({ creator: 'mapfool' }),
    'panoramax:7': record({
      id: 'panoramax:7',
      providerId: 'panoramax',
      provider: 'Panoramax',
      via: 'panoramax.ign.fr',
      license: 'CC-BY-SA-4.0',
    }),
  };
  const module = streetModule(photos, {
    kartaview: KARTAVIEW_TEXT,
    panoramax:
      'Street Level: imagery © Panoramax contributors, licence per picture',
  });
  assert.equal(
    streetPhotoCredit(module, 'kartaview:42'),
    `${KARTAVIEW_TEXT} · Image by mapfool`,
  );
  assert.equal(
    streetPhotoCredit(module, 'panoramax:7'),
    'Street Level: imagery © Panoramax contributors, licence per picture · via panoramax.ign.fr · CC-BY-SA-4.0',
  );
  // A photo the layer no longer remembers is still credited to its source,
  // named in its id.
  assert.equal(streetPhotoCredit(module, 'kartaview:99'), KARTAVIEW_TEXT);
  // Without the provider's credit, its name, as the card's source line has it.
  assert.equal(
    streetPhotoCredit(streetModule(photos, {}), 'kartaview:42'),
    'KartaView · Image by mapfool',
  );
  assert.equal(streetPhotoCredit(null, 'kartaview:42'), '');
  assert.equal(streetPhotoCredit(streetModule({}, {}), 'nowhere'), '');
});

test('the layer hands out a provider’s credit as plain text, and remembers a picture’s licence', () => {
  const layer = createStreetLevelLayer({
    providers: [
      fakeStreetLevelProvider({
        id: 'kartaview',
        pickPrefix: 'kv:',
        html: KARTAVIEW_CREDIT_HTML,
      }),
    ],
  });
  assert.equal(layer.providerCredit('kartaview'), KARTAVIEW_TEXT);
  assert.equal(layer.providerCredit('nowhere'), '');
  const history = createPhotoHistory();
  const kept = history.remember({
    open: true,
    providerId: 'panoramax',
    providerName: 'Panoramax',
    imageId: '7',
    position: { lat: 48.85, lon: 2.35 },
    creator: 'someone',
    license: 'CC-BY-SA-4.0',
  });
  assert.equal(kept.license, 'CC-BY-SA-4.0');
});

function connect(cards, module, { streetOn = true } = {}) {
  return connectCreditLayer(cards, {
    id: 'street-level',
    name: 'Street Level',
    enabled: streetOn,
    module,
  });
}

test('a pinned street still shows its provider’s credit on its tile; other pins carry none', async (t) => {
  const { host, pinia, cards, mount: go } = mountCreditView(t, PinnedGrid);
  const street = connect(
    cards,
    streetModule({ 'kartaview:42': record({ creator: 'mapfool' }) }),
    { streetOn: false },
  );
  const pinned = usePinnedStore(pinia);
  pinned.pin({
    key: 'street-level:kartaview:42',
    kind: 'street',
    title: 'Drottninggatan',
    icon: 'streetview',
    identity: { layerId: 'street-level', id: 'kartaview:42' },
    still: 'https://example.org/42.jpg',
  });
  pinned.pin({
    key: 'street-level:kartaview:43',
    kind: 'street',
    title: 'No picture',
    icon: 'streetview',
    identity: { layerId: 'street-level', id: 'kartaview:43' },
  });
  pinned.pin({
    key: 'place:a',
    kind: 'place',
    title: 'Zilker Park',
    icon: 'location_on',
    identity: { layerId: 'place', id: 'a' },
    still: '/still/a.png',
  });
  go();
  await nextTick();
  const tiles = [...host.querySelectorAll('.pinned-grid__tile')];
  const credit = (tile) =>
    tile.querySelector('.pinned-grid__photo-credit')?.textContent ?? null;
  assert.equal(
    tiles[0].querySelector('img'),
    null,
    'no provider image while Street Level is off',
  );
  assert.equal(credit(tiles[0]), null);
  street.enabled = true;
  cards.layerRevision++;
  await nextTick();
  assert.equal(
    credit(tiles[0]),
    `${KARTAVIEW_TEXT} · Image by mapfool`,
    'with the picture, on its tile',
  );
  assert.equal(
    tiles[0].querySelector('.pinned-grid__frame')?.getAttribute('src'),
    'https://example.org/42.jpg',
  );
  assert.equal(credit(tiles[1]), null, 'no picture, nothing to credit');
  assert.equal(credit(tiles[2]), null, 'a map still is credited below');
});

test('a docked street still shows its provider’s credit under the picture', async (t) => {
  const { host, pinia, cards, mount: go } = mountCreditView(t, DockedView);
  const photos = {
    'kartaview:42': record({
      via: 'fixture publisher',
      license: 'test licence',
    }),
  };
  connect(cards, streetModule(photos), { streetOn: false });
  useDockedStore(pinia).dock({
    key: 'street-level:kartaview:42',
    kind: 'street',
    title: 'Drottninggatan',
    icon: 'streetview',
    identity: { layerId: 'street-level', id: 'kartaview:42' },
  });
  go();
  await nextTick();
  assert.equal(
    host.querySelector('.docked-view__frame img')?.getAttribute('src'),
    'https://example.org/42.jpg',
  );
  assert.equal(
    host.querySelector('.docked-view__credit')?.textContent,
    KARTAVIEW_TEXT + ' · via fixture publisher · test licence',
  );
  delete photos['kartaview:42'];
  useStreetLevelStore(pinia).publish({
    enabled: true,
    viewer: { open: true, photo: { id: 'kartaview:42' } },
  });
  await nextTick();
  assert.equal(
    host.querySelector('.docked-view__credit')?.textContent,
    KARTAVIEW_TEXT + ' · via fixture publisher · test licence',
  );
});

test('a waiting street card credits its own still', async (t) => {
  const {
    host,
    cards,
    pinia,
    mount: go,
  } = mountCreditView(t, {
    render: () =>
      h(StreetViewHero, {
        card: {
          key: 'street-level:kartaview:42',
          layerId: 'street-level',
          identity: { layerId: 'street-level', id: 'kartaview:42' },
        },
      }),
  });
  connect(
    cards,
    streetModule({
      'kartaview:42': record({ creator: 'mapfool', license: 'CC BY-SA 4.0' }),
    }),
  );
  useStreetLevelStore(pinia).publish({
    enabled: true,
    viewer: { open: false, photo: null },
  });
  go();
  await nextTick();
  assert.equal(
    host.querySelector('.sl-hero__still img')?.getAttribute('src'),
    'https://example.org/42.jpg',
  );
  const foot = host.querySelector('.sl-hero__foot');
  assert.equal(
    foot?.querySelector('.sl-hero__credit')?.textContent,
    `${KARTAVIEW_TEXT} · Image by mapfool · CC BY-SA 4.0`,
  );
});

test('a saved street still shows without its provider only as a local copy', () => {
  assert.equal(savedStillShown('https://x.invalid/a.jpg', false), true);
  assert.equal(savedStillShown('https://x.invalid/a.jpg', true), false);
  assert.equal(savedStillShown('data:image/png;base64,AA==', true), true);
  assert.equal(savedStillShown('blob:https://app.invalid/1', true), true);
  assert.equal(savedStillShown('', false), false);
});
