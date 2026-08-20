/**
 * Bootstrap and wiring. No behaviour lives here.
 *
 * Everything is a construction or a subscription: the globe, the three layers, the four
 * panels, the socket, and the lines that connect them. If something in here starts making a
 * decision, it belongs in the module that owns that decision.
 *
 * This file is excluded from unit coverage because it has no branches of its own. What
 * proves it is `e2e/smoke.spec.ts`, which drives the built bundle in a real browser and
 * asserts that an aircraft, a ship and a satellite all reach the globe.
 */

import './style.css';

import { AircraftLayer } from './globe/layers/aircraft';
import { SatelliteLayer, noradFromPickId } from './globe/layers/satellites';
import { VesselLayer } from './globe/layers/vessels';
import {
  SATELLITE_ELEMENT_RELOAD_MS,
  SatelliteFeed,
  satelliteNotices,
  withDrawnSatelliteCount,
} from './globe/satellites/feed';
import { createGlobe, installPicking, startMotionLoop } from './globe/viewer';
import {
  LAYER_SUMMARY_POLL_MS,
  fetchAircraft,
  fetchCapabilities,
  fetchHealth,
  fetchLayers,
  fetchSatelliteElements,
  fetchVessels,
} from './net/api';
import { LiveFeed, liveFeedUrl } from './net/ws';
import { store } from './state/store';
import type { FeedHealth } from './types/entities';
import { AttributionPanel } from './ui/attribution';
import { InfoCard } from './ui/card';
import { LayerRail } from './ui/layer-rail';
import { StatusBanner } from './ui/status';
import { VesselCard } from './ui/vessel-card';

function element(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`#${id}`);
  if (found === null) {
    throw new Error(`index.html is missing #${id}`);
  }
  return found;
}

const globe = createGlobe(element('globe'));
const aircraft = new AircraftLayer(globe.viewer.scene);
const vessels = new VesselLayer(globe.viewer.scene);
const satellites = new SatelliteLayer(globe.viewer.scene);
const card = new InfoCard(element('card'), {
  onClose: () => {
    store.select(null);
  },
});
// Its own root element, not the aircraft card's: each card owns its root's markup, so two
// of them on one element would leave the first holding detached nodes.
const vesselCard = new VesselCard(element('vessel-card'), {
  onClose: () => {
    store.select(null);
  },
});
const attribution = new AttributionPanel(element('attribution'));
const status = new StatusBanner(element('status'));
const rail = new LayerRail(element('layers'), {
  // The layers this build draws, in rail order. The first two come from the one
  // AircraftLayer, which is why it hides per layer rather than per collection. A layer the
  // server offers and this build cannot draw is listed with its count and no switch, rather
  // than given a switch that does nothing.
  toggleable: ['aircraft', 'military', 'vessels', 'satellites'],
  onToggle: (layer, visible) => {
    if (layer === 'satellites') {
      satellites.setVisible(visible);
    } else if (layer === 'vessels') {
      vessels.setVisible(visible);
    } else {
      aircraft.setVisible(layer, visible);
    }
    globe.requestRender();
  },
});

/**
 * SGP4 in its own thread.
 *
 * A thousand-plus satellites re-propagated every frame is a frame budget the renderer would
 * otherwise be paying, and the acceptance target is 60fps with the whole active catalogue on
 * screen. Positions come back asynchronously and ask for their own frame.
 */
const satelliteFeed = new SatelliteFeed({
  port: new Worker(new URL('globe/satellites/worker.ts', import.meta.url), { type: 'module' }),
  onPositions: (ids, lonLatAlt) => {
    satellites.apply(ids, lonLatAlt);
    globe.requestRender();
  },
  onOrbit: (noradCatId, lonLatAlt) => {
    satellites.setOrbit(noradCatId, lonLatAlt);
    globe.requestRender();
  },
  onState: () => {
    updateRail();
  },
});

/**
 * Paint the rail.
 *
 * The satellite count is rewritten to what the browser is actually drawing. The server's
 * count is the element sets it holds, and an object SGP4 refused or an element set older than
 * 3.5 days is held by the server and not drawn here. That difference is also why the feed's
 * own notice goes on the row: without it the layer would draw less than it holds and say
 * nothing about why.
 */
function updateRail(feeds: readonly FeedHealth[] = store.feeds): void {
  rail.update(
    withDrawnSatelliteCount(feeds, satellites.count),
    satelliteNotices(satelliteFeed.state),
  );
}

