/**
 * Bootstrap and wiring. No behaviour lives here.
 *
 * Everything is a construction or a subscription: the globe, the three layers, the four
 * panels, the socket, and the lines that connect them. If something in here starts making a
 * decision, it belongs in the module that owns that decision.
 *
 * This file is excluded from unit coverage because a real Cesium viewer needs WebGL and a
 * top-level await needs a browser. What proves it is `e2e/smoke.spec.ts`, which drives the
 * built bundle in a real browser: an aircraft, a ship and a satellite reach the globe, a
 * shared URL restores the camera and the layer switches, the Cities switch really hides the
 * labels, the search box paints a row and flies the camera, and a failed gazetteer read says
 * so on the rail. What no browser test reaches, because nothing on screen states it, is
 * whether follow mode is engaged: `globe/follow.test.ts` carries that.
 */

import './style.css';

import { flyToPoint } from './globe/flyto';
import { FollowMode, installFollowKey } from './globe/follow';
import { AircraftLayer } from './globe/layers/aircraft';
import type { ClusterState } from './globe/cluster';
import { CITY_LAYER, CityLayer, cityView, geonamesFromPickId } from './globe/layers/cities';
import { CLOUD_LAYER, CLOUD_REFRESH_MS, CloudLayer } from './globe/layers/clouds';
import { SATELLITE_COLOUR, SatelliteLayer, noradFromPickId } from './globe/layers/satellites';
import { SOCIAL_CLUSTER_KEY, SocialLayer } from './globe/layers/social';
import { TRANSIT_CLUSTER_KEY, TransitLayer } from './globe/layers/transit';
import { iconImage } from './globe/icons';
import { CLASS_COLOURS, SOCIAL_COLOUR, TRANSIT_COLOUR } from './globe/palette';
import { UNDER_WAY_COLOUR, VesselLayer } from './globe/layers/vessels';
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
  fetchAircraftDetail,
  fetchCapabilities,
  fetchCities,
  fetchHealth,
  fetchLayers,
  boxMovedEnough,
  fetchSatelliteElements,
  fetchSocial,
  fetchTransit,
  fetchVessels,
  searchAll,
} from './net/api';
import type { BoundingBox } from './net/api';
import { LiveFeed, liveFeedUrl } from './net/ws';
import type { Batch } from './net/ws';
import { store } from './state/store';
import { applyCameraView, parseViewHash, trackViewInUrl } from './state/url';
import type {
  AttributionEntry,
  FeedHealth,
  LayerCapability,
  TransitVehicle,
} from './types/entities';
import { AttributionPanel } from './ui/attribution';
import { InfoCard } from './ui/card';
import { RAIL_MARK_PX, LayerRail, heldCounts } from './ui/layer-rail';
import { PlaceCard } from './ui/place-card';
import { SatelliteCard } from './ui/satellite-card';
import type { SatellitePosition } from './ui/satellite-card';
import { SearchBox, routePick } from './ui/search';
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
const transit = new TransitLayer(globe.viewer.scene);
const social = new SocialLayer(globe.viewer.scene);
const cities = new CityLayer(globe.viewer.scene);
// Imagery rather than primitives, so this one takes the viewer's imagery layers and not its
// scene. It goes on top of the basemap, which is the collection's first entry.
const clouds = new CloudLayer(globe.viewer.imageryLayers);
const card = new InfoCard(element('card'), {
  onClose: () => {
    store.select(null);
  },
  fetchDetail: fetchAircraftDetail,
});
// Its own root element, not the aircraft card's: each card owns its root's markup, so two
// of them on one element would leave the first holding detached nodes.
const vesselCard = new VesselCard(element('vessel-card'), {
  onClose: () => {
    store.select(null);
  },
});
/**
 * The satellite and place cards, which the store knows nothing about.
 *
 * The other two close by deselecting in the store, because the store is what keys them. These
 * two are not in it: a satellite carries an element set and no position, so its position lives
 * in the propagation worker's arrays, and a city is a row of a weekly file with no socket
 * behind it. So closing them means telling them directly, which is what the two helpers below
 * exist for.
 */
