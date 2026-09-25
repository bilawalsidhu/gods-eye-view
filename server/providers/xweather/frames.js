const CANONICAL = /\/(\d{14})_(\d{14})\.png$/;
const fail = (code, status = 503) =>
  Object.assign(new Error(code), { code, status });
const pad = (value) => String(value).padStart(2, '0');

/** UTC `YYYYMMDDhhmmss`, the only absolute time Xweather tiles accept. */
export function xweatherStamp(epochMs) {
  const d = new Date(epochMs);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/** The stamp's ISO instant, or `null` when it names no real calendar date. */
function stampToIso(stamp) {
  const ms = Date.UTC(
    +stamp.slice(0, 4),
    +stamp.slice(4, 6) - 1,
    +stamp.slice(6, 8),
    +stamp.slice(8, 10),
    +stamp.slice(10, 12),
    +stamp.slice(12, 14),
  );
  // Date.UTC silently normalizes out-of-range fields (e.g. month 13, hour
  // 25) into a different, valid date; round-tripping through xweatherStamp
  // catches that instead of trusting the normalized result.
  if (!Number.isFinite(ms) || xweatherStamp(ms) !== stamp) return null;
  return new Date(ms).toISOString();
}

/**
 * The code for a response Xweather did not serve as asked:
 * `xweather_upstream_error` when it refused the request (401 or 403, or a
 * 200 whose body is JSON, as a refusal behind a proxy can be), which the
 * card reports as a refusal; `xweather_upstream_unavailable` for anything
 * else (404, 429, 5xx, a malformed redirect), which it does not.
 *
 * @param {{status: number, headers: Headers}} response
 * @returns {'xweather_upstream_error'|'xweather_upstream_unavailable'}
 */
export function xweatherRefused({ status, headers }) {
  const json = /^application\/(?:[\w.+-]+\+)?json(?:;|$)/i.test(
    headers.get('content-type') || '',
  );
  return status === 401 || status === 403 || (status === 200 && json)
    ? 'xweather_upstream_error'
    : 'xweather_upstream_unavailable';
}

/**
 * The exact frame Xweather serves for `at` ('current' or a stamp).
 *
 * Xweather answers any time with a 302 to the canonical frame
 * `…/{valid}_{run}.png` (`x-cost-tokens: 0`): a lookup costs no map units
 * (whether it counts toward the account's billing-period allowance is
 * unknown), and
 * only fetching that frame is billed. One z0 tile is asked for and its body
 * is never read.
 *
 * `base` embeds the client credentials and must never reach a thrown error:
 * a response that is not a redirect to a real canonical frame collapses to a
 * bare code (`xweather_upstream_error` when Xweather refused the request,
 * `xweather_upstream_unavailable` otherwise), and a fetch that rejects without
 * reaching Xweather (offline, DNS) to `xweather_network`; neither carries the
 * request URL or a library error message. A caller-driven cancellation (an
 * already-aborted `signal`, or the fetch rejecting with `AbortError`) is
 * reported separately as `xweather_aborted`, so an upstream gate deadline or
 * client disconnect is never mistaken for Xweather refusing the request.
 */
export async function resolveFrame({ fetchImpl, base, layer, at, signal }) {
  let response;
  try {
    response = await fetchImpl(`${base}/${layer}/0/0/0/${at}.png`, {
      redirect: 'manual',
      signal,
    });
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError')
      throw Object.assign(new Error('xweather_aborted'), {
        code: 'xweather_aborted',
        name: 'AbortError',
        status: 499,
      });
    throw fail('xweather_network');
  }
  await response.body?.cancel?.();
  const match =
    response.status >= 300 && response.status < 400
      ? CANONICAL.exec(response.headers.get('location') || '')
      : null;
  const time = match && stampToIso(match[1]);
  if (!time) throw fail(xweatherRefused(response));
  return { time, frame: `${match[1]}_${match[2]}` };
}

/**
 * Up to `count` exact frames ending at the newest, oldest first.
 *
 * Xweather answers an absolute time with the first frame at or after it (a
 * ceiling; measured 2026-09-25: 052237 -> 052238, 051100 -> 051239), so
 * asking for just before a frame returns that same frame. Each step instead
 * asks for `stepMs` (1.5 x the product's cadence) before the previous frame.
 * That lands between the two frames before it and resolves to the nearer
 * one, so the previous frame is taken while the spacing stays between about
 * 0.75 x and 1.5 x the cadence; a single missing frame makes the walk skip
 * the frame beyond it. A lookup that is not strictly earlier (a gap in the
 * feed) is retried once twice as far back; the walk stops after that second
 * miss, past `maxAgeMs`, or at `count`, so a frame costs at most two
 * lookups.
 *
 * `known` is the previous walk's list, oldest first. The walk then stops at
 * the first frame no newer than the newest known one and merges the two, so
 * a refresh after one new frame costs two lookups and one with none costs
 * one; an empty `known` (a cold start) walks the whole list. Lookups cost no
 * map units; whether they count toward the account's billing-period
 * allowance is unknown.
 */
export async function listFrames({
  resolve,
  stepMs,
  count = 13,
  now = Date.now,
  maxAgeMs = 86_400_000,
  known = [],
}) {
  if (!(count >= 1)) return [];
  if (!(stepMs > 0)) throw new TypeError('listFrames needs a positive stepMs');
  const kept = known.filter(({ time }) => now() - Date.parse(time) <= maxAgeMs);
  const newestKnown = Math.max(
    -Infinity,
    ...kept.map(({ time }) => Date.parse(time)),
  );
  const frames = [await resolve('current')];
  while (
    frames.length < count &&
    Date.parse(frames.at(-1).time) > newestKnown
  ) {
    const previous = Date.parse(frames.at(-1).time);
    let next = null;
    for (const back of [stepMs, 2 * stepMs]) {
      const found = await resolve(xweatherStamp(previous - back));
      if (Date.parse(found.time) < previous) {
        next = found;
        break;
      }
    }
    if (!next || now() - Date.parse(next.time) > maxAgeMs) break;
    frames.push(next);
  }
  if (!kept.length) return frames.reverse();
  const merged = new Map(kept.map((frame) => [frame.time, frame]));
  for (const frame of frames) merged.set(frame.time, frame);
  return [...merged.values()]
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
    .slice(-count);
}
