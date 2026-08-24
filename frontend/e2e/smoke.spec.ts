/**
 * The smoke test: does the built app actually come up, draw a globe, and draw things on it.
 *
 * Nothing here needs the backend. Every REST call is fulfilled with a canned body and the
 * WebSocket is answered by a stub, which is also what makes the test deterministic: a live
 * feed would put a different number of movers on screen every run.
 *
 * Two jobs. The first is the build itself: Cesium's workers, shaders and widget assets are
 * copied by a Vite plugin and found through a `CESIUM_BASE_URL` substitution, neither of
 * which the type checker or the unit tests can see. If that copy breaks, the canvas never
 * gets a context and this test is what says so.
 *
 * The second is the wiring in `src/main.ts`, which is excluded from unit coverage because a
 * real Cesium viewer needs WebGL and a top-level await needs a browser. Phase 2 shipped a
 * vessel layer, a vessel card and 774 lines behind them that nothing imported, and every unit
 * test passed. So the wiring is asserted here instead: an aircraft, a ship and a satellite
 * each reach the globe, the ship is pickable and opens its card, a shared URL restores the
 * camera and the layer switches, the Cities switch really takes the labels off the globe, the
 * search box paints a pickable row and flies the camera, follow mode keeps a moving aircraft
 * under the crosshair, and a failed gazetteer read says so on the rail. Unit tests can see
 * none of that.
 *
 * Every assertion here is something the DOM or a click can observe. Where a browser cannot
 * observe a thing, the unit suite carries it and the comment beside it says so rather than
 * pointing at this file.
 *
 * The canned bodies below are the real contract shapes, taken from `openapi.json`. A stub
 * shaped like something the backend does not serve is worse than no stub: an earlier version
 * of this file sent `layers: ['aircraft']` where `/api/capabilities` serves
 * `LayerCapability` objects, the layer rail threw on it, and every assertion after that
 * point in the first-paint sequence was silently never reached.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Locator, Page, Route } from '@playwright/test';

import { makeAircraft } from '../src/testing/aircraft';
import { makeCity } from '../src/testing/city';
import { issElements } from '../src/testing/satellite';
import type { SearchResponse } from '../src/types/entities';

/**
 * The camera's initial centre, from `createGlobe` in src/globe/viewer.ts.
 *
 * A mover placed here projects to the middle of the canvas, which is what lets a click at
 * the canvas centre pick it without this test knowing anything about projection.
 */
const CENTRE = { lon: -0.12, lat: 51.5 };

const CAPABILITIES = {
  layers: [
    { layer: 'aircraft', available: true, reason: null },
    { layer: 'military', available: true, reason: null },
    { layer: 'vessels', available: true, reason: null },
    {
      layer: 'vessels/aishub',
      available: false,
      reason: 'AISHub grants API access only to members streaming raw NMEA from a receiver',
    },
    { layer: 'satellites', available: true, reason: null },
    { layer: 'cities', available: true, reason: null },
  ],
  attribution: [
    // `operators` empty and no `as_of`, which is what the backend serves for a single-source
    // row. The grouped shape has its own test rather than living in the shared stub, so the
    // credit count here stays what every other test expects.
    {
      source: 'adsb.lol',
      text: 'Aircraft data from adsb.lol',
      url: 'https://adsb.lol',
      licence: 'ODbL 1.0',
      operators: [],
    },
    {
      source: 'NASA GIBS',
      text: 'Imagery courtesy of NASA EOSDIS GIBS',
      url: 'https://gibs.earthdata.nasa.gov',
      licence: 'Public domain, attribution requested',
      operators: [],
    },
  ],
};

/**
 * A grouped transit credit, in the shape `/api/capabilities` serves for the six licence groups.
 *
 * Kept out of {@link CAPABILITIES} on purpose: adding it there would change the credit count
 * every other test asserts. Two owners rather than sixty-seven, because what is under test is
 * the shape and the behaviour, and the live figures are recorded in `docs/status.md`.
 */
const GROUPED_CREDIT = {
  source: 'Transit feeds under Etalab 2.0',
  text: 'Transit vehicle positions from 2 French public transport authorities, Etalab 2.0',
  url: 'https://www.etalab.gouv.fr/licence-ouverte-open-licence',
  licence: 'Etalab 2.0',
  as_of: '2026-08-24T09:14:32Z',
  operators: [
    { name: 'Île-de-France Mobilités', url: 'https://prim.iledefrance-mobilites.fr/en/cgu' },
    { name: 'Tisséo', url: 'https://data.toulouse-metropole.fr/pages/licence/' },
  ],
};

function feed(source: string, layer: string, count: number, interval: number) {
  return {
    source,
    layer,
    healthy: true,
    entity_count: count,
    consecutive_failures: 0,
    poll_interval_seconds: interval,
    last_error: null,
    last_success_at: '2026-08-19T12:00:00Z',
    rate_limited_until: null,
  };
}

const HEALTH = {
  status: 'ok',
  feeds: [
    feed('adsb.lol', 'aircraft', 2, 8),
    feed('vessels/union', 'vessels', 1, 60),
    feed('celestrak/gp', 'satellites', 1, 7200),
  ],
};

/**
 * Per-provider coverage, which only `/api/layers` carries.
 *
 * `error` set on a configured provider is ADR 010's degraded case: the union drops it for
 * that cycle and the layer has to say which provider is missing. `exclusive` is the
 * provider-attributable count the same ADR asks to be on screen.
 */
const LAYERS = {
  feeds: HEALTH.feeds,
  layers: { aircraft: 1, vessels: 1, satellites: 1 },
  providers: [
    { layer: 'vessels', provider: 'digitraffic', records: 1, exclusive: 1, error: null },
    { layer: 'vessels', provider: 'aishub', records: 0, exclusive: 0, error: 'HTTP 500' },
    { layer: 'cities', provider: 'geonames', records: 3, exclusive: 3, error: null },
  ],
};

/**
 * Built from the same factory the unit tests use, so a required field added to the backend
 * contract breaks the type check here rather than putting a hole in the stub. An earlier
 * hand-written version was missing `providers` and `on_ladd`, which the card reads: opening
 * it on this record threw inside `providerText` before it drew a single row.
 *
 * Well away from the camera centre, so the click in the vessel test cannot pick this or its
 * callsign label instead of the ship.
 */
const AIRCRAFT = {
  count: 1,
  aircraft: [makeAircraft({ point: { lon: -2.5, lat: 51.47, altitude_m: 3000 } })],
};

/** The same aircraft under the camera, for the tests that need to click it. */
const JET = makeAircraft({
  point: { lon: CENTRE.lon, lat: CENTRE.lat, altitude_m: 3000 },
  callsign: 'N1972',
  registration: 'N1972',
  type_designator: 'GLF5',
  aircraft_class: 'business_jet',
  // dbFlags bit 8. An attribute and never a display block, per ADR 009: the card has to show
  // it and the owner join has to happen anyway.
  on_ladd: true,
  providers: ['adsb.lol'],
});

const AIRCRAFT_AT_CENTRE = { count: 1, aircraft: [JET] };

/**
 * The same jet, moving fast and due east, for the follow test.
 *
 * 300 m/s is an airliner's cruise and the point of it here is pixels: at the 30km camera
 * height that test opens at, it crosses the canvas quickly enough that four seconds of drift
 * is unmistakable.
 */
const FAST_JET_AT_CENTRE = {
  count: 1,
  aircraft: [{ ...JET, ground_speed_mps: 300, track_deg: 90, on_ground: false }],
};

