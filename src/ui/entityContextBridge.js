import {
  ACARTIA_PRECISION_DEG,
  OBSCURED_CELL_DEG,
} from '../layers/wildlifeSightings/records.js';
import { ref, shallowRef, watch } from 'vue';
import { resolvePickedContext } from '../data/pickedContext.js';
import { onScreen } from '../data/locate.js';
import { clickCard } from '../data/pickRegistry.js';
import { followedOf, onFollowChanged } from '../data/followed.js';
import { currentSelection, onSelectionChanged } from '../data/clickSelect.js';
import { _connectContextCard, _mapSelectionChanged } from './contextCard.js';
import { fromDegreesInto } from '../geo/ellipsoid.js';
import { inputFor } from '../input/dispatcher.js';
import {
  isTrackingClickGesture,
  isTrackingSelectionGesture,
} from '../data/trackingClickGesture.js';
import { applicationHooksOf } from '../render/applicationHooks.js';
import { findCamera, rendererOf } from '../render/rendererOf.js';
import { WORLD_FOCUS_FRAMING } from '../worldFocus.js';
import { useCockpitStore } from './stores/cockpit.js';
import { isGlobeView, useEntityCardStore } from './stores/entityCard.js';
import { useOmnibarStore } from './stores/omnibar.js';
import { usePanelChromeStore } from './stores/panelChrome.js';
import { useSpaceMissionsStore } from './stores/spaceMissions.js';
import { useVoiceStore } from './stores/voice.js';
import { inspectorHasLayers } from './layerRowState.js';
import { createViewWeather } from './viewWeather.js';

/** Camera distance (m) that frames an item of each kind. */
const FRAME_RANGE = Object.freeze({
  aircraft: 30_000,
  vessel: 9_000,
  satellite: 2_500_000,
  earthquake: 120_000,
  storm: 1_500_000,
  fire: 20_000,
  'fire perimeter': 40_000,
  'road segment': 3_000,
});
const DEFAULT_RANGE = 8_000;
/**
 * Items the camera can follow: their layers follow through the camera port
 * with a key naming the item (src/data/followed.js).
 */