const satelliteCard = new SatelliteCard(element('satellite-card'), {
  onClose: () => {
    selectSatellite(null);
    globe.requestRender();
  },
});
const placeCard = new PlaceCard(element('place-card'), {
  onClose: () => {
    selectPlace(null);
  },
});
const attribution = new AttributionPanel(element('attribution'));
const status = new StatusBanner(element('status'));
/**
 * The legend: each layer's own mark, drawn by the same generator the globe uses.
 *
 * Here rather than in the rail because this is the only file that imports every layer, and the
 * five colours live in `globe/palette.ts` and in three layer modules. Building it in the rail
 * would drag Cesium into that module and into its test for the sake of five strings.
 *
 * `iconImage` is what the layers themselves call, so the key cannot disagree with the map. That
 * matters more than it sounds: a hand-drawn legend would have gone stale silently when a shape
 * was renamed, which happened once today.
 *
 * Aircraft take the `unknown` class colour rather than one of the six real ones. It is the honest
 * choice: the row stands for every civil aircraft whatever its class, and it is also the common
 * case, 955 of 1,050 on a live read. Cities and clouds are absent on purpose, because neither
 * draws a mark at all: cities are text and clouds are imagery.
 */
const LAYER_MARKS: ReadonlyMap<string, string> = new Map([
  ['aircraft', iconImage('plane', CLASS_COLOURS.unknown, false, RAIL_MARK_PX)],
  ['military', iconImage('plane', CLASS_COLOURS.military, false, RAIL_MARK_PX)],
  ['vessels', iconImage('ship', UNDER_WAY_COLOUR, false, RAIL_MARK_PX)],
  ['satellites', iconImage('diamond', SATELLITE_COLOUR, false, RAIL_MARK_PX)],
  [TRANSIT_CLUSTER_KEY, iconImage('vehicle', TRANSIT_COLOUR, false, RAIL_MARK_PX)],
  // A pin, because the legend has to stand for the layer and the layer's own distinction between
  // an observed position and a derived one is a filled pin against a hollow ring. Showing the
  // filled one here is the honest choice: it is what an upstream coordinate looks like, and a
  // legend that showed the hollow ring would imply the whole layer was derived.
  [SOCIAL_CLUSTER_KEY, iconImage('pin', SOCIAL_COLOUR, false, RAIL_MARK_PX)],
]);

const rail = new LayerRail(element('layers'), {
  marks: LAYER_MARKS,
  // The layers this build draws, in rail order. The first two come from the one
  // AircraftLayer, which is why it hides per layer rather than per collection. A layer the
  // server offers and this build cannot draw is listed with its count and no switch, rather
  // than given a switch that does nothing.
  // Cities and clouds last: both are context for everything above them rather than a feed of
  // their own, and neither has a count, because neither is a set of entities.
  toggleable: [
    'aircraft',
    'military',
    'vessels',
    'satellites',
    TRANSIT_CLUSTER_KEY,
    SOCIAL_CLUSTER_KEY,
    CITY_LAYER,
    CLOUD_LAYER,
  ],
  onToggle: (layer, visible) => {
    switch (layer) {
      case CITY_LAYER: {
        cities.setVisible(visible);
        repaintCities();
        break;
      }
      case CLOUD_LAYER: {
        clouds.setVisible(visible);
        break;
      }
      case 'satellites': {
        satellites.setVisible(visible);
        break;
      }
      case TRANSIT_CLUSTER_KEY: {
        transit.setVisible(visible);
        break;
      }
      case SOCIAL_CLUSTER_KEY: {
        social.setVisible(visible);
        // Switched back on with an empty layer if the camera has not rested since, so ask again
        // rather than showing nothing until the next drag.
        socialState.lastBox = null;
        refreshSocial();
        break;
      }
      case 'vessels': {
        vessels.setVisible(visible);
        break;
      }
      // The civil and military aircraft feeds share one collection, which is why that layer
      // hides per layer name rather than per collection.
      default: {
        aircraft.setVisible(layer, visible);
      }
    }
    globe.requestRender();
    // A switch does not move the camera, so the URL has to be told about it here.
    urlState.record();
  },
});

/**
 * Follow mode and the shareable view.
 *
 * The camera locks onto whatever is selected when the follow key is pressed and lets go on
 * the user's own first drag or zoom, which is decided in `globe/follow.ts`. The URL carries
 * the camera and the layer switches, and nothing else, so a view can be pasted to somebody
 * else; while follow mode has the camera it is left out of the URL, because where a followed
 * aircraft has flown to is not a view anybody chose.
 *
 * Declared after the rail because the rail owns which layers are off. The rail's switch
 * calls back into `urlState` above, which is a closure and so runs long after this line.
 */
