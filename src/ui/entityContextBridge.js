import { resolvePickedContext } from '../data/pickedContext.js';
import { followedOf, onFollowChanged } from '../data/followed.js';
import { fromDegreesInto } from '../geo/ellipsoid.js';
import { inputFor } from '../input/dispatcher.js';
import {
  isTrackingClickGesture,
  isTrackingSelectionGesture,
} from '../data/trackingClickGesture.js';
import { applicationHooksOf } from '../render/applicationHooks.js';
import { findCamera, rendererOf } from '../render/rendererOf.js';
import { useCockpitStore } from './stores/cockpit.js';
import { useEntityCardStore } from './stores/entityCard.js';
import { useOmnibarStore } from './stores/omnibar.js';
import { usePanelChromeStore } from './stores/panelChrome.js';
import { useVoiceStore } from './stores/voice.js';

/** Camera distance (m) that frames an item of each kind. */
const FRAME_RANGE = Object.freeze({
  aircraft: 30_000,
  vessel: 9_000,
  satellite: 2_500_000,
  earthquake: 120_000,
  storm: 1_500_000,
  fire: 20_000,
  'fire perimeter': 40_000,
});
const DEFAULT_RANGE = 8_000;
/**
 * Items the camera can follow: their layers follow through the camera port
 * with a key naming the item (src/data/followed.js). A vessel is flown to.
 */
const FOLLOWABLE = new Set(['flights', 'military', 'satellites']);

/**
 * Connects the Context panel's entity card to the globe: a click on anything a
 * layer can identify opens its card, and the card's actions fly to it, follow
 * it or ask GEV about it. Layers keep their own click behaviour; this listens
 * alongside them.
 * @param {object} options
 * @param {object} options.viewer Cesium viewer.
 * @param {() => object} options.getDataManager Layer lifecycle.
 * @param {object} options.pinia
 * @param {(viewer: object, x: number, y: number) => ({lat: number, lon: number}|null)} [options.pickWorld]
 *   The ground under a normalized screen point; the view's centre falls back
 *   to the point under the camera without it.
 * @param {(lat: number, lon: number) => Promise<object>} [options.regionalBrief]
 *   The app's regional brief service, for the weather and news Context shows.
 * @param {(x: number, y: number) => object|null} [options.overlayHit]
 *   The overlay card under a screen point, if any (a vessel's, a fire's).
 * @returns {() => void} disconnects
 */
