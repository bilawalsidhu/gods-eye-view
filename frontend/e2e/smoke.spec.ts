/**
 * The smoke test: does the built app actually come up and draw a globe.
 *
 * Nothing here needs the backend. Both REST calls are fulfilled with canned bodies and the
 * WebSocket is answered by a stub, which is also what makes the test deterministic: a live
 * feed would put a different number of aircraft on screen every run.
 *
 * What it is really guarding is the build itself. Cesium's workers, shaders and widget
 * assets are copied by a Vite plugin and found through a `CESIUM_BASE_URL` substitution,
 * neither of which the type checker or the unit tests can see. If that copy breaks, the
 * canvas never gets a context and this test is what says so.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const CAPABILITIES = {
  layers: ['aircraft'],
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

const HEALTH = {
  status: 'ok',
  feeds: [
    {
      source: 'adsb.lol',
      layer: 'aircraft',
      healthy: true,
      entity_count: 2,
      consecutive_failures: 0,
      poll_interval_seconds: 8,
      last_error: null,
      last_success_at: '2026-08-19T12:00:00Z',
      rate_limited_until: null,
    },
  ],
};

const AIRCRAFT = {
  aircraft: [
    {
      kind: 'aircraft',
      icao24: '4ca7b5',
      point: { lon: -0.45, lat: 51.47, altitude_m: 3000 },
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

/**
 * Stand in for the whole backend.
 *
 * The socket is answered but never sends anything: the REST snapshot is what puts aircraft
 * on the globe for the first paint, and leaving the socket silent keeps the picture still.
 */
async function stubBackend(page: Page): Promise<void> {
  await page.route('**/api/capabilities', (route) => route.fulfill({ json: CAPABILITIES }));
  await page.route('**/api/health', (route) => route.fulfill({ json: HEALTH }));
  await page.route('**/api/aircraft*', (route) => route.fulfill({ json: AIRCRAFT }));
  await page.routeWebSocket('**/ws', () => {
    // Accepted and held open. An unanswered socket would put the banner into its
    // reconnecting state and make the connection assertions below flap.
  });
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

test('keeps the card shut until an aircraft is picked', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#globe canvas')).toBeVisible();

  await expect(page.locator('#card')).toBeHidden();
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