/** The registry join the card fetches when it opens, shaped by `AircraftDetail`. */
const AIRCRAFT_DETAIL = {
  aircraft: { ...JET, owner: 'Nike Inc' },
  registry: 'adsbdb',
  registry_attribution: 'Aircraft registry data via adsbdb.com',
  joined_at: '2026-08-19T12:00:00Z',
  conflicts: [],
  degraded_reason: null,
};

/**
 * An ownership block the server asserted, and one it did not.
 *
 * The two cases the card has to keep apart, and the only way to see them in a browser: the FAA
 * register and the SEC company index are both local, so a stub here is the whole join.
 *
 * The possible one is the live shape rather than an invented one. An aircraft registered to
 * `UNITED AIRLINES INC` resolves to the holding company at 0.6 on a name match after stripping
 * legal suffixes, and real officers of that holding company come back. What is unproven is that
 * the holding company is this airframe's registrant, so four real names are attached to a company
 * that may not own it, and that is the failure the card exists to prevent.
 */
const OWNERSHIP_ASSERTED = {
  registrant: 'SOUTHWEST AIRLINES CO',
  registrant_kind: 'organisation',
  asset_register: 'faa',
  as_of: '2026-08-20',
  asserted: true,
  join: {
    as_of: '2026-08-10',
    basis: 'exact normalised name match against the SEC company index',
    confidence: 0.95,
    inferred: false,
    origin_key: 'sec:0000092380',
    source: 'sec',
    target_id: '0000092380',
    target_kind: 'organisation',
  },
  organisation: {
    kind: 'organisation',
    organisation_id: '0000092380',
    name: 'Southwest Airlines Co',
    registry_names: ['SOUTHWEST AIRLINES CO'],
    joins: [],
    sec_cik: '0000092380',
  },
  officers: [
    {
      kind: 'person',
      person_id: 'sec:1111111',
      name: 'KELLY GARY C',
      addresses: [],
      claims: [],
      emails: [],
      phones: [],
      joins: [],
      roles: [
        {
          as_of: '2026-08-10',
          is_director: true,
          is_officer: false,
          is_ten_percent_owner: false,
          organisation_id: '0000092380',
          organisation_name: 'Southwest Airlines Co',
          origin_key: 'sec:form4:1',
          source: 'sec',
          title: 'Executive Chairman',
        },
      ],
    },
  ],
  officers_basis: 'named on an SEC Form 3, 4 or 5 filed against this issuer',
  wealth_tier_reason: 'Wealth tier not established: no keyless public source publishes one.',
};

const OWNERSHIP_POSSIBLE = {
  ...OWNERSHIP_ASSERTED,
  registrant: 'UNITED AIRLINES INC',
  asserted: false,
  join: {
    ...OWNERSHIP_ASSERTED.join,
    confidence: 0.6,
    basis: 'name match after stripping legal suffixes, parent company not confirmed',
  },
  organisation: {
    ...OWNERSHIP_ASSERTED.organisation,
    organisation_id: '0000100517',
    name: 'United Airlines Holdings, Inc.',
    sec_cik: '0000100517',
  },
};

/** No ships, so a click at the centre can only pick the aircraft. */
const NO_VESSELS = { count: 0, vessels: [] };

/**
 * No city labels, which is the default for every test here that clicks the globe.
 *
 * A label is a pickable primitive sitting at the city's own coordinates, and London's are
 * 600 metres from the camera centre these tests click at. Whether the click lands on the label
 * or on the mover underneath it depends on draw order, so a test asserting a card opens would
 * flake rather than fail. The one test that wants labels asks for them.
 */
const NO_CITIES = { count: 0, total: 0, cities: [] };

/**
 * Rotterdam: where the camera goes in the URL test and the search test.
 *
 * Both prove the camera moved by parking a ship there and clicking the middle of the canvas.
 * A pin only projects to the centre if the camera really arrived, so a card opening on that
 * click is the camera position asserted without this test knowing anything about projection.
 */
const ROTTERDAM = { lon: 4.47775, lat: 51.9244424 };

/*
 * The camera a test needs to click one mover, asked for rather than inherited.
 *
 * Every stub entity in this file sits at `CENTRE`, and these tests used to reach it by opening
 * `/` and relying on the product's default view being 2,400km over London. That default is now
 * the whole Earth at 20,000km, because Alexander Fanthome asked to be shown a globe, and at
 * that range a moored ship is a fraction of a pixel and no amount of clicking finds it.
 *
 * Which is the point: a test about clicking a mark should say where the camera is. Leaving it
 * implicit meant three tests quietly asserted the opening view as a side effect, so a
 * deliberate product change read as three broken features. `alt=60000` is the same figure the
 * shared-link test uses.
 */
const CLOSE_ON_CENTRE = `/#lon=${String(CENTRE.lon)}&lat=${String(CENTRE.lat)}&alt=60000`;

/**
 * Three real GeoNames rows, through the same factory the unit tests use.
 *
 * London is the one that matters: 8,961,989 people puts it in the band drawn from 25,000km,
 * so it is labelled at the opening camera height of 2,400km and switching the layer off has
 * something to take away.
 */
const CITIES = {
  count: 3,
  total: 3,
  cities: [
    makeCity(),
    makeCity({
      geonames_id: 2_988_507,
      name: 'Paris',
      ascii_name: 'Paris',
      point: { lon: 2.3488, lat: 48.85341, altitude_m: null },
      country_code: 'FR',
      admin1_code: '11',
      population: 2_138_551,
      timezone: 'Europe/Paris',
      elevation_m: null,
    }),
    makeCity({
      geonames_id: 2_747_891,
      name: 'Rotterdam',
      ascii_name: 'Rotterdam',
      point: { lon: ROTTERDAM.lon, lat: ROTTERDAM.lat, altitude_m: null },
      country_code: 'NL',
      admin1_code: '11',
      population: 598_199,
      timezone: 'Europe/Amsterdam',
      elevation_m: null,
    }),
  ],
};

/** What `/api/search?q=N1972` answers: the jet, from the live aircraft store. */
const JET_SEARCH: SearchResponse = {
  query: 'N1972',
  groups: [
    {
      name: 'aircraft',
      unavailable_reason: null,
      hits: [
        {
          group: 'aircraft',
          entity_id: JET.icao24,
          label: 'N1972',
          detail: 'GLF5 · N1972',
          point: JET.point,
          score: 1,
        },
      ],
    },
  ],
};

/** What `/api/search?q=Rotterdam` answers: the port, from the geocoder. */
const ROTTERDAM_SEARCH: SearchResponse = {
  query: 'Rotterdam',
  groups: [
    {
      name: 'places',
      unavailable_reason: null,
      hits: [
        {
          group: 'places',
          entity_id: 'relation/1411101',
          label: 'Rotterdam',
          detail: 'Rotterdam, South Holland, Netherlands',
          point: { lon: ROTTERDAM.lon, lat: ROTTERDAM.lat, altitude_m: null },
          score: 0.9,
        },
      ],
    },
  ],
};

const VESSELS = {
  count: 1,
  vessels: [
    {
      kind: 'vessel',
      mmsi: '230992610',
      point: { lon: CENTRE.lon, lat: CENTRE.lat, altitude_m: null },
      observed_at: '2026-08-19T12:00:00Z',
      position_age_s: 12,
      source: 'digitraffic',
      name: 'FINNMAID',
      call_sign: 'OJPQ',
      ship_type: 60,
      course_over_ground_deg: 187.4,
      speed_over_ground_mps: 8.2,
      true_heading_deg: 190,
      navigational_status: 'under_way_using_engine',
    },
  ],
};

