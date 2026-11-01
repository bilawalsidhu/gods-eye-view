/**
 * Voice surface of Sky view: one thin adapter over the mounted Sky handle
 * (skyView.js), reachable through the shell hook `window.__gevSky.voice`.
 * No voice tool is registered against it in this tree; it becomes reachable
 * once a tool (for example `control_sky`) is wired to that hook.
 *
 *   open     stand at the map centre and look up
 *   close    leave the sky, back to the map
 *   look     a planet, the ISS, or a constellation (search, then look-at)
 *   time     the time of night (ISO 8601 with a zone) or back to live
 *   lines    constellation lines on or off
 *   preset   sunset, dusk, midnight, moonrise, or the next ISS pass
 *   status   read-only state
 *
 * It adds no state of its own and never throws: an unusable request answers
 * {ok:false, error} so the model can say why. Errors never repeat the text
 * the caller sent.
 */
import { MAX_JUMP_SCORE } from './skyContent.js';
import { SKY_TIME_MAX_MS, SKY_TIME_MIN_MS } from './skyClock.js';
import { PRESETS } from './skyPresets.js';

export const SKY_VOICE_ACTIONS = Object.freeze([
  'open',
  'close',
  'look',
  'time',
  'lines',
  'preset',
  'status',
]);

export const SKY_PRESET_IDS = Object.freeze(PRESETS.map((preset) => preset.id));

/** Spoken ISS names the catalogue stores as ISS (ZARYA). */
const ISS_ALIASES = new Map([
  ['iss', 'ISS (ZARYA)'],
  ['international space station', 'ISS (ZARYA)'],
  ['space station', 'ISS (ZARYA)'],
]);

const ZONE = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_HEAD = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?/;

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

const fold = (text) =>
  String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Parse a sky-time target. Returns {ms} or {error}. A date alone means
 * 00:00 UTC; a time of day must carry a zone, so the answer never depends
 * on the browser's own time zone. The caller's text is never returned.
 */
export function parseSkyTime(value) {
  if (typeof value !== 'string' || !value.trim())
    return { error: 'time must be an ISO 8601 date-time string' };
  const text = value.trim();
  if (!ISO_HEAD.test(text) || (!DATE_ONLY.test(text) && text[10] !== 'T'))
    return {
      error: 'time must be an ISO 8601 date-time such as 2026-03-04T02:00:00Z',
    };
  if (!DATE_ONLY.test(text) && !ZONE.test(text))
    return {
      error:
        'time needs a zone (Z or an offset such as -06:00); convert the spoken local time first',
    };
  const ms = Date.parse(DATE_ONLY.test(text) ? `${text}T00:00:00Z` : text);
  if (!Number.isFinite(ms)) return { error: 'time is not a valid date' };
  return { ms };
}

function issQuery(raw) {
  const key = fold(raw).replace(/^the /, '');
  return ISS_ALIASES.get(key) || null;
}

/**
 * @param {object} options
 *   getHandle () => mounted Sky view handle, or null
 */