/** Read the server's element cache and hand it to the propagation worker. */
async function loadSatelliteElements(): Promise<void> {
  const elements = await fetchSatelliteElements();
  satelliteFeed.load(elements.satellites);
}

store.onChange((batch) => {
  aircraft.apply(batch.aircraft);
  vessels.apply(batch.vessels);
  // A satellite record is an element set rather than a position, so a satellite frame is a
  // change to what the worker propagates from.
  satelliteFeed.apply(batch.satellites);
  globe.requestRender();
});
store.onChange((batch) => {
  status.update(batch.feeds);
});
// Read off the store rather than off the batch: the rail shows the current count per layer,
// which is whatever the last feed_status said, not whatever this frame happened to carry.
store.onChange(() => {
  updateRail();
});
store.onSelectionChange((selected) => {
  const aircraftSelection = selected?.kind === 'aircraft' ? selected : null;
  const vesselSelection = selected?.kind === 'vessel' ? selected : null;
  card.show(aircraftSelection?.aircraft ?? null);
  vesselCard.show(vesselSelection?.vessel ?? null);
  aircraft.setSelected(aircraftSelection?.id ?? null);
  vessels.setSelected(vesselSelection?.id ?? null);
  globe.requestRender();
});

installPicking(globe, (id) => {
  // One click belongs to one layer. The prefix on a satellite primitive's id is what decides
  // which, and the other layers are deselected, which is what closes their cards. An
  // aircraft carries its ICAO address and a vessel its MMSI, so the store resolves the rest.
  const noradCatId = noradFromPickId(id);
  satellites.setSelected(noradCatId);
  satelliteFeed.setSelected(noradCatId);
  store.select(noradCatId === null ? id : null);
  globe.requestRender();
});
startMotionLoop(globe, (nowMs) => {
  satelliteFeed.tick(nowMs);
  // Both, every tick, and never short-circuited: `advance` is what moves a layer, not just
  // what reports on it.
  const movedAircraft = aircraft.advance(nowMs);
  const movedVessels = vessels.advance(nowMs);
  return movedAircraft || movedVessels;
});

// The backend refreshes from CelesTrak at most once per group per two hours; this only ever
// re-reads its cache, so the cadence here costs nothing upstream.
setInterval(() => {
  void (async () => {
    try {
      await loadSatelliteElements();
    } catch (error: unknown) {
      console.error('could not reload orbital elements', error);
    }
  })();
}, SATELLITE_ELEMENT_RELOAD_MS);

/**
 * Per-provider coverage, which the socket does not carry.
 *
 * Feed health arrives on the socket, but ADR 010's per-provider errors and exclusive counts
 * only exist on `/api/layers`, so a provider that fails every cycle is invisible without
 * this poll.
 */
setInterval(() => {
  void (async () => {
    try {
      const summary = await fetchLayers();
      rail.setProviders(summary.providers);
    } catch (error: unknown) {
      console.error('could not read per-provider coverage', error);
    }
  })();
}, LAYER_SUMMARY_POLL_MS);

const feed = new LiveFeed({
  url: liveFeedUrl(),
  apply: (batch) => {
    store.applyBatch(batch);
  },
  onState: (state, retryInMs) => {
    status.setConnection(state, retryInMs);
  },
});
feed.start();

/**
 * The first paint and the licence credits.
 *
 * The socket is the real source of both the moving picture and feed health, so a failure
 * here degrades to whatever the socket delivers a moment later, and the baseline credits
 * stay on screen.
 */
try {
  const capabilities = await fetchCapabilities();
  attribution.render(capabilities.attribution);
  card.setAttribution(capabilities.attribution);
  vesselCard.setAttribution(capabilities.attribution);
  rail.setCapabilities(capabilities.layers, capabilities.attribution);

  const health = await fetchHealth();
  store.setFeeds(health.feeds);
  status.update(health.feeds);
  updateRail(health.feeds);

  const snapshot = await fetchAircraft();
  store.applySnapshot('aircraft', snapshot.aircraft);

  const ships = await fetchVessels();
  store.applyVesselSnapshot(ships.vessels);

  await loadSatelliteElements();

  const summary = await fetchLayers();
  rail.setProviders(summary.providers);
} catch (error: unknown) {
  console.error('could not load capabilities or the first snapshot', error);
}