const ROTTERDAM_VESSELS = {
  count: 1,
  vessels: [
    {
      ...VESSELS.vessels[0],
      mmsi: '244660000',
      name: 'MAASSTAD',
      point: { lon: ROTTERDAM.lon, lat: ROTTERDAM.lat, altitude_m: null },
      // Moored, so it is exactly where the camera is aimed however long the click takes to
      // get there. The vessel layer dead-reckons like the aircraft one, and the 8.2 m/s of
      // the ship this is copied from is six pixels of drift at the height a search lands at.
      speed_over_ground_mps: 0,
      course_over_ground_deg: 0,
      navigational_status: 'moored',
    },
  ],
};

/**
 * The ISS, with its epoch moved to an hour before the test runs.
 *
 * The elements come off `tests/fixtures/celestrak_iss_omm.json` through the same helper the
 * unit tests use, so there is one recorded payload and no hand-copied orbital numbers here.
 * The epoch is the one thing overridden: the propagation worker holds back any element set
 * more than 3.5 days old rather than presenting stale elements as live, so the recorded epoch
 * would make this test pass today and fail on its own four days later.
 */
function elementCache() {
  const epoch = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  return {
    count: 1,
    fetched: { stations: new Date().toISOString() },
    satellites: [issElements({ epoch })],
  };
}

/**
 * A one-pixel image, standing in for NASA's basemap tiles.
 *
 * Not about the imagery: it is about the clicks below. A tile request that fails puts
 * Cesium's own error panel over the whole canvas, and that panel then swallows every click
 * meant for the globe. Stubbing the tiles also takes the one remaining network dependency
 * out of a suite that is testing our wiring rather than NASA's uptime.
 */
const TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

/**
 * Stand in for the whole backend.
 *
 * The socket is answered but never sends anything: the REST snapshots are what put movers on
 * the globe for the first paint, and leaving the socket silent keeps the picture still.
 */
/** An empty transit snapshot, so the layer is wired and drawing nothing it was not given. */
const NO_TRANSIT = { count: 0, vehicles: [] };

/**
 * An empty social snapshot, and the radius fields matter even when there are no posts.
 *
 * Same reason as the transit stub: unstubbed, this reaches the real backend through the preview
 * proxy and asks Wikimedia what it holds near wherever the test camera happens to be, so the suite
 * would depend on how many photographs were uploaded near Rotterdam this morning.
 *
 * `searched_radius_m` equal to `box_radius_m` is the no-notice case. The test below overrides both.
 */
const NO_SOCIAL = {
  count: 0,
  posts: [],
  box_radius_m: 5000,
  searched_radius_m: 5000,
  notices: [],
  derived_as_of: null,
};

async function stubBackend(page: Page): Promise<void> {
  await page.route('**/gibs.earthdata.nasa.gov/**', (route) =>
    route.fulfill({ body: TILE, contentType: 'image/png' }),
  );
  await page.route('**/api/capabilities', (route) => route.fulfill({ json: CAPABILITIES }));
  await page.route('**/api/health', (route) => route.fulfill({ json: HEALTH }));
  await page.route('**/api/layers', (route) => route.fulfill({ json: LAYERS }));
  await page.route('**/api/aircraft*', (route) => route.fulfill({ json: AIRCRAFT }));
  await page.route('**/api/vessels*', (route) => route.fulfill({ json: VESSELS }));
  await page.route('**/api/satellites/elements', (route) =>
    route.fulfill({ json: elementCache() }),
  );
  // Nothing stubbed this, so every run before now failed the city read against a backend that
  // is not there, took the console error, and passed anyway.
  await page.route('**/api/cities*', (route) => route.fulfill({ json: NO_CITIES }));
  // Empty on purpose, and the reason is worth the line. Unstubbed, this request reached the
  // real backend through the preview proxy and put several thousand live vehicles over the
  // Netherlands, which is exactly where two of these tests click to open a vessel card. The
  // shared-link test started failing because its clicks were landing on Dutch buses instead of
  // on the ship it was aiming at. A test that depends on how busy Rotterdam is this afternoon
  // is not a test. Any test that wants vehicles should override this with its own.
  await page.route('**/api/transit*', (route) => route.fulfill({ json: NO_TRANSIT }));
  await page.route('**/api/social*', (route) => route.fulfill({ json: NO_SOCIAL }));
  await page.routeWebSocket('**/ws', () => {
    // Accepted and held open. An unanswered socket would put the banner into its
    // reconnecting state and make the connection assertions below flap.
  });
}

/** The rail row for one layer, found by its heading rather than by position. */
function railRow(page: Page, label: string) {
  return page.locator('.rail-row').filter({ has: page.getByText(label, { exact: true }) });
}

/** The checkbox that switches one layer, which is what a shared URL has to have moved. */
function railSwitch(page: Page, label: string) {
  return railRow(page, label).locator('input.rail-switch');
}

/**
 * Click the middle of the canvas until the card it should open is open.
 *
 * `requestRenderMode` is on, so the scene draws when something asks it to, and a click issued
 * before the frame that followed a camera move picks whatever the last frame held. That is a
 * race under four parallel workers sharing one software renderer, not a product fault, and one
 * retry settles it. A camera that never moved never passes this, however many times it clicks.
 */
async function clickUntilCardOpens(canvas: Locator, card: Locator, text: string): Promise<void> {
  await expect(async () => {
    await canvas.click();
    await expect(card).toContainText(text, { timeout: 2000 });
  }).toPass({ timeout: 30_000 });
}

test.beforeEach(async ({ page }) => {
  // A window tall enough that the rail is not collapsed.
  //
  // Playwright's default is 1280x720, and the rail folds itself away at or below 760px of
  // viewport height because that is where a layer switch starts going off the bottom of the dock.
  // So the default viewport is a projector, and every test about a switch was silently asserting
  // against the collapsed rail. Setting an ordinary laptop height here makes those tests about
  // the thing they name; the two tests that are about the collapse set their own viewport and
  // override this.
  await page.setViewportSize({ width: 1400, height: 900 });
  await stubBackend(page);
});

test('renders the globe canvas with a live WebGL context', async ({ page }) => {
  await page.goto('/');

  const canvas = page.locator('#globe canvas');
  await expect(canvas).toBeVisible();

  // Visible is not the same as drawing. Ask the canvas whether it has a WebGL context and
  // some pixels, which is what fails if the Cesium asset copy has broken.
  const rendering = await canvas.evaluate((element) => {
    const node = element as HTMLCanvasElement;
    return {
      hasContext: node.getContext('webgl2') !== null || node.getContext('webgl') !== null,
      width: node.width,
      height: node.height,
    };
  });

  expect(rendering.hasContext).toBe(true);
  expect(rendering.width).toBeGreaterThan(0);
  expect(rendering.height).toBeGreaterThan(0);
});