export function installEntityContext({
  viewer,
  getDataManager,
  pinia,
  pickWorld,
  regionalBrief,
  overlayHit,
}) {
  const store = useEntityCardStore(pinia);
  const omnibar = useOmnibarStore(pinia);
  const voice = useVoiceStore(pinia);
  const cockpitStore = useCockpitStore(pinia);
  const chrome = usePanelChromeStore(pinia);
  /** Whether Context is open; a closed panel reads nothing. */
  const isOpen = () =>
    chrome.panels['global-context-panel']?.collapsed === false;
  const doc = globalThis.document;
  let disposed = false;
  // The renderer's camera; looked up on use, as a renderer can be bound
  // after Context is installed.
  const camera = () => findCamera(viewer);
  /** Whether the camera follows this card's item (the follow's key). */
  const followsCard = (card, followed = followedOf(viewer)) => {
    const key = followed?.key;
    if (!key || !card) return false;
    return key === card.key || key === `${card.layerId}:${card.identity?.id}`;
  };
  const inCockpit = () =>
    Boolean(doc?.body?.classList.contains('cockpit-mode'));

  function openPanel() {
    const button = doc?.querySelector(
      '.ui-rail--right .ui-rail__item[data-rail-item="global-context-panel"]',
    );
    if (button && button.getAttribute('aria-pressed') !== 'true')
      button.click();
  }

  function flyTo(card) {
    const port = camera();
    if (!port || !Number.isFinite(card?.lat) || !Number.isFinite(card?.lon))
      return;
    const height = Number.isFinite(card.altitudeM) ? card.altitudeM : 0;
    const range = FRAME_RANGE[card.kind] ?? DEFAULT_RANGE;
    port.flyToBounds(
      {
        center: fromDegreesInto(card.lon, card.lat, Math.max(0, height), {
          x: 0,
          y: 0,
          z: 0,
        }),
        radius: 1,
      },
      {
        offset: {
          heading: port.pose().heading,
          pitch: ((card.kind === 'satellite' ? -90 : -45) * Math.PI) / 180,
          range,
        },
        durationS: 2,
      },
    );
  }

  function follow(card) {
    const run = omnibar.runner;
    if (!run || !FOLLOWABLE.has(card.layerId)) return flyTo(card);
    Promise.resolve(
      run('track_entity', {
        query: card.identity.id || card.title,
        layerId: card.layerId,
      }),
    ).catch(() => {});
  }

  // Closing the card lets go of the camera, when the camera follows the
  // card's own item and nothing else took it over since.
  function letGo(card) {
    if (!followsCard(card)) return;
    // Only the card's own layer lets go, as the person's own action; other
    // layers' selections stay as they are.
    const layer = getDataManager()?.layers?.get?.(card.layerId);
    try {
      layer?.module?.stopTracking?.({ origin: 'user' });
    } catch {
      // A layer going away meanwhile has nothing left to let go of.
    }
  }

  // Aircraft can be flown from, and a satellite ridden in the orbital view:
  // track the craft, then enter Cockpit on it. Only layers the tracking
  // action can follow are offered (local ADS-B cannot be tracked).
  const COCKPIT_LAYERS = new Set(['flights', 'military', 'satellites']);
  async function cockpit(card) {
    try {
      await enterCockpit(card);
    } catch {
      // The craft left the feed or tracking failed; the card stays as it is.
    }
  }
  async function enterCockpit(card) {
    const run = omnibar.runner;
    if (!run || !COCKPIT_LAYERS.has(card.layerId)) return;
    await run('track_entity', {
      query: card.identity.id || card.title,
      layerId: card.layerId,
    });
    if (disposed) return;
    if (card.layerId !== 'satellites') {
      await run('control_cockpit', { action: 'enter' });
      return;
    }
    // A satellite is ridden through the app's own Cockpit entry, which offers
    // the orbital view once the satellite is tracked. Wait for it to say so;
    // if it never does (a class that cannot be ridden), nothing is entered.
    for (let tries = 0; tries < 40; tries++) {
      // Another pick or a closed card in the meantime calls the ride off.
      if (disposed || store.card?.key !== card.key) return;
      const presence = cockpitStore.presence;
      if (presence?.entryAvailable && presence.entryKind === 'satellite') {
        doc?.getElementById('cockpit-entry')?.click();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  function askText(prompt) {
    voice.controls?.emit('chat-restore');
    voice.controls?.emit('chat-prompt', prompt);
    voice.controls?.emit('chat-submit');
  }

  function ask(card) {
    const where =
      Number.isFinite(card.lat) && Number.isFinite(card.lon)
        ? ` at ${card.lat.toFixed(3)}, ${card.lon.toFixed(3)}`
        : '';
    const prompt = `Tell me about the ${card.kind} ${card.title} (${card.layerName})${where}, and what is around it.`;
    voice.controls?.emit('chat-restore');
    voice.controls?.emit('chat-prompt', prompt);
    voice.controls?.emit('chat-submit');
  }

  store.connect({
    dataManager: getDataManager,
    openPanel,
    flyTo,
    follow,
    letGo,
    isOpen,
    regionalBrief,
    // The renderer's card previews, when it has them.
    previews: () => applicationHooksOf(rendererOf(viewer)).cardPreviews ?? null,
    ask,
    askText,
    cockpit,
    canCockpit: (card) =>
      Boolean(omnibar.runner) && COCKPIT_LAYERS.has(card?.layerId),
    canFollow: (card) => FOLLOWABLE.has(card?.layerId),
    // Where the camera is, so a search prefers what is close by.
    here: () => {
      const pose = camera()?.pose();
      return pose && Number.isFinite(pose.lat) && Number.isFinite(pose.lon)
        ? { lat: pose.lat, lon: pose.lon }
        : null;
    },
  });

  // What the camera shows, for the Context panel to describe when nothing is
  // picked: the ground under the middle of the screen, the view's bounds and
  // the height. Read when the camera settles, not every frame.
  const readView = () => {
    const port = camera();
    if (!port || !isOpen()) return;
    const pose = port.pose();
    if (![pose.lat, pose.lon, pose.height].every(Number.isFinite)) return;
    const middle = pickWorld?.(viewer, 0.5, 0.5);
    const center = middle
      ? { lat: middle.lat, lon: middle.lon }
      : { lat: pose.lat, lon: pose.lon };
    const rect = port.viewRectangle() ?? {
      west: -180,
      south: -90,
      east: 180,
      north: 90,
    };
    store.setView({ center, rect, heightM: pose.height });
  };
  // Read when the camera settles. A camera that keeps moving (following an
  // aircraft, a long fly-to) never settles, and a jump (a share link, a
  // restored view) raises no moveEnd, so also read it on large changes: at
  // most once a second, and once more after the last change, so the view it
  // stops at is the one described.
  let lastRead = 0;
  let trailing = null;
  const onChanged = () => {
    clearTimeout(trailing);
    const now = performance.now();
    if (now - lastRead >= 1000) {
      lastRead = now;
      readView();
      return;
    }
    trailing = setTimeout(
      () => {
        lastRead = performance.now();
        readView();
      },
      1000 - (now - lastRead),
    );
  };
  let cameraOff = [];
  const listen = () => {
    const port = camera();
    if (!port || cameraOff.length) return;
    cameraOff = [port.on('moveEnd', readView), port.on('changed', onChanged)];
  };
  listen();
  const firstRead = setTimeout(() => {
    listen();
    readView();
  }, 0);
  // Opening the panel describes the view as it is now.
  let wasOpen = isOpen();
  const offChrome = chrome.$subscribe(() => {
    const open = isOpen();
    if (open && !wasOpen) readView();
    wasOpen = open;
  });

  /** Layers whose own map click already follows what was clicked. */
  const CLICK_FOLLOWS = new Set(['flights', 'military', 'satellites']);

  // Keep the card's "following" in step with the camera: it says Following
  // while the camera follows the card's own item (the follow's key names
  // it) and not otherwise, whoever started or ended the follow. A layer
  // switching what it follows lets go for a moment and takes hold again in
  // the same turn, so this is checked once that settles.
  let followCheck = 0;
  const offFollow = onFollowChanged(viewer, () => {
    clearTimeout(followCheck);
    const card = store.card;
    // Taking hold of the card's item shows at once; letting go waits a
    // moment, in case the layer is only switching follows.
    if (followsCard(card)) {
      store.following = card.key;
      return;
    }
    followCheck = setTimeout(() => {
      const now = store.card;
      store.following = followsCard(now) ? now.key : null;
    }, 250);
  });

  // A click on anything a layer can identify opens its card. The input
  // dispatcher hands every subscriber the same click, picked once before
  // any layer acts on it, and only while no tool holds the pointer.
  const offClick = inputFor(viewer).onClick((event) => {
    // Cockpit has its own picks, and Context is hidden while it runs. A
    // camera drag never selects, even if it ends over something.
    if (inCockpit() || !isTrackingSelectionGesture(event.gesture)) return;
    const identity = resolvePickedContext(event.hit, {
      dataManager: getDataManager(),
    });
    if (identity) {
      // These layers start following on their own click; following again
      // from here would fight them (the flights layer reads a second track
      // of the same plane as a click on empty map and lets go).
      store.select(identity, { follow: !CLICK_FOLLOWS.has(identity.layerId) });
      return;
    }
    // A click on open ground, sea or sky lets go of what was selected. A
    // click on something else Context cannot describe (a label, a trail)
    // leaves the card as it is.
    // Only a clean click lets go, as the layers' own clicks do; a card
    // painted on the overlay (a vessel's, a fire's) is not open map.
    if (
      event.surface &&
      isTrackingClickGesture(event.gesture) &&
      !overlayHit?.(event.screenPosition?.x, event.screenPosition?.y)
    )
      store.clear();
  });

  // Layers that select through the context store (GeoJSON sites, fires,
  // installations) announce it; their selection opens the card too.
  const onSelected = ({ detail: record }) => {
    if (!record?.layerId || inCockpit()) return;
    store.select({
      layerId: record.layerId,
      id: record.id,
      label: record.label || record.properties?.name,
      lat: record.latitude,
      lon: record.longitude,
    });
  };
  globalThis.addEventListener?.('gev:entity-selected', onSelected);

  return () => {
    disposed = true;
    clearTimeout(firstRead);
    offClick();
    for (const off of cameraOff) off?.();
    clearTimeout(trailing);
    offFollow();
    offChrome();
    clearTimeout(followCheck);
    globalThis.removeEventListener?.('gev:entity-selected', onSelected);
    store.connect(null);
  };
}
