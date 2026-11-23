/**
 * Keep browser QA off third-party aircraft photo services.
 *
 * Tracking a civil flight asks Planespotters for the aircraft's photo. QA
 * runs track synthetic hexes, so a real request only adds a third-party
 * dependency and, when the service refuses a headless browser, a console
 * error that fails the "no console errors" checks. Every photo lookup is
 * answered with no photos instead, without leaving the browser.
 */

/** Origin of the aircraft photo lookup. */
export const PLANESPOTTERS_ORIGIN = 'https://api.planespotters.net';

/** The answer every stubbed lookup gets: no photos for this aircraft. */
export const PLANESPOTTERS_EMPTY_BODY = JSON.stringify({ photos: [] });

/** Whether a URL is a photo lookup the stub answers. */
export function isPlanespottersRequest(url) {
  try {
    return new URL(String(url)).origin === PLANESPOTTERS_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * Answer an intercepted photo lookup from a page that already uses request
 * interception. Returns false for any other request, which the caller
 * handles as before.
 * @param {import('puppeteer').HTTPRequest} request
 * @returns {boolean} Whether the request was answered.
 */
export function respondToPlanespotters(request) {
  if (!isPlanespottersRequest(request.url())) return false;
  request.respond({
    status: 200,
    contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: PLANESPOTTERS_EMPTY_BODY,
  });
  return true;
}

/**
 * Stub photo lookups in a page that does not intercept requests: wraps
 * `fetch` before any app code runs, so a lookup never reaches the network.
 * Composes with other `fetch` shims in either order.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<void>}
 */
export async function stubPlanespotters(page) {
  await page.evaluateOnNewDocument(
    (origin, body) => {
      const original = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const href =
          typeof input === 'string' ? input : input?.url || String(input);
        let target = '';
        try {
          target = new URL(href, location.href).origin;
        } catch {
          /* not a URL */
        }
        if (target === origin) {
          return Promise.resolve(
            new Response(body, {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        }
        return original(input, init);
      };
    },
    PLANESPOTTERS_ORIGIN,
    PLANESPOTTERS_EMPTY_BODY,
  );
}