test('shows the attribution the licences require, one click from the globe', async ({ page }) => {
  await page.goto('/');

  const attribution = page.locator('#attribution');
  await expect(attribution).toBeVisible();

  // A small "i" in the bottom corner, on screen without anyone touching anything, and 44px
  // square so it can be hit and seen. Credits nobody can find are not attribution.
  const opener = attribution.locator('summary');
  await expect(opener).toBeVisible();
  await expect(opener).toHaveText('i');
  // Three: the two the API serves plus the cloud layer's, which the browser adds because
  // those tiles go from NASA straight to the browser and the API never sees them.
  await expect(opener).toHaveAttribute('aria-label', 'Data sources and licences (3)');
  const box = await opener.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
  await expect(attribution.getByRole('link', { name: 'Aircraft data from adsb.lol' })).toBeHidden();

  await opener.click();

  // ODbL 1.0 requires attribution wherever adsb.lol data is shown and NASA asks for a
  // credit on GIBS imagery, so these are licence conditions rather than decoration. One
  // click, from any view, with the licence beside each credit.
  await expect(
    attribution.getByRole('link', { name: 'Aircraft data from adsb.lol' }),
  ).toBeVisible();
  await expect(
    attribution.getByRole('link', { name: 'Imagery courtesy of NASA EOSDIS GIBS' }),
  ).toBeVisible();
  // The cloud sheets are a different product from a different pair of agencies, so they
  // carry their own credit rather than borrowing the basemap's.
  await expect(
    attribution.getByRole('link', {
      name: 'Cloud imagery from NOAA GOES and JMA Himawari via NASA EOSDIS GIBS',
    }),
  ).toBeVisible();
  await expect(attribution).toContainText('ODbL 1.0');
});

test('keeps one attribution control, and loses no credit by hiding the other', async ({ page }) => {
  await page.goto('/');

  // Cesium draws its own "Data attribution" link for the imagery provider it is handed, and
  // it landed 17px from our own "i" button: two controls, one list, on a globe Alexander
  // Fanthome cannot read past. `style.css` hides it. This asserts the hide, and then asserts
  // the thing that makes the hide legitimate rather than a licence breach.
  await expect(page.locator('.cesium-widget-credits')).toBeHidden();

  // Cesium still writes its credits into the DOM when hidden, so they can still be read and
  // compared. Every string Cesium holds must also be in our panel: that is the whole
  // argument for hiding its control. Today it is the one NASA GIBS line, because
  // `ui/attribution.ts` owns that constant and `globe/viewer.ts` imports it. Hand Cesium a
  // second imagery provider with a hand-typed credit and this fails, which is the point.
  await page.locator('#attribution > summary').click();
  const panelText = await page.locator('#attribution').innerText();
  const ours = panelText.replaceAll(/\s+/g, ' ');
  const raw = await page
    .locator('.cesium-widget-credits .cesium-credit-textContainer span, .cesium-credit-lightbox li')
    .allInnerTexts();
  const cesiumCredits = raw.map((text) => text.trim()).filter(Boolean);
  for (const credit of cesiumCredits) {
    expect(ours, `Cesium credits "${credit}" and the "i" menu does not`).toContain(credit);
  }
});

test('replaces the baseline credits with the list the API serves', async ({ page }) => {
  await page.goto('/');

  // Two entries in, three out, and never four: the panel must not append to the markup
  // baseline and show every credit twice. The third is the cloud layer's, added by the
  // browser rather than by the API.
  await expect(page.locator('#attribution li')).toHaveCount(3);
});

/**
 * The Etalab 2.0 condition, proved in a browser rather than against a fake element.
 *
 * `docs/status.md` recorded that the transit layer must not be publicly displayed until the date
 * the information was last updated is carried, alongside the producer's name. 101 of the 258
 * transit feeds are Etalab. What a unit test cannot show is that the date is *visible* and the
 * names are *reachable*, which is the whole of the condition, so it is asserted here on real
 * layout: the date on screen with nothing clicked, the names one click away and no further.
 */
test('shows a grouped credit its date without a click, and its owners with one', async ({
  page,
}) => {
  await page.route('**/api/capabilities', (route) =>
    route.fulfill({
      json: { ...CAPABILITIES, attribution: [GROUPED_CREDIT] },
    }),
  );
  await page.goto('/');

  const credits = page.locator('#attribution');
  await credits.locator('> summary').click();
  const row = credits.locator('li').first();

  // The date, with the operators still closed. Etalab asks for it to be displayed, and a date
  // inside a collapsed disclosure is not displayed.
  await expect(row.locator('time')).toHaveText('· information last updated 2026-08-24 09:14 UTC');
  await expect(row.locator('time')).toHaveAttribute('datetime', '2026-08-24T09:14:32Z');
  // And the licence beside it, which is what ODbL asks for on the 46 feeds it governs.
  await expect(row.getByText('(Etalab 2.0)')).toBeVisible();

  // The owners are behind the disclosure and genuinely hidden until it is opened, which is what
  // makes the closed panel one row per group rather than one row per owner.
  const owner = row.getByRole('link', { name: 'Île-de-France Mobilités' });
  await expect(owner).toBeHidden();

  await row.locator('summary').click();

  await expect(owner).toBeVisible();
  // Each owner's link is the terms binding that owner alone, never the row's shared link. The
  // CC-BY condition on 35 of these feeds cannot be met by one link standing for all of them.
  await expect(owner).toHaveAttribute('href', 'https://prim.iledefrance-mobilites.fr/en/cgu');
  await expect(row.getByRole('link', { name: 'Tisséo' })).toHaveAttribute(
    'href',
    'https://data.toulouse-metropole.fr/pages/licence/',
  );
});

test('reports the feed as live rather than leaving the user guessing', async ({ page }) => {
  await page.goto('/');

  const status = page.locator('#status');
  await expect(status).toBeVisible();

  // One line at rest, because the layer rail below already names every degraded feed against
  // the layer it belongs to, and two panels saying the same thing is what filled the left of
  // the globe up. This counts; the rail says which.
  const summary = status.locator('summary');
  await expect(summary).toHaveText('Live, 3 feeds healthy');
  await expect(summary).toHaveAttribute('data-level', 'live');
  await expect(status.getByText('adsb.lol live, 2 in its last poll')).toBeHidden();

  await summary.click();

  // Named sources and real counts, one click away. "adsb.lol live, 2 in its last poll" and "down"
  // are different statements and this panel exists to make the true one available.
  await expect(status.getByText('adsb.lol live, 2 in its last poll')).toBeVisible();
});

test('never raises an error about a feed that has simply not been asked yet', async ({ page }) => {
  // Live on 2026-08-24 the first thing a viewer read was "1 of 5 feeds down" at error level while
  // nothing was down: `celestrak/gp` had zero failures, no error and no successful poll, because
  // its floor and its element sets are both on disk and a process started inside the six-hour
  // window opens no socket at all. 698 satellites were on the globe off that cache at the time.
  // It persists for the whole interval after a restart, so it sends whoever reads it to debug a
  // system that is working.
  await page.route('**/api/health', (route) =>
    route.fulfill({
      json: {
        status: 'ok',
        feeds: [
          feed('adsb.lol', 'aircraft', 2, 8),
          feed('vessels/union', 'vessels', 1, 60),
          {
            ...feed('celestrak/gp', 'satellites', 0, 21_600),
            healthy: false,
            last_success_at: null,
          },
        ],
      },
    }),
  );
  await page.goto('/');

  const status = page.locator('#status');
  // Child combinator from the page, not from `status`: nesting it inside the already-scoped
  // locator looks for `#status` inside `#status`. The combinator is still needed because a row's
  // notices are a `details` too, so a bare `#status summary` can match more than one.
  const summary = page.locator('#status > .status-disclosure > summary');
  await expect(summary).toHaveAttribute('data-level', 'live');
  await expect(summary).toHaveText('Live, 2 of 3 feeds polled');
  await expect(summary).not.toContainText('down');

  await summary.click();

  // Stated, not hidden, and muted rather than red: the viewer can see the feed has not run and
  // that nothing is wrong with it.
  const line = status.getByText('celestrak/gp not polled yet, every 6h');
  await expect(line).toBeVisible();
  await expect(line).toHaveAttribute('data-level', 'idle');
});