const FOLLOWABLE = new Set([
  'flights',
  'military',
  'satellites',
  'ais-live-vessels',
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
 * @param {(lat: number, lon: number, options?: {signal?: AbortSignal}) => Promise<object>} [options.regionalBrief]
 *   Provides weather for selected cards and is the Inspector's fallback
 *   when no point-weather adapter is supplied.
 * @param {(lat: number, lon: number, options?: {signal?: AbortSignal}) => Promise<object>} [options.spotWeather]
 *   The weather-only service for the unselected view.
 * @param {(fly: () => void) => unknown} [options.navigateToSelection] Hand an explicit row flight to the navigation owner.
 * @param {{counts: object}} [options.inspector] The Inspector count owner (createLayerCounts).
 * @returns {() => void} disconnects
 */
export function installEntityContext({
  viewer,
  getDataManager,
  pinia,
  pickWorld,
  regionalBrief,
  spotWeather,
  inspector,
  navigateToSelection = (fly) => fly(),
}) {
  const store = useEntityCardStore(pinia);
  const omnibar = useOmnibarStore(pinia);
  const voice = useVoiceStore(pinia);
  const cockpitStore = useCockpitStore(pinia);
  const chrome = usePanelChromeStore(pinia);
  /** Whether Context is open. (readView also reads while the Omnibar is focused.) */
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

  /**
   * The flight that frames `card`'s item at its kind's range, or null when
   * there is no camera or the card has no place.
   */
  function framingFlight(card) {
    const port = camera();
    if (!port || !Number.isFinite(card?.lat) || !Number.isFinite(card?.lon))
      return null;
    const height = card.pinHeightM ?? card.altitudeM ?? 0;
    const framing = card.obscured ? WORLD_FOCUS_FRAMING['sighting-area'] : null;
    const pitchDeg =
      framing?.pitchDeg ?? (card.kind === 'satellite' ? -90 : -45);
    const range = framing?.rangeM ?? FRAME_RANGE[card.kind] ?? DEFAULT_RANGE;
    const fly = () =>
      port.flyToBounds(
        {
          center: fromDegreesInto(card.lon, card.lat, Math.max(0, height), {
            x: 0,
            y: 0,
            z: 0,
          }),
          radius: framing?.radiusM ?? 1,
        },
        {
          offset: {
            heading: port.pose().heading,
            pitch: (pitchDeg * Math.PI) / 180,
            range,
          },
          durationS: 2,
        },
      );
    return fly;
  }

  function flyTo(card, { fromSelection = false } = {}) {
    const fly = framingFlight(card);
    if (!fly) return;
    if (fromSelection) return navigateToSelection(fly);
    return fly();
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

  /** Whether `card`'s item is the one selection (src/data/clickSelect.js). */
  // A layer whose cards name an item otherwise than its selection does (a
  // vehicle's label, a callsign) answers for it (`isSelected`); never a
  // different item of the same layer.
  const selectsCard = (card, selection = currentSelection()) => {
    if (!card || !selection || selection.layerId !== card.layerId) return false;
    const id = card.identity?.id;
    const module = getDataManager()?.layers?.get?.(card.layerId)?.module;
    if (typeof module?.isSelected === 'function') {
      try {
        return module.isSelected(id) === true;
      } catch {
        return false;
      }
    }
    return selection.id === String(id);
  };

  // A pick from a Context row or a search selects the item in its layer, as
  // a click does (track, trail or orbit shown, the one selection), without
  // following it; the camera frames it at its kind's range, as it always
  // has for a pick, wherever it is. An item its layer cannot select now
  // (gone from its feed, its layer off) is framed all the same. True when
  // its layer can take picks.
  function pick(card) {
    const module = getDataManager()?.layers?.get?.(card?.layerId)?.module;
    const id = card?.identity?.id;
    if (typeof module?.pickById !== 'function' || !id) return false;
    const fly = framingFlight(card);
    navigateToSelection(() => {
      try {
        module.pickById(id, { origin: 'user', center: false });
      } catch {
        // A layer going away meanwhile has nothing to select.
      }
      return fly?.();
    });
    return true;
  }

  // Closing the card lets go of its item: the layer deselects it (and lets
  // go of the camera, when the camera follows it), unless something else
  // took over since.
  function letGo(card) {
    if (!followsCard(card) && !selectsCard(card)) return;
    // Only the card's own layer lets go, as the person's own action; other
    // layers' selections stay as they are. A layer that takes `globeView`
    // (satellites) brings a camera that followed the item back to the globe.
    const layer = getDataManager()?.layers?.get?.(card.layerId);
    try {
      const module = layer?.module;
      if (typeof module?.stopTracking === 'function')
        module.stopTracking({ origin: 'user', globeView: true });
      else module?.clearSelection?.();
    } catch {
      // A layer going away meanwhile has nothing left to let go of.
    }
  }

  // An item back in its feed after it left it is selected again in its layer,
  // as the click that picked it: a vessel is highlighted with its trail, and
  // an aircraft or vessel found again (`follow`) is followed.
  function reselect(card, { follow: andFollow = false } = {}) {
    const layer = getDataManager()?.layers?.get?.(card?.layerId)?.module;
    const id = card?.identity?.id;
    if (!layer || !id) return;
    try {
      if (andFollow && FOLLOWABLE.has(card.layerId)) follow(card);
      else if (card.layerId === 'ais-live-vessels') layer.selectById?.(id);
    } catch {
      // A layer going away meanwhile has nothing to select.
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

  function askText(prompt, reference, resolveReference) {
    voice.controls?.emit('chat-restore');
    voice.controls?.emit(
      'chat-prompt',
      reference ? { text: prompt, reference, resolveReference } : prompt,
    );
    voice.controls?.emit('chat-submit');
  }

  function mapItemReference(card) {
    // A sighting gone from the feed, or no longer confirmed, may have been hidden.
    const hidden = store.locationWithheld;
    // Acartia rounds observation coordinates to ACARTIA_PRECISION_DEG.
    const rounded = !hidden && card.source === 'Acartia';
    const digits = rounded ? 2 : 3;
    const coordinates = {
      ...(rounded && { roundedToDegrees: ACARTIA_PRECISION_DEG }),
      lat:
        !hidden && Number.isFinite(card.lat)
          ? Number(card.lat.toFixed(digits))
          : null,
      lon:
        !hidden && Number.isFinite(card.lon)
          ? Number(card.lon.toFixed(digits))
          : null,
    };
    return {
      name: card.title,
      kind: card.kind,
      layer: card.layerName,
      ...(!hidden && card.obscured
        ? {
            approximateCellCenter: {
              ...coordinates,
              cellSizeDegrees: OBSCURED_CELL_DEG,
            },
          }
        : coordinates),
    };
  }

  function ask(card) {
    const reference = mapItemReference(card);
    // Read the card again at send time. Once another card is open, omit the position.
    const resolveReference = () => {
      store.refresh({ forAction: true });
      return store.card?.key === card.key
        ? mapItemReference(store.card)
        : {
            name: reference.name,
            kind: reference.kind,
            layer: reference.layer,
          };
    };
    askText(
      'Tell me about this map item and what is around it.',
      reference,
      resolveReference,
    );
  }

  store.connect({
    dataManager: getDataManager,
    openPanel,
    flyTo,
    pick,
    follow,
    letGo,
    reselect,
    // Whether the camera shows the card's item; null when it cannot tell.
    onScreen: (card) => {
      const pose = camera()?.pose();
      if (!pose || !Number.isFinite(card?.lat) || !Number.isFinite(card?.lon))
        return null;
      return onScreen(
        pose,
        card.lat,
        card.lon,
        card.pinHeightM ?? card.altitudeM ?? 0,
      );
    },
    isOpen,
    regionalBrief,
    spotWeather,
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
  // the height. Read when the camera settles and at most once a second while it
  // moves. A read taken during movement has `settled` false.
  let hasCameraSnapshot = false;
  const motionPending = ref(false);
  const readView = ({ settled = !moving && quiet === null } = {}) => {
    const port = camera();
    if (!port || (!isOpen() && doc?.activeElement?.id !== 'gev-omnibar-input'))
      return;
    const pose = port.pose();
    // An invalid pose keeps the previous snapshot and leaves the motion fence set.
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
    hasCameraSnapshot = true;
    store.setView(
      {
        center,
        rect,
        heightM: pose.height,
        // The horizon is measured from the camera, independently of screen center.
        eye: { lat: pose.lat, lon: pose.lon },
      },
      { settled },
    );
    // Release the weather motion fence only after a valid settled snapshot.
    if (settled) motionPending.value = false;
  };
  let lastRead = 0;
  let trailing = null;
  let quiet = null;
  let moving = false;
  const stopQuiet = () => {
    clearTimeout(quiet);
    quiet = null;
  };
  const onChanged = () => {
    motionPending.value = true;
    clearTimeout(trailing);
    stopQuiet();
    // A view jump can settle without moveEnd. An ongoing move needs moveEnd.
    if (!moving) {
      quiet = setTimeout(() => {
        quiet = null;
        readView();
      }, 1200);
    }
    // Following and panning publish at most once a second while moving.
    const now = performance.now();
    if (now - lastRead >= 1000) {
      lastRead = now;
      readView({ settled: false });
      return;
    }
    trailing = setTimeout(
      () => {
        lastRead = performance.now();
        readView({ settled: false });
      },
      1000 - (now - lastRead),
    );
  };
  let cameraOff = [];
  const listen = () => {
    const port = camera();
    if (!port || cameraOff.length) return;
    cameraOff = [
      port.on('moveStart', () => {
        moving = true;
        motionPending.value = true;
        stopQuiet();
        readView();
      }),
      port.on('moveEnd', () => {
        moving = false;
        motionPending.value = true;
        clearTimeout(trailing);
        stopQuiet();
        readView();
      }),
      port.on('changed', onChanged),
    ];
  };
  listen();
  const firstRead = setTimeout(() => {
    listen();
    readView();
  }, 0);
  // The Omnibar's nearby suggestions also need a fresh center even with
  // Context closed. Its focus event requests one camera read.
  const onSearchFocus = (event) => {
    if (event.target?.id === 'gev-omnibar-input') readView();
  };
  doc?.addEventListener('focusin', onSearchFocus);
  // Opening the panel describes the view as it is now.
  let wasOpen = isOpen();
  const offChrome = chrome.$subscribe(() => {
    const open = isOpen();
    if (open && !wasOpen) readView();
    wasOpen = open;
  });

  const stopInspectorWatchers = [];
  let weather;
  if (inspector) {
    const missions = useSpaceMissionsStore(pinia);
    const shown = () => store.inspector.shown;
    const mountId = () => store.inspector.mountId;
    const manager = () => {
      // A replacement can reveal a new registry without a feed update.
      void store.managerVersion;
      return getDataManager?.() ?? null;
    };
    const globe = () => isGlobeView(store.view);
    const countInputs = [
      shown,
      () => store.layerRevision,
      () => missions.enabled,
      () => store.inspectorPulse,
    ];
    const metadataInputs = [...countInputs, manager, globe];
    const metadataReady = ref(false);
    const countSample = shallowRef(null);
    let appliedSample = { inputs: metadataInputs.map((read) => read()) };
    const readCurrentInput = () => ({
      center: hasCameraSnapshot && !globe() ? store.view?.center : null,
      moving: motionPending.value,
      shown: store.inspector.shown,
      mountId: mountId(),
    });
    store.publishInspectorRows([]);
    store.publishViewWeather(null);
    weather = createViewWeather({
      read: store.readWeather,
      readCurrentInput,
      publish: store.publishViewWeather,
    });

    stopInspectorWatchers.push(
      watch(
        [countSample, ...metadataInputs],
        ([sample, ...live]) => {
          if (!sample || sample === appliedSample) return;
          const { inputs, rows } = sample;
          // A preceding post-flush callback may make the sample stale.
          // Let the pre-flush publisher sample the latest inputs first.
          if (inputs.some((value, index) => value !== live[index])) return;
          const [visible, , missionsEnabled] = inputs;
          appliedSample = sample;
          if (!visible || !store.inspector.shown) {
            inspector.counts.update({ shown: false, nothingOn: false });
            return;
          }
          inspector.counts.update({
            shown: true,
            nothingOn: !inspectorHasLayers(rows, missionsEnabled),
          });
        },
        { flush: 'post' },
      ),
      // Rows are published pre-flush for rendering and focus recovery. Only
      // shown, layers, Space Missions and pulse changes take a new count
      // sample. Manager and globe changes only republish rows.
      watch(
        [metadataReady, ...metadataInputs],
        ([, ...inputs], [initialized, ...previous]) => {
          const rows = inputs[0] ? store.allLayers() : [];
          if (inputs[0]) store.publishInspectorRows(rows);
          const pending =
            countSample.value && countSample.value !== appliedSample;
          if (
            !initialized ||
            pending ||
            inputs
              .slice(0, countInputs.length)
              .some((value, index) => value !== previous[index])
          )
            countSample.value = { inputs, rows };
        },
      ),
      watch(
        [
          shown,
          mountId,
          () => store.view,
          motionPending,
          () => store.inspectorPulse,
        ],
        (current, previous) => {
          const input = readCurrentInput();
          weather.update(input);
          if (
            input.shown &&
            previous.length &&
            current.at(-1) !== previous.at(-1)
          )
            weather.pulse();
        },
        { immediate: true, flush: 'post' },
      ),
    );
    // Let a manager attached later in setup join the first pre-flush sample.
    metadataReady.value = true;
  }

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

  // Custom layers open the card through ui/contextCard.js.
  const offSelection = onSelectionChanged(_mapSelectionChanged);
  const offCard = _connectContextCard({
    // Nothing opens in Cockpit, as for a click.
    select: (item) => !inCockpit() && store.select(item),
    clear: () => store.clear(),
  });

  // A click on anything a layer can identify opens its card. The input
  // dispatcher hands every subscriber the same click, picked once before
  // any layer acts on it, and only while no tool holds the pointer.
  const offClick = inputFor(viewer).onClick((event) => {
    // Cockpit has its own picks, and Context is hidden while it runs. A
    // camera drag never selects, even if it ends over something.
    if (inCockpit() || !isTrackingSelectionGesture(event.gesture)) return;
    // A card or label painted on top is its layer's click, read once per
    // click so every layer agrees: Context names nothing under it and keeps
    // its own card as it is.
    if (clickCard(event)) return;
    const identity = resolvePickedContext(event.hit, {
      dataManager: getDataManager(),
    });
    if (identity) {
      // The layer's own click selects and centres it; the card only opens
      // (src/data/clickSelect.js).
      const picked =
        identity.layerId === 'ais-live-vessels'
          ? { ...identity, vesselId: identity.id }
          : identity;
      store.select(picked);
      return;
    }
    // A click on open ground, sea or sky lets go of what was selected. A
    // click on something else Context cannot describe (a label, a trail)
    // leaves the card as it is.
    // Only a clean click lets go, as the layers' own clicks do.
    if (event.surface && isTrackingClickGesture(event.gesture)) store.clear();
  });

  // Layers that select through the context store (GeoJSON sites, fires,
  // installations) announce it; their selection opens the card too.
  const onSelected = ({ detail: record }) => {
    if (!record?.layerId || inCockpit()) return;
    const vesselId =
      record.layerId === 'ais-live-vessels'
        ? record.properties?.vesselId
        : null;
    store.select({
      layerId: record.layerId,
      id: vesselId ? String(vesselId) : record.id,
      ...(vesselId ? { vesselId: String(vesselId) } : {}),
      label: record.label || record.properties?.name,
      lat: record.latitude,
      lon: record.longitude,
    });
  };
  globalThis.addEventListener?.('gev:entity-selected', onSelected);

  return () => {
    if (disposed) return;
    disposed = true;
    for (const stop of stopInspectorWatchers) stop();
    weather?.stop();
    inspector?.counts.stop();
    if (inspector) {
      store.publishInspectorRows([]);
      store.publishViewWeather(null);
    }
    clearTimeout(firstRead);
    offClick();
    offCard();
    offSelection();
    for (const off of cameraOff) off?.();
    clearTimeout(trailing);
    clearTimeout(quiet);
    offFollow();
    offChrome();
    doc?.removeEventListener('focusin', onSearchFocus);
    clearTimeout(followCheck);
    globalThis.removeEventListener?.('gev:entity-selected', onSelected);
    store.connect(null);
  };
}
