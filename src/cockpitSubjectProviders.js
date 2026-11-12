/**
 * @module cockpitSubjectProviders
 * @description Subject providers: kinds of subject an application adds to the
 * Cockpit beside its own aircraft, satellite and vessel. A provider names the
 * subject entry would take, holds it while the view rides it, hands the camera
 * a frame each update and the HUD a view model, and releases it on exit. Core
 * knows nothing else about it.
 *
 * Everything a provider returns is normalized here before the Cockpit uses
 * it: a malformed provider is left out, a malformed frame ends the view, and a
 * malformed HUD view is read field by field, never thrown on.
 *
 * Pure: no Cesium, no DOM.
 */

/** The kinds the Cockpit rides itself; no provider may take one. */
export const COCKPIT_BUILT_IN_KINDS = Object.freeze([
  'aircraft',
  'satellite',
  'vessel',
]);

/** The tones a provider's HUD texts may take. */
export const COCKPIT_SUBJECT_TONES = Object.freeze([
  'normal',
  'muted',
  'live',
  'estimate',
  'warning',
  'alert',
]);

/** The most readouts, sources and signals a HUD view shows. */
export const COCKPIT_SUBJECT_MAX_READOUTS = 4;
export const COCKPIT_SUBJECT_MAX_SOURCES = 4;
export const COCKPIT_SUBJECT_MAX_SIGNALS = 4;
/** The most ticks a progress line takes. */
export const COCKPIT_SUBJECT_MAX_TICKS = 512;

const KIND_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const LAYER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ICON_PATTERN = /^[a-z0-9_]{1,40}$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const REQUIRED_METHODS = Object.freeze([
  'candidate',
  'hold',
  'read',
  'hud',
  'release',
]);
const RESERVED = new Set(COCKPIT_BUILT_IN_KINDS);
const TONES = new Set(COCKPIT_SUBJECT_TONES);

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/**
 * `value` as display text: trimmed, at most `max` characters (the last one
 * an ellipsis when cut); '' for anything that is not a string or a number.
 */