test('keeps the card shut until something is picked', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#globe canvas')).toBeVisible();

  await expect(page.locator('#card')).toBeHidden();
  await expect(page.locator('#vessel-card')).toBeHidden();
});

/**
 * Phase 2 acceptance 1, as far as a browser can prove it: a ship is drawn in a coastal
 * viewport with its name, type and speed.
 *
 * The click is what makes this proof rather than assertion. A `PointPrimitive` can only be
 * picked if it was drawn, so a card opening on a click at the ship's position is the layer
 * being wired, the primitive existing, and the card reading the record, all in one.
 */
test('draws a ship and opens its card with name, type and speed', async ({ page }) => {
  await page.goto(CLOSE_ON_CENTRE);
  const canvas = page.locator('#globe canvas');
  await expect(canvas).toBeVisible();
  // The rail count comes from the server's own feed health, so this only says the layer is
  // reported. The click below is what says it was drawn.
  await expect(railRow(page, 'Vessels')).toContainText('1');

  await canvas.click();

  const card = page.locator('#vessel-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('FINNMAID');
  // Type from the AIS ship-and-cargo code, speed in knots first because that is what a
  // bridge uses, and the provider next to the age because ADR 010 asks for both.
  await expect(card).toContainText('Passenger');
  await expect(card).toContainText('15.9 kt');
  await expect(card).toContainText('digitraffic');
  // The flag is the MID and says so: resolving a MID to a flag state is phase 5, and one
  // MID can cover several territories, so nothing here guesses a country.
  await expect(card).toContainText('MMSI MID 230');
  // One selection, one card.
  await expect(page.locator('#card')).toBeHidden();
});

/**
 * Phase 3 acceptance 1 and 2, the "renders like any other" half, which only a browser proves.
 *
 * The API assertions in `tests/api/test_routes.py` cover the payload. They say nothing about
 * whether the card draws it: nothing in the repository called `InfoCard.show()` at any level,
 * so the owner row, the provider row and the LADD row were never rendered by anything, and
 * deleting any of the three left the whole gate green.
 *
 * Routes registered here win over the ones in `beforeEach`, which is what puts the jet under
 * the camera and takes the ship out of the way so a click at the centre can only pick it.
 */
async function stubAircraftCard(page: Page, detail: (route: Route) => Promise<void>) {
  await page.route('**/api/aircraft', (route) => route.fulfill({ json: AIRCRAFT_AT_CENTRE }));
  await page.route('**/api/vessels*', (route) => route.fulfill({ json: NO_VESSELS }));
  await page.route('**/api/aircraft/*', detail);
}

test('draws a business jet and opens its card with the owner and the LADD flag', async ({
  page,
}) => {
  await stubAircraftCard(page, (route) => route.fulfill({ json: AIRCRAFT_DETAIL }));
  await page.goto(CLOSE_ON_CENTRE);
  const canvas = page.locator('#globe canvas');
  await expect(canvas).toBeVisible();

  await canvas.click();

  const card = page.locator('#card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('N1972');
  await expect(card).toContainText('Business jet');
  // The registry join, which is the phase 3 deliverable, and the provider ADR 010 puts on
  // the record rather than on the layer.
  await expect(card).toContainText('Nike Inc');
  await expect(card).toContainText('adsb.lol');
  // ADR 009: an attribute, never a display block. Nothing here is suppressed.
  await expect(card).toContainText('FAA LADD');
  await expect(card).toContainText('on the programme');
  await expect(card).toContainText('Aircraft registry data via adsbdb.com');
  // Follow mode existed with nothing on screen saying so, so nobody found it. The card is
  // where the hint belongs: a selection is the only time there is anything to follow.
  await expect(card).toContainText('Press F to follow. Drag the globe to let go.');
  await expect(page.locator('#vessel-card')).toBeHidden();
});

/**
 * A failed registry request has to say so, because nothing retries it.
 *
 * The rejection used to be swallowed with the owner line left on "looking up", so a card open
 * against a 502 read as a lookup still in flight for as long as the card stayed open. Three
 * different outcomes shared one word.
 */
test('says the registry lookup failed rather than looking up forever', async ({ page }) => {
  await stubAircraftCard(page, (route) => route.fulfill({ status: 502, body: 'bad gateway' }));
  await page.goto(CLOSE_ON_CENTRE);
  const canvas = page.locator('#globe canvas');
  await expect(canvas).toBeVisible();

  await canvas.click();

  const card = page.locator('#card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('lookup failed, not retried');
  await expect(card).not.toContainText('looking up');
});

/**
 * Phase 2 acceptance 2, the half a browser can prove: a satellite propagates and is drawn.
 *
 * The rail's satellite count is the browser's own count, not the server's:
 * `withDrawnSatelliteCount` replaces it with what the layer holds, precisely because an
 * object SGP4 refused and an element set past its epoch are both held server side and
 * neither is drawn. So a 1 here means the worker propagated the ISS and the layer drew it.
 */
test('propagates the orbital elements and draws a satellite', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#globe canvas')).toBeVisible();

  await expect(railRow(page, 'Satellites')).toContainText('1');
});

/**
 * ADR 010: a provider that errors drops out of the union and the layer reports itself
 * degraded naming the provider. The rail used to read that off `/api/capabilities`, which is
 * a credential check, so a provider failing every cycle showed as fully live.
 */
test('names a provider that dropped out, and the count only one provider saw', async ({ page }) => {
  await page.goto('/');
  const vessels = railRow(page, 'Vessels');
  await expect(vessels).toBeVisible();

  await expect(vessels).toContainText('aishub dropped out: HTTP 500');
  await expect(vessels).toContainText('digitraffic only: 1');
  await expect(vessels).toHaveAttribute('data-state', 'degraded');
});

/**
 * Phase 4 acceptance 6: copying the URL into a fresh tab reproduces camera and layers.
 *
 * Both halves in one test, because they are one line of boot wiring each and the exclusion of
 * `src/main.ts` from unit coverage used to rest on a comment claiming this file covered them.
 * It did not: there was no test in here that touched a hash, a switch or the camera.
 */
test('a shared link reopens the camera and the layer switches it names', async ({ page }) => {
  await page.route('**/api/vessels*', (route) => route.fulfill({ json: ROTTERDAM_VESSELS }));

  await page.goto(
    `/#lon=${String(ROTTERDAM.lon)}&lat=${String(ROTTERDAM.lat)}&alt=60000&off=satellites,military`,
  );
  const canvas = page.locator('#globe canvas');
  await expect(canvas).toBeVisible();

  // The layer half. A name the URL asks for is off, everything else is on.
  await expect(railSwitch(page, 'Satellites')).not.toBeChecked();
  await expect(railSwitch(page, 'Military')).not.toBeChecked();
  await expect(railSwitch(page, 'Vessels')).toBeChecked();
  await expect(railSwitch(page, 'Cities')).toBeChecked();
  await expect(railSwitch(page, 'Clouds')).toBeChecked();

  // The camera half. The ship parked at Rotterdam is only under the crosshair if the camera
  // went where the hash said, so its card opening is the camera position asserted.
  await clickUntilCardOpens(canvas, page.locator('#vessel-card'), 'MAASSTAD');
});

/**
 * Phase 4 acceptance 4, as far as a browser can reach it: the switch exists, moves, and is
 * written into the URL so the view is shareable with the layer off.
 *
 * What is deliberately not asserted here is that the labels left the globe. Cesium labels are
 * primitives rather than DOM, and the only browser-visible signal is the canvas pixels, which
 * are not stable enough to carry it: measured on this machine, hiding the layer changed 767
 * pixels and showing it again differed from the original frame by 195, because the same text
 * re-rasterises slightly differently. Any inequality assertion over that survives a layer that
 * never hides, so it would be a test that passes either way. `CityLayer.setVisible` is covered
 * properly in `src/globe/layers/cities.test.ts` against a fake collection.
 */
test('the Cities switch moves and the URL carries it', async ({ page }) => {
  await page.route('**/api/cities*', (route) => route.fulfill({ json: CITIES }));

  await page.goto('/');
  await expect(page.locator('#globe canvas')).toBeVisible();
  const cities = railSwitch(page, 'Cities');
  await expect(cities).toBeChecked();

  await cities.uncheck();

  // A switch does not move the camera, so the URL only says this if the rail told it to.
  expect(page.url()).toContain('off=cities');

  await cities.check();

  expect(page.url()).not.toContain('off=cities');
});

/**
 * The ownership spine, which is the demo and which nothing in the frontend read until now.
 *
 * The backend serves it and the card has to keep two cases apart. Getting this wrong puts a real
 * person's name against an aircraft they have nothing to do with, so both directions are asserted
 * rather than just the happy one.
 */
test('states an asserted ownership join and names the officer it came from', async ({ page }) => {
  await stubAircraftCard(page, (route) =>
    route.fulfill({ json: { ...AIRCRAFT_DETAIL, ownership: OWNERSHIP_ASSERTED } }),
  );
  await page.goto(CLOSE_ON_CENTRE);
  const canvas = page.locator('#globe canvas');
  await expect(canvas).toBeVisible();

  await canvas.click();

  const card = page.locator('#card');
  await expect(card).toBeVisible();
  // The registrant exactly as the register wrote it, and the register's own extract date rather
  // than the date of the request.
  await expect(card).toContainText('SOUTHWEST AIRLINES CO');
  await expect(card).toContainText('faa, extract of 2026-08-20');
  await expect(card).toContainText('Stated');
  await expect(card).toContainText('Southwest Airlines Co');
  // The officer, with the filing that put them there and the date on the role.
  await expect(card).toContainText('KELLY GARY C');
  await expect(card).toContainText('Executive Chairman');
  await expect(card).toContainText('as of 2026-08-10');
  await expect(card).toContainText('named on an SEC Form 3, 4 or 5');
  // The tier is empty and says why, because eleven blanks read as a broken product.
  await expect(card).toContainText('no keyless public source publishes one');
  // No confidence on a stated match: a score next to a fact invites discounting the fact.
  await expect(card).not.toContainText('confidence');
  // No warning, because there is nothing unproven.
  await expect(page.locator('.card-ownership-note')).toBeHidden();
});

test('labels a possible ownership match and says what it has not proved', async ({ page }) => {
  await stubAircraftCard(page, (route) =>
    route.fulfill({ json: { ...AIRCRAFT_DETAIL, ownership: OWNERSHIP_POSSIBLE } }),
  );
  await page.goto(CLOSE_ON_CENTRE);
  const canvas = page.locator('#globe canvas');
  await expect(canvas).toBeVisible();

  await canvas.click();

  const card = page.locator('#card');
  await expect(card).toBeVisible();
  // Labelled, scored, and never stated. 0.6 is above a threshold someone might pick, which is
  // exactly why the card reads `asserted` instead of comparing anything.
  await expect(card).toContainText('Possible match, confidence 0.60');
  await expect(card).not.toContainText('Stated');
  // The sentence that stops a real officer being read as this aircraft's owner.
  const note = page.locator('.card-ownership-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText('Not established that United Airlines Holdings');
  await expect(note).toContainText('not of this aircraft');
});

test('does not call an aircraft absent from a register it never read', async ({ page }) => {
  // `ownership: null` means both "the register does not hold this airframe" and "the register is
  // not loaded", and nothing in the payload separates them. Measured 2026-08-24 against the live
  // backend: all four N-register aircraft returned null while the ownership layer reported itself
  // unavailable, so the second case is the one a demo actually hits. Claiming the first would be
  // asserting the one thing the card cannot know.
  await stubAircraftCard(page, (route) =>
    route.fulfill({ json: { ...AIRCRAFT_DETAIL, ownership: null } }),
  );
  await page.goto(CLOSE_ON_CENTRE);
  const canvas = page.locator('#globe canvas');
  await expect(canvas).toBeVisible();

  await canvas.click();

  const ownership = page.locator('.card-ownership');
  await expect(ownership).toBeVisible();
  await expect(ownership).not.toContainText('not on the register');
  await expect(ownership).not.toContainText('not in this register');
  await expect(page.locator('.card-ownership-note')).toBeHidden();
});

/**
 * Phase 4's search box, as far as a browser can prove it: a row is painted, and picking it
 * moves the camera.
 *
 * Reduced motion, so the flight is a cut rather than 1.6 seconds this test has to wait out.
 * That is `globe/flyto.ts`'s own behaviour and not a test-only path.
 */
test('typing a place name paints a pickable row and picking it flies the camera', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/search*', (route) => route.fulfill({ json: ROTTERDAM_SEARCH }));
  await page.route('**/api/vessels*', (route) => route.fulfill({ json: ROTTERDAM_VESSELS }));

  await page.goto('/');
  const canvas = page.locator('#globe canvas');
  await expect(canvas).toBeVisible();

  // `/` is the shortcut every map and code host uses, and it is bound on the document.
  await page.keyboard.press('/');
  const input = page.locator('.search-input');
  await expect(input).toBeFocused();
  await input.fill('Rotterdam');

  const row = page.locator('.search-hit').first();
  await expect(row).toContainText('Rotterdam');
  await expect(row).toContainText('South Holland');
  await row.click();

  // The camera flew to the port, so the ship parked there is now under the crosshair.
  await clickUntilCardOpens(canvas, page.locator('#vessel-card'), 'MAASSTAD');
});

/**
 * How long the tests below let the jet fly before clicking where it started.
 *
 * Six seconds at 300 m/s is 1.8km. The camera lands 80km up after a search fly-to, which is
 * about 150 metres to the pixel, so that is a dozen pixels of drift against a pick tolerance
 * of three. The control test underneath is what proves the number is big enough rather than
 * leaving it as arithmetic in a comment.
 */
const DRIFT_MS = 6000;

/**
 * Search for the moving jet and pick it, which flies the camera to it and opens its card.
 *
 * Selected through the search box rather than by clicking it, so the selection does not depend
 * on where the aircraft has drifted to by the time the page has loaded.
 */
async function selectTheMovingJet(page: Page): Promise<Locator> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/aircraft', (route) => route.fulfill({ json: FAST_JET_AT_CENTRE }));
  await page.route('**/api/vessels*', (route) => route.fulfill({ json: NO_VESSELS }));
  await page.route('**/api/aircraft/*', (route) => route.fulfill({ json: AIRCRAFT_DETAIL }));
  await page.route('**/api/search*', (route) => route.fulfill({ json: JET_SEARCH }));

  await page.goto('/');
  const canvas = page.locator('#globe canvas');
  await expect(canvas).toBeVisible();

  await page.keyboard.press('/');
  await page.locator('.search-input').fill('N1972');
  const row = page.locator('.search-hit').first();
  await expect(row).toContainText('N1972');
  await row.click();
  await expect(page.locator('#card')).toContainText('N1972');
  return canvas;
}

/**
 * Phase 4 acceptance 5, the half a browser can prove: follow mode tracks a moving aircraft.
 *
 * Nothing on screen states that follow mode is engaged, so a click is the only question a
 * browser can put to it: is the thing still in the middle of the canvas. It is, because the
 * camera and the point are extrapolated from the same fix by the same function.
 *
 * Disengaging on a drag is not provable here for the same reason, and is covered by
 * `src/globe/follow.test.ts`, which drives the real pointer handlers.
 */
test('the follow key keeps a moving aircraft under the crosshair', async ({ page }) => {
  const canvas = await selectTheMovingJet(page);

  await page.keyboard.press('f');
  await page.waitForTimeout(DRIFT_MS);

  // Retried, and retrying costs nothing here: a followed aircraft stays in the middle, so a
  // later click lands on it too. An unfollowed one is further away with every attempt.
  await clickUntilCardOpens(canvas, page.locator('#card'), 'N1972');
});

/**
 * The control for the test above, and the reason it means anything.
 *
 * Without the follow key the aircraft flies out from under the crosshair, so the same click
 * picks nothing and the card shuts. If this ever passes for the wrong reason, so does the
 * test above.
 */
test('without the follow key the same aircraft drifts out from under the crosshair', async ({
  page,
}) => {
  const canvas = await selectTheMovingJet(page);

  await page.waitForTimeout(DRIFT_MS);
  await canvas.click();

  await expect(page.locator('#card')).toBeHidden();
});

/**
 * The gazetteer read is the largest response this app asks for and the one most likely to time
 * out. It has no socket behind it and nothing repolls it, so a failure is permanent for the
 * tab, and the rail was reporting the server's row count over a layer holding none.
 */
test('a failed gazetteer read says so on the rail rather than the server count', async ({
  page,
}) => {
  await page.route('**/api/cities*', (route) => route.fulfill({ status: 500, body: 'boom' }));

  await page.goto('/');
  await expect(page.locator('#globe canvas')).toBeVisible();

  const cities = railRow(page, 'Cities');
  await expect(cities).toContainText('city labels could not be read');
  await expect(cities).toHaveAttribute('data-state', 'degraded');
});

/**
 * The cloud layer, which is the one layer here that talks to nobody but NASA.
 *
 * Two things a browser can observe and the unit suite cannot: that the sheets reached the
 * globe at all, which is what having a working switch on the row proves, and that the switch
 * is written into the URL so a view can be shared with the clouds off. What is deliberately
 * not asserted is the pixels: an imagery layer is not in the DOM, and a canvas comparison of
 * a semi-transparent infrared sheet over a stubbed one-pixel basemap would pass either way.
 * `src/globe/layers/clouds.test.ts` carries the sheet handling against a fake collection.
 */
test('the Clouds switch moves and the URL carries it', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#globe canvas')).toBeVisible();

  // A switch at all is the assertion: the rail gives one only to a layer that is available,
  // and the cloud layer is available only once a `HEAD` for a real slot came back.
  const clouds = railSwitch(page, 'Clouds');
  await expect(clouds).toBeChecked();

  await clouds.uncheck();
  expect(page.url()).toContain('off=clouds');

  await clouds.check();
  expect(page.url()).not.toContain('off=clouds');
});

