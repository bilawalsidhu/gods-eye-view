// Helpers of scripts/qa-w1-baseline.mjs, the Cesium-mode reference of the
// W1 layers: recording the app's feed responses once, replaying them, a
// frozen page clock, and the comparison of two runs. Pure: no Node or
// browser APIs, so the rules are unit-tested.

/** The app's own API (the dev server proxies every data feed through it). */
export const isFeedRequest = (url) => new URL(url).pathname.startsWith('/api/');

// Cache-busting parameters do not change what a feed returns.
const VOLATILE_PARAMS = new Set(['_', 't', 'ts', 'cacheBust']);

function pathAndQuery(url) {
  const parsed = new URL(url);
  for (const name of [...parsed.searchParams.keys()])
    if (VOLATILE_PARAMS.has(name)) parsed.searchParams.delete(name);
  return { path: parsed.pathname, query: parsed.search };
}

/** 'GET /api/x?y=1': what a recorded response answers. */
export function feedRequestKey(method, url) {
  const { path, query } = pathAndQuery(url);
  return `${method.toUpperCase()} ${path}${query}`;
}

/**
 * The recorded response for a request: the same method, path and query,
 * else the last recorded response of that method and path (a viewport query
 * whose box moved), else null (the request is answered as unavailable).
 */
export function replayEntry(recording, method, url) {
  const key = feedRequestKey(method, url);
  const { path } = pathAndQuery(url);
  const entries = recording?.entries ?? [];
  const exact = entries.find((entry) => entry.key === key);
  if (exact) return exact;
  const prefix = `${method.toUpperCase()} `;
  const samePath = entries.filter(
    (entry) => entry.path === path && entry.key.startsWith(prefix),
  );
  return samePath.at(-1) ?? null;
}

/**
 * Page script (evaluateOnNewDocument) holding the page's Date at `ms`:
 * Date.now() and new Date() return it, so JulianDate.now and the app clock
 * stand still too; dates built from arguments are untouched.
 */
export function frozenClockScript(ms) {
  if (!Number.isFinite(ms)) throw new TypeError(`Frozen time ${ms}`);
  return `(() => {
  const FROZEN = ${Number(ms)};
  const RealDate = globalThis.Date;
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(FROZEN);
      else super(...args);
    }
    static now() {
      return FROZEN;
    }
  }
  globalThis.Date = FrozenDate;
})();`;
}

/**
 * The distinct feed requests one page made, and when the last new one came.
 * qa-w1-baseline waits on it (feedsSettled) instead of a fixed sleep.
 */
export function createFeedActivity(now = () => Date.now()) {
  const keys = new Set();
  let lastNewAt = now();
  return {
    keys,
    note(key) {
      if (keys.has(key)) return;
      keys.add(key);
      lastNewAt = now();
    },
    /** Time since the last new request key. */
    quietMs: () => now() - lastNewAt,
    asked: (predicate) => [...keys].some(predicate),
  };
}

/**
 * Resolves true once `ready()` holds and no new request key arrived for
 * `quietMs`; false after `maxMs` without that.
 */
export async function feedsSettled(
  activity,
  {
    ready = () => true,
    quietMs = 3000,
    maxMs = 45000,
    now = () => Date.now(),
    wait = () => new Promise((resolve) => setTimeout(resolve, 250)),
  } = {},
) {
  const start = now();
  for (;;) {
    if (ready() && activity.quietMs() >= quietMs) return true;
    if (now() - start >= maxMs) return false;
    await wait();
  }
}

// Not feeds: the app's debug log. Terrain heights are asked in batches of
// the points on screen, so their point lists depend on draw timing: they
// are compared as asked or not.
const DIAGNOSTIC_REQUESTS = new Set(['POST /api/realtime/debug-log']);
const FOLDED_PATHS = ['/api/terrain/heights'];

/** summary.json's `requests`: 'KEY → how answered', sorted, folded. */
export function requestDigest(served) {
  const lines = new Set();
  for (const [key, how] of served ?? []) {
    if (DIAGNOSTIC_REQUESTS.has(key)) continue;
    const [method, target] = key.split(' ');
    const path = target.split('?')[0];
    const folded = FOLDED_PATHS.includes(path) && target.includes('?');
    lines.add(`${method} ${folded ? `${path}?points=…` : target} → ${how}`);
  }
  return [...lines].sort();
}