export function createSkyVoice({ getHandle, satelliteWaitMs = 2000 }) {
  const handle = () => {
    const sky = getHandle?.();
    return sky && !sky.destroyed ? sky : null;
  };
  const unavailable = () => fail('Sky view is not available right now');

  const snapshot = (sky) => {
    const timeMs = sky.time?.getTime?.();
    const marker = sky.content?.marker;
    return {
      open: Boolean(sky.active),
      time: Number.isFinite(timeMs) ? new Date(timeMs).toISOString() : null,
      timeMode: sky.clock?.mode || null,
      lines: Boolean(sky.content?.flags?.lines),
      lookingAt: marker?.label || null,
      ...(sky.observer
        ? {
            latitude: sky.observer.latDeg,
            longitude: sky.observer.lonDeg,
          }
        : {}),
    };
  };

  const done = (sky, extra = {}) => ({ ok: true, ...snapshot(sky), ...extra });

  async function ensureOpen(sky) {
    if (sky.active) return { ok: true, opened: false };
    if (typeof sky.openHere !== 'function')
      return fail('Sky view cannot open from here');
    const opened = await sky.openHere();
    if (!opened?.ok) return fail(opened?.error || 'Could not open Sky view');
    return { ok: true, opened: !opened.alreadyOpen };
  }

  return {
    presetIds: () => [...SKY_PRESET_IDS],
    status() {
      const sky = handle();
      return sky ? done(sky) : unavailable();
    },
    async open() {
      const sky = handle();
      if (!sky) return unavailable();
      const opened = await ensureOpen(sky);
      if (!opened.ok) return opened;
      const current = handle();
      if (!current || current !== sky) return unavailable();
      return done(current, { opened: opened.opened });
    },
    close() {
      const sky = handle();
      if (!sky) return unavailable();
      if (sky.active) sky.exit?.();
      return done(sky, { closed: true });
    },
    async look(target) {
      const sky = handle();
      if (!sky) return unavailable();
      if (
        typeof target !== 'string' ||
        !target.trim() ||
        target.trim().length > 80
      )
        return fail(
          'look needs the name of a planet, the ISS, or a constellation',
        );
      const opened = await ensureOpen(sky);
      if (!opened.ok) return opened;
      let live = handle();
      if (!live || live !== sky) return unavailable();
      try {
        await live.content?.ensureData?.();
      } catch {
        /* planets still search; constellations say they are not loaded */
      }
      live = handle();
      if (!live || live !== sky) return unavailable();
      const alias = issQuery(target);
      if (alias && satelliteWaitMs && live.satellites?.status === 'loading') {
        const start = Date.now();
        while (
          handle() === sky &&
          live.satellites?.status === 'loading' &&
          Date.now() - start < satelliteWaitMs
        ) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        live = handle();
        if (!live || live !== sky) return unavailable();
      }
      let results = alias ? live.content.search(alias) : [];
      if (!results.length) results = live.content.search(target.trim());
      const jumpable = results.filter((hit) => hit.score <= MAX_JUMP_SCORE);
      const best = jumpable[0];
      if (!best) {
        const sat = live.satellites?.status;
        return fail('Nothing matched that name', {
          ...(results.length
            ? { candidates: results.slice(0, 3).map((hit) => hit.label) }
            : {}),
          ...(sat === 'loading' ? { satellites: 'loading' } : {}),
          ...(live.content?.status === 'loading' ? { stars: 'loading' } : {}),
        });
      }
      const tied = jumpable.filter(
        (hit) => hit.score === best.score && hit.kind === best.kind,
      );
      if (tied.length > 1)
        return fail('More than one match. Ask which one.', {
          candidates: tied.slice(0, 5).map((hit) => hit.label),
        });
      const at = live.content.lookAt(best);
      if (!at) return fail('No position for that object right now');
      return done(live, {
        opened: opened.opened,
        target: best.label,
        kind: best.kind,
        azimuthDeg: at.azDeg,
        elevationDeg: at.elDeg,
        belowHorizon: at.elDeg < 0,
      });
    },
    async time({ time, live } = {}) {
      const sky = handle();
      if (!sky) return unavailable();
      const opened = await ensureOpen(sky);
      if (!opened.ok) return opened;
      const current = handle();
      if (!current || current !== sky) return unavailable();
      if (live === true) {
        current.goLive?.();
        return done(current, { opened: opened.opened, live: true });
      }
      const parsed = parseSkyTime(time);
      if (parsed.error) return fail(parsed.error);
      const clamped =
        parsed.ms > SKY_TIME_MAX_MS
          ? 'future'
          : parsed.ms < SKY_TIME_MIN_MS
            ? 'past'
            : null;
      if (current.setTime?.(parsed.ms) === false)
        return fail('Could not move the Sky time');
      return done(current, {
        opened: opened.opened,
        ...(clamped ? { clamped } : {}),
      });
    },
    async lines(enabled) {
      const sky = handle();
      if (!sky) return unavailable();
      if (typeof enabled !== 'boolean')
        return fail('lines needs enabled true or false');
      const opened = await ensureOpen(sky);
      if (!opened.ok) return opened;
      const current = handle();
      if (!current || current !== sky) return unavailable();
      current.content.setFlags({ lines: enabled }, { notify: true });
      return done(current, { opened: opened.opened });
    },
    async preset(id) {
      const sky = handle();
      if (!sky) return unavailable();
      const preset = typeof id === 'string' ? id.trim().toLowerCase() : '';
      if (!SKY_PRESET_IDS.includes(preset))
        return fail(`preset must be one of ${SKY_PRESET_IDS.join(', ')}`);
      const opened = await ensureOpen(sky);
      if (!opened.ok) return opened;
      const current = handle();
      if (!current || current !== sky) return unavailable();
      let result;
      try {
        result = await current.applyPreset(preset);
      } catch {
        return fail('That preset could not be applied');
      }
      const after = handle();
      if (!after || after !== current) return unavailable();
      if (!result?.ok)
        return fail(result?.reason || 'That preset was not found');
      const clockMs = after.time?.getTime?.();
      if (
        Number.isFinite(result.timeMs) &&
        Number.isFinite(clockMs) &&
        Math.abs(clockMs - result.timeMs) > 1500
      )
        return fail('A newer time change won. Ask again.');
      return done(after, {
        opened: opened.opened,
        preset,
        ...(Number.isFinite(result.timeMs)
          ? { time: new Date(result.timeMs).toISOString() }
          : {}),
      });
    },
  };
}