/**
 * A cloud layer that found no imagery says so, rather than being a switch over an empty sky.
 *
 * GIBS answers 404 for a ten-minute frame it has not built yet, and the newest frame always
 * is one, so "the tiles 404" is the normal case rather than the broken one. This is the
 * broken case: every slot for every satellite refused. Only the cloud layers are failed
 * here, not the whole host, because a failed basemap puts Cesium's own error panel over the
 * canvas and that is a different test.
 */
test('says why the cloud layer is empty rather than showing an empty sky', async ({ page }) => {
  await page.route(/Band13_Clean_Infrared/, (route) => route.fulfill({ status: 404 }));

  await page.goto('/');
  const row = railRow(page, 'Clouds');
  await expect(row).toHaveAttribute('data-state', 'unavailable');
  await expect(row).toContainText('NASA GIBS published no cloud imagery in the last 90 minutes');
  // No switch on an unavailable layer: a control that cannot do anything is worse than none.
  await expect(row.locator('input.rail-switch')).toHaveCount(0);
});

test('has no serious accessibility violations on the map view', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#globe canvas')).toBeVisible();

  // The only a11y check that works on this app. No ESLint plugin can see a DOM built at
  // runtime, and html-validate only reads the static shell, so axe against the real
  // rendered page is what is left.
  const results = await new AxeBuilder({ page })
    // Cesium's own widget markup is not ours to fix and we do not control its releases.
    .exclude('.cesium-viewer')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();

  expect(results.violations).toEqual([]);
});