/** Tolerances of compareBaselines. */
export const BASELINE_TOLERANCE = Object.freeze({
  degrees: 1e-7, // ≈ 1 cm
  metres: 0.05,
  screenPx: 0.5,
  poseRelative: 1e-6,
});

const distance3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * Differences between two summary.json runs of qa-w1-baseline (counts,
 * known objects' positions and screen points, tracking poses), within
 * BASELINE_TOLERANCE.
 * @returns {{ ok: boolean, differences: { layer: string, pose?: string, id?: string, what: string, a: any, b: any }[] }}
 */
export function compareBaselines(a, b, tolerance = BASELINE_TOLERANCE) {
  const differences = [];
  const add = (entry) => differences.push(entry);
  const layers = new Set([
    ...Object.keys(a.layers ?? {}),
    ...Object.keys(b.layers ?? {}),
  ]);
  for (const layer of layers) {
    const left = a.layers?.[layer];
    const right = b.layers?.[layer];
    if (!left || !right) {
      add({
        layer,
        what: 'layer missing',
        a: Boolean(left),
        b: Boolean(right),
      });
      continue;
    }
    const asked = (run) => JSON.stringify(run.requests ?? null);
    if (asked(left) !== asked(right))
      add({ layer, what: 'requests', a: left.requests, b: right.requests });
    const sharedAsked = (run) =>
      JSON.stringify(run.tracking?.sharedRequests ?? null);
    if (sharedAsked(left) !== sharedAsked(right))
      add({
        layer,
        what: 'shared-link requests',
        a: left.tracking?.sharedRequests,
        b: right.tracking?.sharedRequests,
      });
    if (left.fill?.count !== right.fill?.count)
      add({ layer, what: 'count', a: left.fill?.count, b: right.fill?.count });
    for (const pose of Object.keys(left.poses ?? {})) {
      const p = left.poses[pose];
      const q = right.poses?.[pose];
      if (!q) {
        add({ layer, pose, what: 'pose missing', a: true, b: false });
        continue;
      }
      if (p.rows !== q.rows)
        add({ layer, pose, what: 'row count', a: p.rows, b: q.rows });
      if (p.onScreen !== q.onScreen)
        add({
          layer,
          pose,
          what: 'on-screen count',
          a: p.onScreen,
          b: q.onScreen,
        });
      for (const known of p.known ?? []) {
        const other = (q.known ?? []).find((row) => row.id === known.id);
        if (!other || other.missing !== known.missing) {
          add({
            layer,
            pose,
            id: known.id,
            what: 'known object',
            a: known,
            b: other,
          });
          continue;
        }
        if (known.missing) continue;
        if (
          Math.abs(known.lat - other.lat) > tolerance.degrees ||
          Math.abs(known.lon - other.lon) > tolerance.degrees ||
          Math.abs((known.altitudeM ?? 0) - (other.altitudeM ?? 0)) >
            tolerance.metres
        )
          add({
            layer,
            pose,
            id: known.id,
            what: 'known position',
            a: known,
            b: other,
          });
        const s = known.screen;
        const t = other.screen;
        if (
          Boolean(s) !== Boolean(t) ||
          (s && Math.hypot(s.x - t.x, s.y - t.y) > tolerance.screenPx)
        )
          add({
            layer,
            pose,
            id: known.id,
            what: 'known screen point',
            a: s,
            b: t,
          });
      }
    }
    const tl = left.tracking?.poseAfter2s;
    const tr = right.tracking?.poseAfter2s;
    if (Boolean(left.tracking?.ok) !== Boolean(right.tracking?.ok))
      add({
        layer,
        what: 'tracking',
        a: left.tracking?.ok,
        b: right.tracking?.ok,
      });
    else if (tl && tr) {
      const scale = Math.max(1, Math.hypot(tl.x, tl.y, tl.z));
      if (distance3(tl, tr) / scale > tolerance.poseRelative)
        add({ layer, what: 'tracking pose', a: tl, b: tr });
    }
  }
  return { ok: differences.length === 0, differences };
}
