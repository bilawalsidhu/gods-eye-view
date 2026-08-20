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
 * The second is the wiring in `src/main.ts`, which is excluded from unit coverage because it
 * has no branches of its own. Phase 2 shipped a vessel layer, a vessel card and 774 lines
 * behind them that nothing imported, and every unit test passed. So the wiring is asserted
 * here instead: an aircraft, a ship and a satellite each have to reach the globe, and the
 * ship has to be pickable and open its card. Unit tests cannot see any of that.
 *
 * The canned bodies below are the real contract shapes, taken from `openapi.json`. A stub
 * shaped like something the backend does not serve is worse than no stub: an earlier version
 * of this file sent `layers: ['aircraft']` where `/api/capabilities` serves
 * `LayerCapability` objects, the layer rail threw on it, and every assertion after that
 * point in the first-paint sequence was silently never reached.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { issElements } from '../src/testing/satellite';

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
  ],
  attribution: [
    {
      source: 'adsb.lol',
      text: 'Aircraft data from adsb.lol',
      url: 'https://adsb.lol',
      licence: 'ODbL 1.0',
    },
    {
      source: 'NASA GIBS',
      text: 'Imagery courtesy of NASA EOSDIS GIBS',
      url: 'https://gibs.earthdata.nasa.gov',
      licence: 'Public domain, attribution requested',
    },
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
  ],
};

const AIRCRAFT = {
  count: 1,
  aircraft: [
    {
      kind: 'aircraft',
      icao24: '4ca7b5',
      // Well away from the camera centre, so the click below cannot pick this or its
      // callsign label instead of the ship.
      point: { lon: -2.5, lat: 51.47, altitude_m: 3000 },
      observed_at: '2026-08-19T12:00:00Z',
      position_age_s: 1.2,
      source: 'adsb.lol',
      callsign: 'BAW123',
      aircraft_class: 'commercial',
      emergency: 'none',
      is_military: false,
      message_source: 'adsb_icao',
      messages_received: 4200,
      non_icao_address: false,
      on_ground: false,
      uses_privacy_address: false,
      ground_speed_mps: 220,
      track_deg: 94.5,
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
  await page.routeWebSocket('**/ws', () => {
    // Accepted and held open. An unanswered socket would put the banner into its
    // reconnecting state and make the connection assertions below flap.
  });
}

/** The rail row for one layer, found by its heading rather than by position. */
function railRow(page: Page, label: string) {
  return page.locator('.rail-row').filter({ has: page.getByText(label, { exact: true }) });
}

test.beforeEach(async ({ page }) => {
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

test('shows the attribution the licences require', async ({ page }) => {
  await page.goto('/');

  const attribution = page.locator('#attribution');
  await expect(attribution).toBeVisible();

  // ODbL 1.0 requires attribution wherever adsb.lol data is shown and NASA asks for a
  // credit on GIBS imagery, so these are licence conditions rather than decoration.
  await expect(
    attribution.getByRole('link', { name: 'Aircraft data from adsb.lol' }),
  ).toBeVisible();
  await expect(
    attribution.getByRole('link', { name: 'Imagery courtesy of NASA EOSDIS GIBS' }),
  ).toBeVisible();
  await expect(attribution).toContainText('ODbL 1.0');
});

test('replaces the baseline credits with the list the API serves', async ({ page }) => {
  await page.goto('/');

  // Two entries in, two entries out: the panel must not append to the markup baseline and
  // end up showing every credit twice.
  await expect(page.locator('#attribution li')).toHaveCount(2);
});

test('reports the feed as live rather than leaving the user guessing', async ({ page }) => {
  await page.goto('/');

  const status = page.locator('#status');
  await expect(status).toBeVisible();
  await expect(status).toContainText('adsb.lol live, 2 tracked');
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
  await page.goto('/');
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

test('survives a backend that is not there', async ({ page }) => {
  // Override the stubs: the globe and the baseline credits must still be on screen, since
  // the imagery comes straight from NASA and does not depend on our API at all.
  await page.route('**/api/**', (route) => route.abort());

  await page.goto('/');

  await expect(page.locator('#globe canvas')).toBeVisible();
  await expect(page.locator('#attribution')).toContainText('Aircraft data from adsb.lol');
});