/**
 * The three legibility findings a browser can hold and axe cannot.
 *
 * Axe checks contrast and names, and this app passes both: a sweep on 2026-08-23 measured 65
 * strings and found no failure, the tightest being the error red at 8.16:1 against a 4.5
 * requirement. What axe does not check is how big a focus ring is, whether a control is off the
 * bottom of a scroll container with no cue, or whether one string is smaller than every other.
 * Those three are measured here instead, because this audience includes people who do not see
 * well and every one of them was a real finding rather than a hypothetical.
 */
test('puts a layer switch focus ring round the row, not round the 20px box', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#globe canvas')).toBeVisible();
  const toggle = railSwitch(page, 'Aircraft');
  await expect(toggle).toBeAttached();

  await toggle.focus();

  // The pointer target has always been the whole row, because the checkbox sits in a label.
  // The ring was not: it landed on the 20x20 checkbox, so the most-used control on the rail had
  // the smallest focus indicator on screen. Measured: 400px of indicator against a 15,576px
  // target.
  // Through the locator rather than `page.evaluate`, so the element arrives as a parameter and
  // the window comes off it. A bare `document` or `getComputedStyle` in here is code the linter
  // cannot see the scope of, which is what `unicorn/isolated-functions` is for.
  const ring = await toggle.evaluate((input) => {
    const head = input.closest('.rail-head');
    const view = input.ownerDocument.defaultView;
    if (head === null || view === null) {
      return null;
    }
    const style = view.getComputedStyle(head);
    const box = head.getBoundingClientRect();
    return {
      style: `${style.outlineStyle} ${style.outlineWidth}`,
      area: Math.round(box.width * box.height),
    };
  });

  expect(ring?.style).toBe('solid 3px');
  expect(ring?.area ?? 0).toBeGreaterThan(10_000);
});

/**
 * The social layer, which is the last thing on the original list to reach the screen.
 *
 * What is asserted is the row and the notice, not the pins. A post's mark is a Cesium primitive
 * rather than DOM, so the browser can only prove the layer is wired and saying the right thing
 * about what it searched; `globe/layers/social.test.ts` covers the pin against the ring.
 */
test('carries a social row and repeats what the provider actually searched', async ({ page }) => {
  // Commons caps its geosearch at a 10km radius and has no world call, so a wide viewport gets one
  // search at the box centre. A sparse scatter with nothing said about it reads as a broken layer,
  // which is the failure this project keeps meeting from the other direction.
  await page.route('**/api/social*', (route) =>
    route.fulfill({
      json: {
        ...NO_SOCIAL,
        box_radius_m: 180_000,
        searched_radius_m: 10_000,
        notices: ['Searched 10km of a 180km view: Wikimedia Commons caps geosearch at 10km.'],
      },
    }),
  );

  await page.goto('/');
  await expect(page.locator('#globe canvas')).toBeVisible();

  const row = railRow(page, 'Social');
  await expect(row).toBeVisible();
  await expect(railSwitch(page, 'Social')).toBeChecked();
  // The provider's own sentence, on the row, where every other layer's notice goes.
  await expect(row).toContainText('caps geosearch at 10km');
});