const follow = new FollowMode(globe.viewer);
installFollowKey(follow, () => store.selected);
const urlState = trackViewInUrl({
  camera: globe.viewer.camera,
  hidden: () => rail.hiddenLayers,
  suspended: () => follow.following !== null,
});
const shared = parseViewHash(window.location.hash);
if (shared.camera !== null) {
  applyCameraView(globe.viewer.camera, shared.camera);
}
// A layer named by the URL that this deployment does not have is dropped rather than
// erroring, so a link from a build with more layers than this one still opens.
rail.hide(shared.hidden);

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
    // The one line on any card that is our arithmetic rather than a feed's report, so it is
    // rewritten on the tick that computed it rather than on a selection change.
    satelliteCard.setPosition(selectedSatellitePosition(ids, lonLatAlt));
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
 * The search box, and where picking a result sends the camera.
 *
 * Every decision behind this lives in `ui/search.ts`: which key focuses the box, how long a
 * keystroke waits before it becomes a request, which rows are pickable, and what a hit of
 * each type does. What is here is the three things only the bootstrap can supply.
 */
new SearchBox(element('search'), {
  search: searchAll,
  onPick: (hit) => {
    // Every pick closes the two cards the store does not know about, so a pick of one kind
    // cannot leave another kind's card open beside it. The routing below reopens whichever one
    // this hit is actually about.
    selectSatellite(null);
    selectPlace(null);
    // A city hit has no card in `routePick`, and deliberately so: `ui/search.ts` does not know
    // this build grew one. Handled here, where the gazetteer is, and before the fly-to so the
    // card is already open as the camera arrives. Guarded the same way the satellite branch in
    // `routePick` is: a GeoNames id is a positive integer or it is not an id.
    if (hit.group === CITY_LAYER) {
      const geonamesId = Number(hit.entity_id);
      selectPlace(Number.isSafeInteger(geonamesId) && geonamesId > 0 ? geonamesId : null);
    }
    routePick(hit, {
      flyTo: (point, altitudeM) => {
        // Asking to be flown somewhere is the user taking the camera back, so follow mode
        // lets go of it first. Otherwise the two fight over it for the whole flight.
        follow.stop();
        flyToPoint(globe, point, altitudeM);
      },
      selectEntity: (id) => {
        store.select(id);
      },
      selectSatellite: (noradCatId) => {
        selectSatellite(noradCatId);
        globe.requestRender();
      },
    });
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
  const notices = new Map(satelliteNotices(satelliteFeed.state));
  if (cityStatus.notice !== null) {
    notices.set(CITY_LAYER, cityStatus.notice);
  }
  if (socialState.notice !== null) {
    notices.set(SOCIAL_CLUSTER_KEY, socialState.notice);
  }
  // Asked per repaint rather than held, because the answer depends on where the camera is:
  // GIBS carries no Meteosat, so the cloud layer has a hole in it from 6°E to 60°E and the
  // row says so only while the user is looking at the hole.
  const cloudNotice = clouds.notice(cityView(globe.viewer.scene));
  if (cloudNotice !== null) {
    notices.set(CLOUD_LAYER, cloudNotice);
  }
  const counts = viewCounts();
  rail.update(
    withDrawnSatelliteCount(feeds, satellites.count),
    notices,
    counts.inView,
    counts.groups,
  );
}

/**
 * The rail's capability list: the server's, with the cloud layer's appended.
 *
 * The cloud tiles go straight from NASA to the browser and our backend sees none of it, so
 * only the browser can say whether that layer is serving. Held rather than recomputed so a
 * refresh that changes nothing does not rebuild the rail and take the focus ring off
 * whichever switch the keyboard was on.
 */
const capabilityState: {
  served: readonly LayerCapability[];
  credits: readonly AttributionEntry[];
  published: string;
} = { served: [], credits: [], published: '' };

function publishCapabilities(): void {
  const layers = [...capabilityState.served, clouds.capability];
  const identity = JSON.stringify(layers);
  if (identity === capabilityState.published) {
    return;
  }
  capabilityState.published = identity;
  rail.setCapabilities(layers, capabilityState.credits);
}

/**
 * Find the newest cloud imagery NASA has actually built, and put it on the globe.
 *
 * Every ten minutes, which is the cadence GIBS publishes at, and it costs one `HEAD` per
 * satellite on the normal path. A frame is asked for only when a sheet really changed:
 * `requestRenderMode` is on, so a tick that found nothing new must not wake the renderer.
 */
async function refreshClouds(): Promise<void> {
  const changed = await clouds.refresh();
  publishCapabilities();
  if (changed) {
    globe.requestRender();
  }
  updateRail();
}

/** One cloud refresh, fired and forgotten, because nothing waits on the weather. */
function cloudTick(): void {
  void (async () => {
    try {
      await refreshClouds();
    } catch (error: unknown) {
      console.error('could not refresh the cloud imagery', error);
    }
  })();
}

/**
 * What the camera can see of each layer, and how much of it is grouped behind a badge.
 *
 * The server's count is everything it holds. On the vessel layer those two numbers differ
 * almost everywhere on the globe, because the keyless providers cover Northern Europe, and a
 * row reading "6,055" over an empty Channel reads as a broken renderer rather than as a
 * coverage limit.
 *
 * **Both figures come off the cluster grids rather than from `countInView` and a view
 * rectangle, and that is a correctness change rather than a tidy-up.** The rectangle comes
 * from Cesium's `camera.computeViewRectangle` through `cityView`, and it is not dependable at
 * every altitude: one frame had aircraft reading "0 in view of 820" while military read "92 in
 * view of 95" against the same rectangle, which is what a rectangle complemented in longitude
 * looks like when one feed is a viewport query around Greenwich and the other is global.
 * Neither `countInView` nor `pointInView` is at fault and both have tests proving it. The grid
 * projects every drawn mark through the view-projection matrix and occlusion-tests it against
 * the sphere, so it does not consult that rectangle at all.
 *
 * Satellites are in this now, where they used to be left out because their positions live in
 * the propagation worker's arrays rather than in a slot with a longitude on it. The grid holds
 * the drawn marks, so that reason has gone.
 */
function viewCounts(): {
  inView: ReadonlyMap<string, number>;
  groups: ReadonlyMap<string, number>;
} {
  const states: readonly (readonly [string, ClusterState])[] = [
    ['aircraft', aircraft.clusterState('aircraft')],
    ['military', aircraft.clusterState('military')],
    ['vessels', vessels.clusterState],
    ['satellites', satellites.clusterState],
    // Never `transit.countInView`. Its own docstring says why: it reads off
    // `camera.computeViewRectangle` like the retired `countInView` calls did, and that rectangle
    // is the one measured under-reporting the aircraft layer four times over at wide zoom.
    [TRANSIT_CLUSTER_KEY, transit.clusterState],
    [SOCIAL_CLUSTER_KEY, social.clusterState],
  ];
  return {
    // `onScreen` counts a badge's members one by one, never the badges. A count of marks would
    // under-report a busy view by whatever the biggest badge is holding.
    inView: new Map(states.map(([layer, state]) => [layer, state.onScreen])),
    groups: new Map(states.map(([layer, state]) => [layer, state.groups])),
  };
}

/**
 * Repaint the city labels for wherever the camera has come to rest.
 *
 * Which cities are worth labelling is the only thing about this layer that ever changes,
 * because cities do not move. `refresh` decides it and is a no-op for a view it has already
 * painted, so this costs nothing when the camera has not really gone anywhere.
 */
function repaintCities(): void {
  if (cities.refresh(cityView(globe.viewer.scene))) {
    globe.requestRender();
  }
}

/**
 * Why the city layer is empty, or null. Shown on the rail's own Cities row.
 *
 * The gazetteer read is the largest response this app asks for and the one most likely to time
 * out, it has no socket behind it and nothing repolls it. Without this the rail keeps reporting
 * the server's 34,072 rows over a layer holding none, and the only trace is a console line.
 */
// A holder rather than a bare `let`: reassigning a module-level binding from inside a
// function is what `unicorn/no-top-level-assignment-in-function` exists to stop.
const cityStatus: { notice: string | null } = { notice: null };

const CITY_READ_FAILED = 'city labels could not be read; the layer is empty';

/**
 * Read the gazetteer, once, with one retry.
 *
 * One retry rather than a poll: cities do not move, so there is nothing to keep up with, and
 * the failure worth surviving is a single timeout on an 8MB body rather than an outage.
 */
async function loadCities(): Promise<void> {
  try {
    const gazetteer = await fetchCities();
    cities.load(gazetteer.cities);
    repaintCities();
    cityStatus.notice = null;
  } catch (error: unknown) {
    console.error('could not read the city gazetteer', error);
    cityStatus.notice = CITY_READ_FAILED;
  }
  updateRail();
}

/**
 * Fold one frame of socket traffic into the transit layer.
 *
 * Not through the store, unlike aircraft and vessels. The store exists to key an entity for a
 * card and for follow mode, and transit has neither: there is no transit card, and a bus that
 * cannot be honestly interpolated between reports is not something to lock a camera onto. So the
 * layer holds its own slots and this hands it the three kinds of change directly.
 *
 * A snapshot replaces rather than merges, which is what takes yesterday's vehicles off the globe
 * after a reconnect. An agency that stops publishing simply stops appearing in it.
 */
function* upsertedVehicles(batch: Batch): Iterable<TransitVehicle> {
  for (const entry of batch.transit.upserts.values()) {
    yield entry.entity;
  }
}

function applyTransit(batch: Batch): void {
  for (const entities of batch.transit.snapshots.values()) {
    transit.replace(entities);
  }
  transit.upsert(upsertedVehicles(batch));
  transit.remove(batch.transit.removals.keys());
}

/**
 * What the social layer is currently showing, and why it might be showing little.
 *
 * A holder rather than three bare bindings, matching `cityStatus`, because reassigning a
 * module-level binding from inside a function is what `unicorn/no-top-level-assignment-in-function`
 * exists to stop.
 */
const socialState: {
  notice: string | null;
  lastBox: BoundingBox | null;
  inFlight: boolean;
} = { notice: null, lastBox: null, inFlight: false };

/**
 * Read the social posts for wherever the camera is now.
 *
 * The only viewport-driven fetch in this file, and the only one that reaches a provider rather
 * than our own store, which is why it is guarded three ways: nothing is asked while the layer is
 * switched off, nothing is asked while a request is in flight, and nothing is asked until the
 * camera has moved a quarter of a box.
 *
 * A failure leaves the posts that are already drawn alone. They were true when they arrived and a
 * timeout does not make them false, which is the same rule the gazetteer read follows.
 */
function refreshSocial(): void {
  if (rail.hiddenLayers.includes(SOCIAL_CLUSTER_KEY)) {
    return;
  }
  const view = cityView(globe.viewer.scene);
  const box: BoundingBox = {
    west: view.west,
    south: view.south,
    east: view.east,
    north: view.north,
  };
  if (socialState.inFlight || !boxMovedEnough(socialState.lastBox, box)) {
    return;
  }
  socialState.inFlight = true;
  socialState.lastBox = box;
  void (async () => {
    try {
      const snapshot = await fetchSocial(box);
      social.replace(snapshot.posts);
      // The provider's own words about what it actually searched. Commons caps its geosearch at a
      // 10km radius and there is no world call, so a wide viewport gets one search at the box
      // centre: a sparse scatter with nothing said about it reads as a broken layer.
      socialState.notice = snapshot.notices.length === 0 ? null : snapshot.notices.join(' · ');
      globe.requestRender();
    } catch (error: unknown) {
      console.error('could not read social posts', error);
      socialState.notice = SOCIAL_READ_FAILED;
    } finally {
      socialState.inFlight = false;
      updateRail();
    }
  })();
}

const SOCIAL_READ_FAILED = 'social posts could not be read for this view';

/** Read the server's element cache and hand it to the propagation worker. */
async function loadSatelliteElements(): Promise<void> {
  const elements = await fetchSatelliteElements();
  satelliteFeed.load(elements.satellites);
}

store.onChange((batch) => {
  aircraft.apply(batch.aircraft);
  vessels.apply(batch.vessels);
  applyTransit(batch);
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
  // A mover selection is not a satellite and not a place, so those two close. This is the path
  // a search-box pick of an aircraft takes, which never reaches the picking handler above. The
  // null case is skipped on purpose: `store.select(null)` is exactly what the picking handler
  // calls a line after selecting a satellite, and acting on it here would close the card it
  // had just opened.
  if (selected !== null) {
    selectSatellite(null);
    selectPlace(null);
  }
  // The store announces a selection change on every fresh fix for the selected entity, so
  // this is also how follow mode gets its new position, and how it finds out that what it
  // was following has dropped off its feed.
  follow.refresh(selected);
  globe.requestRender();
});

/**
 * The catalogue number the satellite card, the emphasised mark and the orbit trail are all
 * currently about, or null.
 *
 * Held here because the propagation tick arrives with every drawn satellite's position in one
 * pair of flat arrays and something has to know which one of them the open card wants. A holder
 * rather than a bare `let`, matching `cityStatus` below, because reassigning a module-level
 * binding from inside a function is what `unicorn/no-top-level-assignment-in-function` stops.
 */
const satelliteSelection: { noradCatId: number | null } = { noradCatId: null };

/**
 * Select one satellite, or none, everywhere that shows one.
 *
 * Four things move together and all four have to. The layer emphasises the mark, the feed
 * starts asking the worker for that object's orbit trail, the card opens on its element set,
 * and this file remembers which one so the next propagation tick can find its position. Both
 * routes in, a click on the globe and a pick from the search box, come through here rather
 * than each doing the four, because a route that forgot one would look like a card open on a
 * satellite the globe is not highlighting.
 *
 * The element set comes off the feed rather than a map kept here, because that map is the only
 * place the socket's snapshots, upserts and removals are reconciled into the whole set: a
 * second copy would be correct until the first frame of socket traffic and stale after it.
 */
function selectSatellite(noradCatId: number | null): void {
  satelliteSelection.noradCatId = noradCatId;
  satellites.setSelected(noradCatId);
  satelliteFeed.setSelected(noradCatId);
  satelliteCard.show(noradCatId === null ? null : satelliteFeed.elementsFor(noradCatId));
}

/**
 * Open the place card on one gazetteer row, or close it.
 *
 * `cityFor` is the layer's own lookup rather than a second index here, so the click route and
 * the search box resolve the same id through the same map. It builds that map on the first
 * call, so a session that never picks a city pays nothing for it.
 */
function selectPlace(geonamesId: number | null): void {
  placeCard.show(geonamesId === null ? null : cities.cityFor(geonamesId));
}

/**
 * The propagated position of the selected satellite inside one tick's arrays, or null.
 *
 * A scan rather than a lookup, because there is nothing to look up in: the worker hands back
 * two flat typed arrays and building a map from them every tick would allocate far more than
 * the scan costs. About 700 comparisons on a normal run, once a tick, stopping at the first
 * hit, against a loop that already walks the same arrays to move the marks.
 *
 * Null is a normal answer rather than a failure. An element set more than 3.5 days old is held
 * back deliberately and SGP4 refuses a decayed object, so the selected satellite can be legitimately
 * absent from a tick that drew every other one, and the card then says it is not being drawn
 * instead of leaving the last position on screen.
 */
function selectedSatellitePosition(
  ids: Int32Array,
  lonLatAlt: Float64Array,
): SatellitePosition | null {
  const wanted = satelliteSelection.noradCatId;
  if (wanted === null) {
    return null;
  }
  // `indexOf` on the typed array rather than a loop written here. It is the same linear scan
  // and it is the engine's, so there is no iterator allocation per satellite per tick and no
  // hand-rolled index to get wrong.
  const index = ids.indexOf(wanted);
  if (index === -1) {
    return null;
  }
  // `noUncheckedIndexedAccess` is why each read carries a fallback. The index is in range by
  // construction: `lonLatAlt` holds one triple per entry in `ids`.
  return {
    lon: lonLatAlt[index * 3] ?? 0,
    lat: lonLatAlt[index * 3 + 1] ?? 0,
    altitudeM: lonLatAlt[index * 3 + 2] ?? 0,
  };
}

installPicking(globe, (id) => {
  // One click belongs to one layer, and the prefix on the picked id is what decides which. An
  // aircraft carries a bare ICAO address and a vessel a bare MMSI, so anything neither
  // prefixed scheme claims goes to the store, which resolves the rest. All four are told,
  // including the three that were not picked, and that is what closes their cards.
  const noradCatId = noradFromPickId(id);
  const geonamesId = geonamesFromPickId(id);
  // A badge is one mark standing for many, so it gets no card: a card for seven hundred ships
  // is not a card. The only thing a click on a group can usefully mean is "show me these", so
  // it flies the camera in far enough to frame the members, at which point the badge dissolves
  // into them and they are individually pickable. Null covers a foreign id and a stale one
  // alike, because cells are numbered per pass and a badge that has already dissolved must
  // resolve to nothing rather than to whatever now occupies its cell.
  const cluster =
    aircraft.clusterFlyTo(id) ??
    vessels.clusterFlyTo(id) ??
    satellites.clusterFlyTo(id) ??
    transit.clusterFlyTo(id) ??
    social.clusterFlyTo(id);
  selectSatellite(noradCatId);
  selectPlace(geonamesId);
  if (cluster !== null) {
    // Same as a search fly-to: being flown somewhere is the user taking the camera back, so
    // follow mode lets go rather than fighting the flight for its whole duration.
    follow.stop();
    flyToPoint(globe, { lon: cluster.lon, lat: cluster.lat }, cluster.altitudeM);
  }
  // Never handed a prefixed id. Passing `city:2643743` in here does deselect both mover cards,
  // because no aircraft carries that ICAO address and no vessel that MMSI, but it is a foreign
  // id reaching a lookup by luck and it stops working the day the store counts or logs an id
  // it does not recognise.
  store.select(noradCatId === null && geonamesId === null && cluster === null ? id : null);
  globe.requestRender();
});
// `moveEnd` rather than the motion loop: nothing in this layer moves, so it has no business
// in a per-frame callback. The labels settle when the camera does, and so do the rail's
// in-view counts, which are the only thing on screen that answers "why is this view empty".
globe.viewer.camera.moveEnd.addEventListener(() => {
  repaintCities();
  // Here rather than in the motion loop, and this is the layer that makes the distinction matter:
  // its fetch leaves the machine.
  refreshSocial();
  updateRail();
});
startMotionLoop(globe, (nowMs) => {
  satelliteFeed.tick(nowMs);
  // Both, every tick, and never short-circuited: `advance` is what moves a layer, not just
  // what reports on it.
  const movedAircraft = aircraft.advance(nowMs);
  const movedVessels = vessels.advance(nowMs);
  // The camera counts as something that moved: a followed aircraft crossing the screen has
  // to be drawn, and a parked one asks for nothing.
  const movedCamera = follow.tick(nowMs);
  return movedAircraft || movedVessels || movedCamera;
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
      // Sweeps as well as providers: a refusal is a property of a sweep rather than of a provider,
      // and 38,708 reports refused as stale is the number that proves the staleness bound works.
      rail.setProviders(summary.providers, summary.sweeps, heldCounts(summary));
    } catch (error: unknown) {
      console.error('could not read per-provider coverage', error);
    }
  })();
}, LAYER_SUMMARY_POLL_MS);

