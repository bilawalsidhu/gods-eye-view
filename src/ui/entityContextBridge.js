import * as Cesium from 'cesium';
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
const FOLLOWABLE = new Set([
  'flights',
  'military',
  'ais-live-vessels',
  'satellites',
]);

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
 * @returns {() => void} disconnects
 */
export function installEntityContext({
  viewer,
  getDataManager,
  pinia,
  pickWorld,
  regionalBrief,
}) {
  const store = useEntityCardStore(pinia);
  const omnibar = useOmnibarStore(pinia);
  const voice = useVoiceStore(pinia);
  const cockpitStore = useCockpitStore(pinia);
  const doc = globalThis.document;
  let disposed = false;
  // When the card last asked the camera to follow its item: the tracking
  // that starts right after is the card's own (see trackedEntityChanged).
  let pickedAt = -Infinity;
  /** The entity the camera follows for the card, once its tracking starts. */
  let cardTracked = null;
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
    pickedAt = performance.now();
    Promise.resolve(
      run('track_entity', {
        query: card.identity.id || card.title,
        layerId: card.layerId,
      }),
    ).catch(() => {});
  }

  // Closing the card lets go of the camera, when the camera follows the
  // card's own item and nothing else took it over since.
  function letGo() {
    const run = omnibar.runner;
    if (!run || !cardTracked || viewer.trackedEntity !== cardTracked) return;
    cardTracked = null;
    Promise.resolve(run('stop_tracking', {})).catch(() => {});
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
    pickedAt = performance.now();
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
    regionalBrief,
    ask,
    askText,
    cockpit,
    canCockpit: (card) =>
      Boolean(omnibar.runner) && COCKPIT_LAYERS.has(card?.layerId),
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
    const middle = pickWorld?.(viewer, 0.5, 0.5);
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
  // settles, and a jump (a share link, a restored view) raises no moveEnd,
  // so also read it on large changes: at most once a second, and once more
  // after the last change, so the view it stops at is the one described.
  let lastRead = 0;
  let trailing = null;
  const removeChanged = viewer.camera.changed.addEventListener(() => {
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
  });
  const firstRead = setTimeout(readView, 0);

  /** Layers whose own map click already follows what was clicked. */
  const CLICK_FOLLOWS = new Set([
    'flights',
    'military',
    'satellites',
    'ais-live-vessels',
  ]);

  // Keep the card's "following" in step with the camera. When the camera
  // stops following (Escape, another tool, the craft gone) the card stops
  // saying so, and picking the same item again follows it again; when one of
  // the layers above starts following from its own click, the card says so.
  // A layer switching what it follows lets go for a moment and takes hold
  // again in the same turn, so this is checked once that settles.
  // The entity the camera follows for the card: taken when the card's own
  // pick starts the tracking, so tracking something else (another control,
  // another craft) is not mistaken for following the card.
  let trackCheck = 0;
  const removeTrackedChanged = viewer.trackedEntityChanged.addEventListener(
    () => {
      clearTimeout(trackCheck);
      trackCheck = setTimeout(() => {
        const tracked = viewer.trackedEntity;
        if (!tracked) {
          cardTracked = null;
          store.following = null;
          return;
        }
        const card = store.card;
        const fromPick = performance.now() - pickedAt < 1500;
        if (
          fromPick &&
          card &&
          (store.following === card.key || CLICK_FOLLOWS.has(card.layerId))
        ) {
          cardTracked = tracked;
          store.following = card.key;
        } else if (tracked !== cardTracked) {
          store.following = null;
        }
      }, 250);
    },
  );

  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  // What is under the pointer is read when the button goes down: by the time
  // the click arrives, a layer may already have acted on it (the flights
  // layer swaps a clicked plane's icon for its model), and a pick then would
  // find whatever was behind it.
  const pickAt = (position) => {
    try {
      return viewer.scene.pick(position) ?? null;
    } catch {
      return null;
    }
  };
  let pressed = null;
  handler.setInputAction(({ position }) => {
    pressed = isPointerFree()
      ? { picked: pickAt(position), x: position.x, y: position.y }
      : null;
  }, Cesium.ScreenSpaceEventType.LEFT_DOWN);
  handler.setInputAction(({ position }) => {
    // A tool that owns the pointer (draw, measure) keeps its clicks.
    const press = pressed;
    pressed = null;
    // Cockpit has its own picks, and Context is hidden while it runs.
    if (!isPointerFree() || inCockpit()) return;
    const samePlace =
      press && Math.hypot(press.x - position.x, press.y - position.y) < 6;
    const picked = samePlace ? press.picked : pickAt(position);
    const identity = resolvePickedContext(picked, {
      dataManager: getDataManager(),
    });
    if (identity) {
      // These layers start following on their own click; following again
      // from here would fight them (the flights layer reads a second track
      // of the same plane as a click on empty map and lets go).
      pickedAt = performance.now();
      store.select(identity, { follow: !CLICK_FOLLOWS.has(identity.layerId) });
      return;
    }
    // A click on open ground, sea or sky lets go of what was selected; the
    // photorealistic ground is a tileset, so a click on it counts as ground.
    // A click on something else Context cannot describe (a label, a trail)
    // leaves the card as it is.
    if (!picked || picked.primitive instanceof Cesium.Cesium3DTileset)
      store.clear();
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

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
    handler.destroy();
    removeMoveEnd();
    removeChanged();
    clearTimeout(trailing);
    removeTrackedChanged();
    clearTimeout(trackCheck);
    globalThis.removeEventListener?.('gev:entity-selected', onSelected);
    store.connect(null);
  };
}
