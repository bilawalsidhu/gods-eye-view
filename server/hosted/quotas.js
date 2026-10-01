/**
 * Per-user request quotas for the hosted profile, so one account cannot
 * drain the operator's OpenSky, Google, OpenAI or AISStream allowances.
 *
 * Fixed windows per (user, family). Families are matched by URL prefix;
 * the first match wins, `*` is the catch-all for every other /api route.
 * Override with GEV_QUOTAS="/api/realtime/token=10/3600,*=900/60".
 */

export const DEFAULT_QUOTAS = Object.freeze([
  ['/api/realtime/token', 20, 3600],
  ['/api/openai', 60, 3600],
  ['/api/places', 300, 3600],
  ['/api/geocode', 300, 3600],
  ['/api/regional-brief', 120, 3600],
  ['/api/watch/channels', 60, 3600],
  ['/api/cameras/coverage', 120, 3600],
  ['/api/history/range', 600, 3600],
  ['*', 1200, 60],
]);

export function parseQuotas(text) {
  if (!text) return DEFAULT_QUOTAS.map((q) => [...q]);
  const out = [];
  for (const raw of String(text).split(',')) {
    const m = /^\s*(\*|\/api\/[\w/.-]+)\s*=\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(raw);
    if (!m)
      throw new Error(
        `invalid quota "${raw.trim()}" (expected /api/path=COUNT/SECONDS)`,
      );
    out.push([m[1], Number(m[2]), Number(m[3])]);
  }
  if (!out.some((q) => q[0] === '*')) out.push(['*', 1200, 60]);
  return out;
}

export function createQuotas(
  rules = DEFAULT_QUOTAS,
  { now = Date.now, maxKeys = 50_000 } = {},
) {
  const windows = new Map();
  function family(path) {
    for (const rule of rules)
      if (
        rule[0] !== '*' &&
        (path === rule[0] ||
          path.startsWith(`${rule[0]}/`) ||
          path.startsWith(`${rule[0]}?`))
      )
        return rule;
    return rules.find((r) => r[0] === '*');
  }
  return {
    /** @returns {{ok: boolean, retryAfter?: number, limit: number, remaining: number}} */
    take(user, path) {
      const [name, limit, seconds] = family(path);
      const key = `${user}|${name}`;
      const t = now();
      let w = windows.get(key);
      if (!w || t - w.start >= seconds * 1000) {
        w = { start: t, count: 0 };
        windows.delete(key);
        windows.set(key, w);
        if (windows.size > maxKeys) windows.delete(windows.keys().next().value);
      }
      if (w.count >= limit)
        return {
          ok: false,
          limit,
          remaining: 0,
          retryAfter: Math.ceil((w.start + seconds * 1000 - t) / 1000),
        };
      w.count++;
      return { ok: true, limit, remaining: limit - w.count };
    },
  };
}