// Started before the backend is asked for anything, and never awaited: these tiles come from
// NASA rather than from us, so the layer has to come up against a backend that is not running
// and must not hold up the movers that are. The interval is the cadence GIBS publishes at, and
// it re-probes every time rather than assuming the next slot exists, because it never does yet.
cloudTick();
setInterval(cloudTick, CLOUD_REFRESH_MS);

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
  // All four, because a card shown without its source named is the one thing none of them may
  // do, and for GeoNames the credit is a CC BY 4.0 condition rather than a courtesy.
  satelliteCard.setAttribution(capabilities.attribution);
  placeCard.setAttribution(capabilities.attribution);
  capabilityState.served = capabilities.layers;
  capabilityState.credits = capabilities.attribution;
  publishCapabilities();

  const health = await fetchHealth();
  store.setFeeds(health.feeds);
  status.update(health.feeds);
  updateRail(health.feeds);

  const snapshot = await fetchAircraft();
  store.applySnapshot('aircraft', snapshot.aircraft);

  const ships = await fetchVessels();
  store.applyVesselSnapshot(ships.vessels);

  // Straight onto the layer rather than through the store, for the reason `applyTransit` gives.
  const vehicles = await fetchTransit();
  transit.replace(vehicles.vehicles);

  await loadSatelliteElements();

  const summary = await fetchLayers();
  rail.setProviders(summary.providers, summary.sweeps, heldCounts(summary));
} catch (error: unknown) {
  console.error('could not load capabilities or the first snapshot', error);
}

// Last on purpose, and outside the block above. The gazetteer is the largest single response
// the frontend asks for and nothing on the globe moves because of it, so the live layers get
// the network first, and a failure anywhere above must not be the reason the city labels never
// load. One read for the life of the tab: cities do not move, so there is nothing to poll.
await loadCities();

// Last, and viewport-driven from here on. The box is required by the route rather than optional,
// so there is no world call to make at boot: the first useful question is about wherever the
// camera opened.
refreshSocial();
