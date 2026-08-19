/**
 * Bootstrap and wiring. No behaviour lives here.
 *
 * Everything is a construction or a subscription: the globe, the layer, the three panels,
 * the socket, and the lines that connect them. If something in here starts making a
 * decision, it belongs in the module that owns that decision.
 */

import './style.css';

import { AircraftLayer } from './globe/layers/aircraft';
import { createGlobe, installPicking, startMotionLoop } from './globe/viewer';
import { fetchAircraft, fetchCapabilities, fetchHealth } from './net/api';
import { LiveFeed, liveFeedUrl } from './net/ws';
import { store } from './state/store';
import { AttributionPanel } from './ui/attribution';
import { InfoCard } from './ui/card';
import { StatusBanner } from './ui/status';

function element(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`#${id}`);
  if (found === null) {
    throw new Error(`index.html is missing #${id}`);
  }
  return found;
}

const globe = createGlobe(element('globe'));
const aircraft = new AircraftLayer(globe.viewer.scene);
const card = new InfoCard(element('card'), {
  onClose: () => {
    store.select(null);
  },
});
const attribution = new AttributionPanel(element('attribution'));
const status = new StatusBanner(element('status'));

store.onChange((batch) => {
  aircraft.apply(batch);
  globe.requestRender();
});
store.onChange((batch) => {
  status.update(batch.feeds);
});
store.onSelectionChange((selected) => {
  card.show(selected);
  aircraft.setSelected(selected?.aircraft.icao24 ?? null);
  globe.requestRender();
});

installPicking(globe, (id) => {
  store.select(id);
});
startMotionLoop(globe, (nowMs) => aircraft.advance(nowMs));

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
 * The socket is the real source of both the aircraft picture and feed health, so a failure
 * here degrades to whatever the socket delivers a moment later, and the baseline credits
 * stay on screen.
 */
try {
  const capabilities = await fetchCapabilities();
  attribution.render(capabilities.attribution);
  card.setAttribution(capabilities.attribution);

  const health = await fetchHealth();
  status.update(health.feeds);

  const snapshot = await fetchAircraft();
  store.applySnapshot('aircraft', snapshot.aircraft);
} catch (error: unknown) {
  console.error('could not load capabilities or the first snapshot', error);
}