export function cockpitSubjectText(value, max) {
  if (typeof value !== 'string' && !finite(value)) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const tone = (value) => (TONES.has(value) ? value : 'normal');

/** A Material Symbols entry face, or null. */
function faceOf(raw) {
  if (!isObject(raw)) return null;
  const label = cockpitSubjectText(raw.label, 16);
  if (typeof raw.icon !== 'string' || !ICON_PATTERN.test(raw.icon) || !label)
    return null;
  return Object.freeze({ icon: raw.icon, label });
}

/** Why `provider` cannot be kept, or null. */
function refusal(provider, kinds) {
  if (!isObject(provider)) return 'not an object';
  if (typeof provider.kind !== 'string' || !KIND_PATTERN.test(provider.kind))
    return 'malformed kind';
  if (RESERVED.has(provider.kind)) return 'reserved kind';
  if (kinds.has(provider.kind)) return 'repeated kind';
  if (
    typeof provider.layerId !== 'string' ||
    !LAYER_ID_PATTERN.test(provider.layerId)
  )
    return 'malformed layer id';
  for (const method of REQUIRED_METHODS)
    if (typeof provider[method] !== 'function') return `no ${method}()`;
  if (
    provider.isEntryAllowed !== undefined &&
    typeof provider.isEntryAllowed !== 'function'
  )
    return 'isEntryAllowed is not a function';
  if (!faceOf(provider.entryFace)) return 'malformed entry face';
  const labels = provider.labels;
  if (
    !isObject(labels) ||
    !cockpitSubjectText(labels.view, 48) ||
    !cockpitSubjectText(labels.exit, 48) ||
    !cockpitSubjectText(labels.exitText, 24)
  )
    return 'labels need view, exit and exitText';
  if (
    provider.look != null &&
    (!isObject(provider.look) ||
      !cockpitSubjectText(provider.look.aheadLabel, 64))
  )
    return 'look needs an aheadLabel';
  return null;
}

/**
 * The application's subject providers, checked once and frozen, in the order
 * entry asks them: ascending `priority`, ties in list order. Each has
 * - `kind`: /^[a-z][a-z0-9-]{1,31}$/, not a built-in kind, unique;
 * - `layerId`: the catalog layer the subject belongs to (entry needs it on);
 * - `priority`: a finite number (default 0);
 * - `entryFace`: `{icon, label}`, a Material Symbols name and a label of at
 *   most 16 characters, in the page's language;
 * - `labels`: `{view, exit, exitText, kicker?}`, the HUD's and the exit
 *   button's accessible names, the exit button's text and the default kicker,
 *   in the page's language;
 * - `look` (optional): `{restPitchDeg?, aheadLabel}`, arrow-key look-around as
 *   on a bridge, resting at `restPitchDeg` (default 0, -90..90), its Look
 *   ahead button named `aheadLabel`;
 * - `cameraIntervalMs` (optional): 0..1000, null for the Cockpit's default; 0
 *   updates the camera every rendered frame;
 * - `headingSlewDps` (optional): how fast the view turns to a new heading,
 *   positive or Infinity, null for the Cockpit's default;
 * - `candidate()`, `isEntryAllowed(candidate)` (optional), `hold(id)`,
 *   `read(nowMs, ctx)`, `hud(frame, ctx)` and `release(id, {restore})`.
 *
 * A provider that is not so is left out with one warning naming it.
 * @param {unknown} list
 * @param {{warn?: (message: string) => void}} [options]
 * @returns {ReadonlyArray<object>}
 */
export function cockpitSubjectProviders(
  list = [],
  { warn = (message) => console.warn(message) } = {},
) {
  const kept = [];
  const kinds = new Set();
  (Array.isArray(list) ? list : []).forEach((provider, order) => {
    const reason = refusal(provider, kinds);
    if (reason) {
      const name =
        typeof provider?.kind === 'string'
          ? provider.kind.slice(0, 32)
          : `#${order}`;
      warn(`[Cockpit] subject provider ${name} left out: ${reason}`);
      return;
    }
    kinds.add(provider.kind);
    const look = isObject(provider.look)
      ? Object.freeze({
          restPitchDeg: finite(provider.look.restPitchDeg)
            ? clamp(provider.look.restPitchDeg, -90, 90)
            : 0,
          aheadLabel: cockpitSubjectText(provider.look.aheadLabel, 64),
        })
      : null;
    kept.push(
      Object.freeze({
        kind: provider.kind,
        layerId: provider.layerId,
        priority: finite(provider.priority) ? provider.priority : 0,
        order,
        entryFace: faceOf(provider.entryFace),
        labels: Object.freeze({
          view: cockpitSubjectText(provider.labels.view, 48),
          exit: cockpitSubjectText(provider.labels.exit, 48),
          exitText: cockpitSubjectText(provider.labels.exitText, 24),
          kicker: cockpitSubjectText(provider.labels.kicker, 48),
        }),
        look,
        cameraIntervalMs:
          finite(provider.cameraIntervalMs) &&
          provider.cameraIntervalMs >= 0 &&
          provider.cameraIntervalMs <= 1000
            ? provider.cameraIntervalMs
            : null,
        headingSlewDps:
          provider.headingSlewDps === Infinity ||
          (finite(provider.headingSlewDps) && provider.headingSlewDps > 0)
            ? provider.headingSlewDps
            : null,
        candidate: provider.candidate,
        isEntryAllowed: provider.isEntryAllowed ?? (() => true),
        hold: provider.hold,
        read: provider.read,
        hud: provider.hud,
        release: provider.release,
      }),
    );
  });
  kept.sort((a, b) => a.priority - b.priority || a.order - b.order);
  return Object.freeze(kept);
}

/**
 * A provider's candidate: `{id, name, face}`, or null without a usable id.
 * `name` falls back to the id; `face` is null unless well formed.
 * @param {unknown} raw What `candidate()` returned.
 */
export function cockpitSubjectCandidate(raw) {
  if (!isObject(raw) || typeof raw.id !== 'string') return null;
  const id = raw.id.trim();
  if (!id || id.length > 128) return null;
  return Object.freeze({
    id,
    name: cockpitSubjectText(raw.name, 64) || cockpitSubjectText(id, 64),
    face: faceOf(raw.face),
  });
}

/**
 * One camera frame from a provider, normalized, or null when it cannot place
 * the camera (the view then ends): not an object, an id other than `heldId`,
 * a position that is not finite, or an eye with no valid `upM`.
 * @param {unknown} raw What `read()` returned.
 * @param {string} heldId The subject the view holds.
 * @returns {object|null} `{id, name, latitude, longitude, heightM, headingDeg,
 *   courseDeg, speedMps, stale, groundClamp, anchor, eye: {upM, forwardM,
 *   pitchDeg, minClearanceM}}`.
 */
export function cockpitSubjectFrame(raw, heldId) {
  if (!isObject(raw) || raw.id !== heldId) return null;
  const latitude = raw.latitude;
  const longitude = raw.longitude;
  if (!finite(latitude) || !finite(longitude) || Math.abs(latitude) > 90)
    return null;
  const eye = isObject(raw.eye) ? raw.eye : null;
  if (!eye || !finite(eye.upM) || eye.upM < 0 || eye.upM > 1000) return null;
  const heading = (value) =>
    finite(value) ? ((value % 360) + 360) % 360 : null;
  const headingDeg = heading(raw.headingDeg);
  return {
    id: heldId,
    name: cockpitSubjectText(raw.name, 64) || cockpitSubjectText(heldId, 64),
    latitude,
    longitude: ((((longitude + 180) % 360) + 360) % 360) - 180,
    heightM: finite(raw.heightM) ? raw.heightM : null,
    headingDeg,
    courseDeg: heading(raw.courseDeg) ?? headingDeg,
    speedMps: finite(raw.speedMps) && raw.speedMps >= 0 ? raw.speedMps : null,
    stale: raw.stale === true,
    groundClamp: raw.groundClamp !== false,
    anchor: raw.anchor === 'exact' ? 'exact' : 'inertial',
    eye: {
      upM: eye.upM,
      forwardM:
        finite(eye.forwardM) && Math.abs(eye.forwardM) <= 500
          ? eye.forwardM
          : 0,
      pitchDeg: finite(eye.pitchDeg) ? clamp(eye.pitchDeg, -90, 90) : 0,
      minClearanceM:
        finite(eye.minClearanceM) && eye.minClearanceM >= 0
          ? eye.minClearanceM
          : 0,
    },
  };
}

/** A list of `{id, ...}` rows, each read by `row`, at most `max` kept. */
function rowsOf(raw, max, row) {
  if (!Array.isArray(raw)) return [];
  const rows = [];
  const ids = new Set();
  for (const entry of raw) {
    if (rows.length >= max) break;
    if (!isObject(entry)) continue;
    const id = typeof entry.id === 'string' ? entry.id : '';
    if (!ID_PATTERN.test(id) || ids.has(id)) continue;
    const read = row(entry);
    if (!read) continue;
    ids.add(id);
    rows.push({ id, ...read });
  }
  return rows;
}

/** A progress line, or null without at least two ticks. */
function progressOf(raw) {
  if (!isObject(raw) || !Array.isArray(raw.ticks)) return null;
  const ticks = [];
  for (const tick of raw.ticks) {
    if (ticks.length >= COCKPIT_SUBJECT_MAX_TICKS) break;
    if (!isObject(tick) || !finite(tick.at) || tick.at < 0 || tick.at > 1)
      continue;
    let label = null;
    if (isObject(tick.label)) {
      const text = cockpitSubjectText(tick.label.text, 40);
      if (text)
        label = {
          text,
          detail: cockpitSubjectText(tick.label.detail, 64),
          priority: finite(tick.label.priority)
            ? clamp(Math.round(tick.label.priority), 0, 9)
            : 0,
          align: ['start', 'center', 'end'].includes(tick.label.align)
            ? tick.label.align
            : 'center',
        };
    }
    ticks.push({ at: tick.at, tone: tone(tick.tone), label });
  }
  if (ticks.length < 2) return null;
  ticks.sort((a, b) => a.at - b.at);
  const marker =
    isObject(raw.marker) && finite(raw.marker.at)
      ? { at: clamp(raw.marker.at, 0, 1), dwell: raw.marker.dwell === true }
      : null;
  return {
    ticks,
    marker,
    tag: cockpitSubjectText(raw.tag, 16),
    summary: cockpitSubjectText(raw.summary, 160),
  };
}

/**
 * A provider's HUD view model, normalized; never throws. Texts are coerced
 * and cut to their caps, lists to their lengths, tones to
 * COCKPIT_SUBJECT_TONES, numbers clamped; a malformed member reads as absent.
 * All text is shown as given: the provider words it in the page's language.
 * @param {unknown} raw What `hud()` returned.
 * @returns {object} `{kicker, title, meta: {text, tone}, speed: {value, unit,
 *   tag, tone}|null, readouts: [{id, label, value, detail, tone}],
 *   sources: [{id, label, text, tone}],
 *   route: {title, from, to, status}|null,
 *   progress: {ticks: [{at, tone, label: {text, detail, priority,
 *   align}|null}], marker: {at, dwell}|null, tag, summary}|null,
 *   banner: {title, detail, tone}|null, veil: {level, streaks}|null,
 *   lookReadout, signals: [{id, tone, title, detail}]}`.
 */
export function cockpitSubjectHudView(raw) {
  const view = isObject(raw) ? raw : {};
  const meta = isObject(view.meta) ? view.meta : {};
  const speed =
    isObject(view.speed) &&
    (view.speed.value === null ||
      (finite(view.speed.value) && view.speed.value >= 0))
      ? {
          value:
            view.speed.value === null
              ? null
              : Math.min(view.speed.value, 99_999),
          unit: cockpitSubjectText(view.speed.unit, 12),
          tag: cockpitSubjectText(view.speed.tag, 8),
          tone: tone(view.speed.tone),
        }
      : null;
  const route = isObject(view.route)
    ? {
        title: cockpitSubjectText(view.route.title, 32),
        from: cockpitSubjectText(view.route.from, 48),
        to: cockpitSubjectText(view.route.to, 48),
        status: cockpitSubjectText(view.route.status, 64),
      }
    : null;
  const bannerTitle = isObject(view.banner)
    ? cockpitSubjectText(view.banner.title, 48)
    : '';
  const veil =
    isObject(view.veil) && finite(view.veil.level)
      ? {
          level: clamp(view.veil.level, 0, 1),
          streaks: view.veil.streaks === true,
        }
      : null;
  return {
    kicker: cockpitSubjectText(view.kicker, 48),
    title: cockpitSubjectText(view.title, 64),
    meta: { text: cockpitSubjectText(meta.text, 96), tone: tone(meta.tone) },
    speed,
    readouts: rowsOf(view.readouts, COCKPIT_SUBJECT_MAX_READOUTS, (row) => {
      const label = cockpitSubjectText(row.label, 24);
      const value = cockpitSubjectText(row.value, 48);
      return label || value
        ? {
            label,
            value,
            detail: cockpitSubjectText(row.detail, 80),
            tone: tone(row.tone),
          }
        : null;
    }),
    sources: rowsOf(view.sources, COCKPIT_SUBJECT_MAX_SOURCES, (row) => {
      const text = cockpitSubjectText(row.text, 120);
      return text
        ? {
            label: cockpitSubjectText(row.label, 16),
            text,
            tone: tone(row.tone),
          }
        : null;
    }),
    route: route && (route.from || route.to) ? route : null,
    progress: progressOf(view.progress),
    banner: bannerTitle
      ? {
          title: bannerTitle,
          detail: cockpitSubjectText(view.banner.detail, 96),
          tone: tone(view.banner.tone),
        }
      : null,
    veil: veil && veil.level > 0 ? veil : null,
    lookReadout: cockpitSubjectText(view.lookReadout, 48),
    signals: rowsOf(view.signals, COCKPIT_SUBJECT_MAX_SIGNALS, (row) => {
      const title = cockpitSubjectText(row.title, 48);
      return title
        ? {
            title,
            detail: cockpitSubjectText(row.detail, 96),
            tone: tone(row.tone),
          }
        : null;
    }),
  };
}

/**
 * A guarded caller for provider methods: `call(provider, method, args,
 * fallback)` returns what the method returns, or `fallback` when it throws,
 * warning once per provider and method.
 * @param {{warn?: (message: string, error: unknown) => void}} [options]
 */
export function createCockpitSubjectCaller({
  warn = (message, error) => console.warn(message, error),
} = {}) {
  const warned = new Set();
  return function call(provider, method, args = [], fallback = null) {
    try {
      return provider[method](...args);
    } catch (error) {
      const key = `${provider.kind}:${method}`;
      if (!warned.has(key)) {
        warned.add(key);
        warn(
          `[Cockpit] subject provider ${provider.kind} ${method}() failed`,
          error,
        );
      }
      return fallback;
    }
  };
}
