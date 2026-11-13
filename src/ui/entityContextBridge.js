import * as Cesium from 'cesium';
import { pickWorldFromScreen } from '../annotations/annotationResolver.js';
import { resolvePickedContext } from '../data/pickedContext.js';
import { isPointerFree } from '../data/inputOwnership.js';
import { useCockpitStore } from './stores/cockpit.js';
import { useEntityCardStore } from './stores/entityCard.js';
import { useOmnibarStore } from './stores/omnibar.js';
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
/** Items the voice runtime can keep the camera on. */
const FOLLOWABLE = new Set(['flights', 'military', 'ais-live-vessels', 'satellites']);

/**
 * Connects the Context panel's entity card to the globe: a click on anything a
 * layer can identify opens its card, and the card's actions fly to it, follow
 * it or ask GEV about it. Layers keep their own click behaviour; this listens
 * alongside them.
 * @param {object} options
 * @param {object} options.viewer Cesium viewer.
 * @param {() => object} options.getDataManager Layer lifecycle.
 * @param {object} options.pinia
 * @returns {() => void} disconnects
 */
export function installEntityContext({ viewer, getDataManager, pinia }) {
  const store = useEntityCardStore(pinia);
  const omnibar = useOmnibarStore(pinia);
  const voice = useVoiceStore(pinia);
  const cockpitStore = useCockpitStore(pinia);
  const doc = globalThis.document;

  function openPanel() {
    const button = doc?.querySelector(
      '.ui-rail--right .ui-rail__item[data-rail-item="global-context-panel"]',
    );
    if (button && button.getAttribute('aria-pressed') !== 'true') button.click();
  }

  function flyTo(card) {
    if (!Number.isFinite(card?.lat) || !Number.isFinite(card?.lon)) return;
    const height = Number.isFinite(card.altitudeM) ? card.altitudeM : 0;
    const range = FRAME_RANGE[card.kind] ?? DEFAULT_RANGE;
    viewer.camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(
        Cesium.Cartesian3.fromDegrees(card.lon, card.lat, Math.max(0, height)),
        1,
      ),
      {
        offset: new Cesium.HeadingPitchRange(
          viewer.camera.heading,
          Cesium.Math.toRadians(card.kind === 'satellite' ? -90 : -45),
          range,
        ),
        duration: 2,
      },
    );
  }

  function follow(card) {
    const run = omnibar.runner;
    if (!run || !FOLLOWABLE.has(card.layerId)) return flyTo(card);
    void run('track_entity', {
      query: card.identity.id || card.title,
      layerId: card.layerId,
    });
  }

  // Aircraft can be flown from, and a satellite ridden in the orbital view:
  // track the craft, then enter Cockpit on it.
  const COCKPIT_LAYERS = new Set(['flights', 'military', 'local-adsb', 'satellites']);
  async function cockpit(card) {
    const run = omnibar.runner;
    if (!run || !COCKPIT_LAYERS.has(card.layerId)) return;
    await run('track_entity', { query: card.identity.id || card.title, layerId: card.layerId });
    if (card.layerId !== 'satellites') {
      await run('control_cockpit', { action: 'enter' });
      return;
    }
    // A satellite is ridden through the app's own Cockpit entry, which offers
    // the orbital view once the satellite is tracked. Wait for it to say so;
    // if it never does (a class that cannot be ridden), nothing is entered.
    for (let tries = 0; tries < 40; tries++) {
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
    ask,
    askText,
    cockpit,
    canCockpit: (card) => Boolean(omnibar.runner) && COCKPIT_LAYERS.has(card?.layerId),
    canFollow: (card) => FOLLOWABLE.has(card?.layerId),
    // Where the camera is, so a search prefers what is close by.
    here: () => {
      const at = viewer.camera.positionCartographic;
      return at
        ? {
            lat: Cesium.Math.toDegrees(at.latitude),
            lon: Cesium.Math.toDegrees(at.longitude),
          }
        : null;
    },
  });

  // What the camera shows, for the Context panel to describe when nothing is
  // picked: the ground under the middle of the screen, the view's bounds and
  // the height. Read when the camera settles, not every frame.
  const readView = () => {
    const camera = viewer.camera;
    const height = camera.positionCartographic?.height ?? 0;
    const middle = pickWorldFromScreen(viewer, 0.5, 0.5);
    const center = middle
      ? { lat: middle.lat, lon: middle.lon }
      : {
          lat: Cesium.Math.toDegrees(camera.positionCartographic.latitude),
          lon: Cesium.Math.toDegrees(camera.positionCartographic.longitude),
        };
    const r = camera.computeViewRectangle?.(viewer.scene.globe.ellipsoid);
    const rect = r
      ? {
          west: Cesium.Math.toDegrees(r.west),
          south: Cesium.Math.toDegrees(r.south),
          east: Cesium.Math.toDegrees(r.east),
          north: Cesium.Math.toDegrees(r.north),
        }
      : { west: -180, south: -90, east: 180, north: 90 };
    store.setView({ center, rect, heightM: height });
  };
  const removeMoveEnd = viewer.camera.moveEnd.addEventListener(readView);
  // A camera that keeps moving (following an aircraft, a long fly-to) never
  // settles, so also read it on large changes, at most once a second.
  let lastRead = 0;
  const removeChanged = viewer.camera.changed.addEventListener(() => {
    const now = performance.now();
    if (now - lastRead < 1000) return;
    lastRead = now;
    readView();
  });
  setTimeout(readView, 0);

  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction(({ position }) => {
    // A tool that owns the pointer (draw, measure) keeps its clicks.
    if (!isPointerFree()) return;
    let picked = null;
    try {
      picked = viewer.scene.pick(position);
    } catch {
      picked = null;
    }
    const identity = resolvePickedContext(picked, {
      dataManager: getDataManager(),
    });
    // A click on open ground or sea selects nothing and leaves the card as it is.
    if (identity) store.select(identity);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // Layers that select through the context store (GeoJSON sites, fires,
  // installations) announce it; their selection opens the card too.
  const onSelected = ({ detail: record }) => {
    if (!record?.layerId) return;
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
    handler.destroy();
    removeMoveEnd();
    removeChanged();
    globalThis.removeEventListener?.('gev:entity-selected', onSelected);
    store.connect(null);
  };
}