test('says nothing about the search radius when the provider covered the view', async ({
  page,
}) => {
  // The other half. A notice that appeared on every view would be furniture rather than
  // information, and the response is what decides: no notice, no line.
  await page.goto('/');
  await expect(page.locator('#globe canvas')).toBeVisible();

  const row = railRow(page, 'Social');
  await expect(row).toBeVisible();
  await expect(row).not.toContainText('geosearch');
});

test('collapses the whole rail on a projector, and opens it on a click', async ({ page }) => {
  // 1280x620 is a 720p projector with browser chrome, which is what a demo runs on. Measured
  // 2026-08-23: the dock's content was taller than its own `100vh - 96px` cap at that height, so
  // three layer switches sat below the fold behind an overlay scrollbar that leaves no mark on
  // screen. Collapsed, the dock is 202px instead of about 700 and every switch is one click away.
  await page.setViewportSize({ width: 1280, height: 620 });
  await page.goto('/');
  await expect(page.locator('#globe canvas')).toBeVisible();

  const summary = page.locator('.rail-collapse-summary');
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('layers');
  await expect(page.locator('.rail-collapse')).not.toHaveAttribute('open', '');
  // The one thing that must stay readable while the rail is shut. The banner is a separate
  // element in the same column and carries feed health without anyone having to ask for it.
  await expect(page.locator('#status')).toBeVisible();

  await summary.click();

  await expect(page.locator('.rail-collapse')).toHaveAttribute('open', '');
  await expect(railSwitch(page, 'Clouds')).toBeVisible();
});

test('leaves the rail alone on a tall window, costing no row at all', async ({ page }) => {
  // The other half of the same decision, and the one that makes it worth having. The collapse
  // must not appear on an ordinary laptop: a 44px summary permanently on a column already holding
  // fourteen 44px elements would be the opposite of the point.
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/');
  await expect(page.locator('#globe canvas')).toBeVisible();

  await expect(page.locator('.rail-collapse-summary')).toBeHidden();
  await expect(page.locator('.rail-collapse')).toHaveAttribute('open', '');
  await expect(railSwitch(page, 'Clouds')).toBeVisible();
});

test('keeps every layer switch reachable once the collapsed rail is opened', async ({ page }) => {
  // This test used to assert that a below-the-fold switch scrolled into view on focus, which was
  // the right guarantee while the rail overflowed the dock at this height. It no longer overflows:
  // the rail collapses instead, so the switch is behind a closed disclosure rather than below a
  // fold. What still needs holding is the half after the click, because the opened rail caps
  // itself at `50vh` and scrolls, so a switch could be reachable in the DOM and still out of
  // reach on screen.
  await page.setViewportSize({ width: 1280, height: 620 });
  await page.goto('/');
  await expect(page.locator('#globe canvas')).toBeVisible();

  await page.locator('.rail-collapse-summary').click();
  const clouds = railSwitch(page, 'Clouds');
  await clouds.focus();

  const reachable = await clouds.evaluate((element) => {
    const body = element.closest('.rail-collapse-body');
    if (body === null) {
      return false;
    }
    const box = element.getBoundingClientRect();
    const within = body.getBoundingClientRect();
    return box.top >= within.top - 1 && box.bottom <= within.bottom + 1;
  });

  expect(reachable).toBe(true);
  await expect(clouds).toBeFocused();
});

test('keeps every string in our own chrome at 14px or larger', async ({ page }) => {
  // Stubbed rather than left to reach a running backend, which is what it used to do. With no
  // server on :8000 the search call got ECONNREFUSED, `.search-hit` never appeared, and the
  // failure reported against the line below as if the type scale were wrong: a font failure
  // for a network cause, which sends the next person reading the wrong file. Every other test
  // in this suite stubs, and a suite with an undocumented prerequisite fails on a clean
  // machine and gets blamed on whatever that person happened to be changing.
  await page.route('**/api/search*', (route) => route.fulfill({ json: ROTTERDAM_SEARCH }));
  // A grouped credit, so the owner names and the licence date are on screen to be measured.
  // They are strings in our own chrome that nothing else here opens, and the whole point of
  // this floor is that a fact nobody can read is a fact the product did not state.
  await page.route('**/api/capabilities', (route) =>
    route.fulfill({ json: { ...CAPABILITIES, attribution: [GROUPED_CREDIT] } }),
  );

  await page.goto('/');
  await expect(page.locator('#globe canvas')).toBeVisible();
  // Open the credits and the search results, since both hold text that is absent at rest.
  await page.locator('#attribution > summary').click();
  await page.locator('#attribution details > summary').click();
  await expect(page.getByRole('link', { name: 'Île-de-France Mobilités' })).toBeVisible();
  await page.locator('.search-input').fill('Rotterdam');
  const hit = page.locator('.search-hit').first();
  await expect(hit).toBeVisible();
  // The stub's own wording, asserted so the route cannot quietly stop matching. Without this,
  // a changed URL pattern would put the test back on the network and the next failure would
  // read as a font problem again. Verified with every un-stubbed `/api/**` call aborted:
  // capabilities, cities and social abort, and this one does not, because it is fulfilled in
  // the browser and never leaves it.
  await expect(hit).toContainText('Rotterdam, South Holland, Netherlands');

  // The floor exists because a credit once rendered at 10px, and a fact nobody can read is a
  // fact the product did not state. Cesium's own markup is excluded for the same reason the
  // axe check excludes it: it is not ours and we do not control its releases.
  const small = await page.locator('body').evaluate((body) => {
    const view = body.ownerDocument.defaultView;
    if (view === null) {
      return ['no window'];
    }
    const found: string[] = [];
    for (const element of body.querySelectorAll('*')) {
      if (element.closest('#globe') !== null || element.closest('.cesium-viewer') !== null) {
        continue;
      }
      // Own text only. Counting inherited text would report a wrapper at its parent's size and
      // say nothing about the string a reader is actually looking at.
      const own = [...element.childNodes]
        .filter((node) => node.nodeType === 3 && (node.textContent ?? '').trim() !== '')
        .map((node) => (node.textContent ?? '').trim())
        .join(' ');
      if (own === '') {
        continue;
      }
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) {
        continue;
      }
      // `Number` on the stripped string rather than `parseFloat` on the raw one: the rule
      // prefers the coercion, and `Number('14px')` is NaN, so the `px` has to come off first.
      const px = Number(view.getComputedStyle(element).fontSize.replace('px', ''));
      if (px < 14) {
        found.push(`${String(px)}px "${own.slice(0, 30)}"`);
      }
    }
    return found;
  });

  expect(small).toEqual([]);
});

test('survives a backend that is not there', async ({ page }) => {
  // Override the stubs: the globe and the baseline credits must still be on screen, since
  // the imagery comes straight from NASA and does not depend on our API at all.
  await page.route('**/api/**', (route) => route.abort());

  await page.goto('/');

  await expect(page.locator('#globe canvas')).toBeVisible();
  // The credits control is on screen with no API at all, and the baseline list is behind it:
  // the imagery comes straight from NASA, so its credit cannot depend on our API being up.
  // Three, not two: the cloud layer's credit is one of the two the browser owns outright.
  await expect(page.locator('#attribution > summary')).toHaveAttribute(
    'aria-label',
    'Data sources and licences (3)',
  );
  await page.locator('#attribution > summary').click();
  await expect(page.locator('#attribution')).toContainText('Aircraft data from adsb.lol');

  // And the cloud layer is one of the two things still on the globe, because it asks NASA
  // rather than us. A row with a working switch is what says the sheets got there.
  await expect(railSwitch(page, 'Clouds')).toBeChecked();
});
