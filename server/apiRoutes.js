/**
 * Every `/api` mount this server installs, in the order the plugins install it.
 *
 * The mounts themselves live one per provider, so the only way to answer "what
 * does this server expose?" was to read 29 files — and the answer moved
 * whenever one of them did. This table is that answer as data, and
 * `src/tooling/apiRoutes.test.mjs` installs the real plugins against a
 * recording stub and fails when the two disagree, so it describes the server
 * rather than documenting an intention.
 *
 * Order is part of the contract, not incidental. Connect matches a middleware
 * by prefix and runs the FIRST one that matches, so `/api` — the catch-all that
 * answers "Unknown API route" — only behaves as a fallback because it is
 * installed last. Move it earlier and it swallows every route below it while
 * every individual handler still looks correct in isolation.
 *
 * The surface is not the same in both servers: 34 mounts under `npm run dev`
 * against 32 under `npm run preview`. `gev-key-setup` keeps its two
 * `/api/setup` mounts out of preview twice over, and deliberately — it declares
 * `apply: command === 'serve' && !isPreview`, and it also defines only
 * `configureServer`, never `configurePreviewServer`, because (as its own note
 * records) a bare `apply: 'serve'` would still configure under preview. Rows
 * absent from preview carry `serveOnly`, and the test builds both chains rather
 * than assuming one surface.
 */
export const API_FALLBACK_MOUNT = '/api';

export const API_ROUTES = Object.freeze(
  [
    { mount: '/api/opensky', plugin: 'opensky-proxy' },
    { mount: '/api/celestrak', plugin: 'celestrak-proxy' },
    { mount: '/api/tomtom', plugin: 'tomtom-proxy' },
    { mount: '/api/firms', plugin: 'firms-proxy' },
    { mount: '/api/launches', plugin: 'rocket-launches-proxy' },
    { mount: '/api/terrain/heights', plugin: 'terrain-heights-proxy' },
    { mount: '/api/adsbdb', plugin: 'adsbdb-proxy' },
    { mount: '/api/overpass', plugin: 'overpass-proxy' },
    // Mounted by the Overpass plugin, though the handler lives in places/routes.js.
    { mount: '/api/route', plugin: 'overpass-proxy' },
    {
      mount: '/api/military-installations',
      plugin: 'military-installations-proxy',
    },
    { mount: '/api/regional-brief', plugin: 'regional-brief-proxy' },
    { mount: '/api/geocode', plugin: 'geocode-proxy' },
    { mount: '/api/weather-effects', plugin: 'weather-effects-proxy' },
    { mount: '/api/cctv', plugin: 'cctv-proxy' },
    { mount: '/api/radio', plugin: 'radio-browser-proxy' },
    { mount: '/api/gbfs', plugin: 'gbfs-proxy' },
    { mount: '/api/local-receivers/aircraft', plugin: 'local-receivers-proxy' },
    { mount: '/api/transit', plugin: 'transit-proxy' },
    { mount: '/api/adsblol/mil', plugin: 'adsblol-proxy' },
    { mount: '/api/ais-live', plugin: 'ais-live-proxy' },
    { mount: '/api/opensky-track', plugin: 'track-backfill-proxies' },
    { mount: '/api/adsblol/trace', plugin: 'track-backfill-proxies' },
    { mount: '/api/openai/hud-summary', plugin: 'openai-realtime-proxy' },
    { mount: '/api/realtime/debug-log', plugin: 'openai-realtime-proxy' },
    { mount: '/api/realtime/token', plugin: 'openai-realtime-proxy' },
    {
      mount: '/api/google/nearby-places',
      plugin: 'google-places-context-proxy',
    },
    { mount: '/api/google/text-search', plugin: 'google-places-context-proxy' },
    { mount: '/api/wind', plugin: 'wind' },
    { mount: '/api/weather', plugin: 'weather' },
    { mount: '/api/cyclones', plugin: 'cyclones' },
    { mount: '/api/fire-perimeters', plugin: 'fire-perimeters' },
    // Dev server only: the plugin's `apply` excludes the preview server.
    { mount: '/api/setup/status', plugin: 'gev-key-setup', serveOnly: true },
    { mount: '/api/setup/keys', plugin: 'gev-key-setup', serveOnly: true },
    { mount: API_FALLBACK_MOUNT, plugin: 'api-not-found' },
  ].map((route) => Object.freeze(route)),
);

/**
 * Resolve a request path the way the installed middleware chain resolves it.
 *
 * Connect compares a mount against the start of the path and treats the match
 * as real only when the mount ends at a segment boundary — where `.` counts as
 * a boundary alongside `/`, so `/api/gbfs.json` reaches the GBFS handler while
 * `/api/gbfsXYZ` does not and falls through to the catch-all. The first mount
 * that matches wins, which is why this walks the table in install order instead
 * of preferring the longest prefix.
 *
 * @param {string} pathname - Request path, without query or hash.
 * @returns {{mount: string, plugin: string}|undefined} The winning route.
 */
export function matchApiRoute(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/'))
    return undefined;
  return API_ROUTES.find(({ mount }) => {
    if (!pathname.startsWith(mount)) return false;
    const next = pathname.charAt(mount.length);
    return next === '' || next === '/' || next === '.';
  });
}
