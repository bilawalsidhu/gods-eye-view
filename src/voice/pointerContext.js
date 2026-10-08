/**
 * Point-and-ask: what the cursor is on when the user starts to speak.
 *
 * The tracker listens to pointer movement over the globe canvas and keeps only
 * the latest position plus a dwell anchor — no per-move picking. A pick runs
 * lazily: once when the pointer settles (a dwell) and once at a snapshot, and
 * the snapshot reuses the dwell's pick when the pointer has not moved since.
 *
 * Snapshots are taken when the user decides to ask — Space keydown for
 * push-to-talk, speech start for open mic — not when they finish talking,
 * because people point before or while they speak. A push-to-talk keydown
 * snapshot is HELD and reused by every speech start inside that hold.
 *
 * A snapshot is only a referent when it is FRESH: the pointer is over the
 * canvas (not a panel on top of it), away from the canvas edge, and moved
 * within {@link POINTER_FRESH_MS}. A cursor parked in a corner or left behind
 * on the mic button is not "this".
 *
 * Provider-neutral and Cesium-free: the pick is injected.
 */

/** Movement below this many CSS pixels is still the same dwell. */
export const POINTER_DWELL_PX = 12;
/** Stillness that makes a dwell point. */
export const POINTER_DWELL_MS = 250;
/** A resting pointer stays a referent this long after it last moved. */
export const POINTER_FRESH_MS = 30000;
/** Pixels from the canvas edge that count as "parked", never a referent. */
export const POINTER_EDGE_PX = 8;
/** A dwell pick is reused by a snapshot only while this recent (contacts move). */
export const POINTER_DWELL_REUSE_MS = 1000;
/**
 * Open mic has no gesture, so the pointer only counts when it moved or
 * settled on the map this recently: a cursor resting there for minutes is
 * not the user pointing.
 */
export const POINTER_OPEN_MIC_RECENT_MS = 5000;
/** A held push-to-talk snapshot serves speech starts this long. */
export const POINTER_HOLD_MS = 20000;

const LABEL_MAX = 48;

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/** A real number, or null. `Number(null)` is 0, so empty values are rejected first. */
export function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
const finite = finiteOrNull;

/**
 * Camera pose identity: position to 1 m, orientation to about 0.06 degrees.
 * A pixel read under one key names nothing under another. Reads plain
 * numbers only, so it needs no Cesium import.
 * @param {object} viewer Cesium viewer.
 * @returns {string|null}
 */
export function cameraPoseKey(viewer) {
  const camera = viewer?.camera;
  const p = camera?.positionWC;
  if (!p || !Number.isFinite(p.x)) return null;
  const angle = (value) => Math.round((Number(value) || 0) * 1000);
  return [
    Math.round(p.x),
    Math.round(p.y),
    Math.round(p.z),
    angle(camera.heading),
    angle(camera.pitch),
    angle(camera.roll),
  ].join(',');
}

/** Bound and de-control a label before it goes to the model or the card. */
export function pointerLabel(value, max = LABEL_MAX) {
  const clean = String(value ?? '')
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Build a snapshot from one pick. A pick with neither an entity nor a ground
 * point (open sky, a failed pick) is not a referent.
 * @param {object} input
 * @returns {object} Snapshot; `fresh` false when there is nothing to name.
 */
export function buildPointerSnapshot({
  at,
  x,
  y,
  width,
  height,
  pick,
  capturedAt = Date.now(),
}) {
  const cameraKey = pick?.cameraKey ?? null;
  const entity = pick?.entity?.layerId
    ? {
        layerId: String(pick.entity.layerId),
        id: String(pick.entity.id ?? ''),
        label: pointerLabel(pick.entity.label || pick.entity.id),
        kind: String(pick.entity.kind || 'feature'),
      }
    : null;
  const entityLat = finite(pick?.entity?.lat);
  const entityLon = finite(pick?.entity?.lon);
  const groundLat = finite(pick?.ground?.lat);
  const groundLon = finite(pick?.ground?.lon);
  const hasEntityPosition = entityLat !== null && entityLon !== null;
  const hasGround = groundLat !== null && groundLon !== null;
  const lat = hasEntityPosition ? entityLat : hasGround ? groundLat : null;
  const lon = hasEntityPosition ? entityLon : hasGround ? groundLon : null;
  const target = entity ? 'entity' : hasGround ? 'ground' : 'sky';
  return {
    fresh: target !== 'sky',
    at,
    capturedAt,
    cameraKey,
    target,
    entity,
    lat: lat === null ? null : round(lat, 5),
    lon: lon === null ? null : round(lon, 5),
    heightM: finite(pick?.ground?.heightM),
    radiusKm: finite(pick?.radiusKm),
    screen: {
      x: width ? round(x / width, 3) : null,
      y: height ? round(y / height, 3) : null,
    },
    screenPx: { x: Math.round(x), y: Math.round(y) },
  };
}

/**
 * Compact, inert context item for the model (about 60–100 tokens). Labels are
 * JSON data, never prose, so a callsign or place name cannot carry an
 * instruction.
 * @param {object|null} snapshot
 * @returns {object|null} Item, or null for a stale snapshot.
 */
export function pointerContextItem(snapshot) {
  if (!snapshot?.fresh) return null;
  const item = { type: 'pointer_context', at: snapshot.at };
  if (snapshot.entity) {
    item.target = {
      kind: snapshot.entity.kind,
      layer: snapshot.entity.layerId,
      label: snapshot.entity.label,
    };
  }
  if (snapshot.lat !== null && snapshot.lon !== null) {
    item.ground = { lat: round(snapshot.lat, 4), lon: round(snapshot.lon, 4) };
  }
  if (snapshot.screen?.x !== null) item.screen = snapshot.screen;
  return item;
}

/** {@link pointerContextItem} serialized; null for a stale snapshot. */
export function formatPointerContext(snapshot) {
  const item = pointerContextItem(snapshot);
  return item ? JSON.stringify(item) : null;
}

/**
 * What the voice card shows "this" resolved to.
 * @param {object|null} snapshot
 * @returns {{kind: 'this'|'here', label: string}|null}
 */
export function pointerChip(snapshot) {
  if (!snapshot?.fresh) return null;
  if (snapshot.entity)
    return { kind: 'this', label: pointerLabel(snapshot.entity.label, 32) };
  if (snapshot.lat === null || snapshot.lon === null) return null;
  return {
    kind: 'here',
    label: `${snapshot.lat.toFixed(2)}, ${snapshot.lon.toFixed(2)}`,
  };
}

/**
 * Track the pointer over one element (the globe canvas).
 * @param {object} options
 * @param {HTMLElement} options.element Canvas to observe.
 * @param {(x: number, y: number) => object|null} options.pick Lazy pick at
 *   element-relative CSS pixels: `{entity?, ground?, radiusKm?}`.
 * @param {() => number} [options.now] Monotonic clock (ms).
 * @param {() => string|null} [options.cameraKey] Camera identity; a dwell
 *   pick taken under another camera pose is never reused.
 * @param {Function} [options.setTimer]
 * @param {Function} [options.clearTimer]
 */
export function createPointerTracker({
  element,
  pick,
  now = () => performance.now(),
  cameraKey = () => null,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
}) {
  let inside = false;
  let x = 0;
  let y = 0;
  let lastMoveAt = -Infinity;
  let anchor = null;
  let dwell = null;
  let dwellTimer = null;
  let held = null;
  let active = null;
  let destroyed = false;
  const listeners = new AbortController();

  function size() {
    return {
      width: element?.clientWidth || element?.width || 0,
      height: element?.clientHeight || element?.height || 0,
    };
  }

  function safePick(px, py) {
    try {
      return pick?.(px, py) || null;
    } catch {
      return null;
    }
  }

  function cancelDwell() {
    if (dwellTimer === null) return;
    clearTimer(dwellTimer);
    dwellTimer = null;
  }

  function moveTo(px, py) {
    inside = true;
    x = px;
    y = py;
    lastMoveAt = now();
    if (anchor && Math.hypot(px - anchor.x, py - anchor.y) < POINTER_DWELL_PX)
      return;
    anchor = { x: px, y: py };
    dwell = null;
    cancelDwell();
    dwellTimer = setTimer(() => {
      dwellTimer = null;
      if (destroyed || !inside || !anchor) return;
      dwell = { x, y, at: now(), camera: cameraKey(), pick: safePick(x, y) };
    }, POINTER_DWELL_MS);
  }

  function onMove(event) {
    const rect = element.getBoundingClientRect?.() || { left: 0, top: 0 };
    moveTo(event.clientX - rect.left, event.clientY - rect.top);
  }

  function onLeave() {
    inside = false;
    anchor = null;
    dwell = null;
    cancelDwell();
  }

  if (element?.addEventListener) {
    const options = { passive: true, signal: listeners.signal };
    element.addEventListener('pointermove', onMove, options);
    element.addEventListener('pointerdown', onMove, options);
    element.addEventListener('pointerleave', onLeave, options);
  }

  /** Is the pointer a referent right now? */
  function isFresh(recentMs = POINTER_FRESH_MS) {
    if (destroyed || !inside) return false;
    if (now() - lastMoveAt > Math.min(recentMs, POINTER_FRESH_MS)) return false;
    const { width, height } = size();
    if (!width || !height) return false;
    return (
      x >= POINTER_EDGE_PX &&
      y >= POINTER_EDGE_PX &&
      x <= width - POINTER_EDGE_PX &&
      y <= height - POINTER_EDGE_PX
    );
  }

  function capture(at, { recentMs = POINTER_FRESH_MS } = {}) {
    if (!isFresh(recentMs)) return { fresh: false, at };
    const { width, height } = size();
    const reuse =
      dwell &&
      dwell.x === x &&
      dwell.y === y &&
      dwell.pick &&
      now() - dwell.at <= POINTER_DWELL_REUSE_MS &&
      dwell.camera === cameraKey()
        ? dwell.pick
        : null;
    return buildPointerSnapshot({
      at,
      x,
      y,
      width,
      height,
      pick: reuse || safePick(x, y),
    });
  }

  return {
    element,
    capture,
    isFresh,
    /** Push-to-talk keydown: snapshot now, keep it for the hold. */
    hold(at = 'keydown') {
      held = { snapshot: capture(at), heldAt: now() };
      return held.snapshot;
    },
    /** The Space gesture ended (tap, release or blur): its snapshot goes too. */
    releaseHold() {
      held = null;
    },
    /** Is a push-to-talk keydown snapshot held for the current gesture? */
    isHeld() {
      return Boolean(held && now() - held.heldAt <= POINTER_HOLD_MS);
    },
    /**
     * Start a user turn. Spoken turns inside a Space hold reuse its keydown
     * snapshot; typed turns and open-mic speech always read the pointer now
     * (open mic only when it moved recently: `recentMs`). The result becomes
     * the turn's referent (null when stale).
     */
    beginTurn(at, { recentMs = POINTER_FRESH_MS } = {}) {
      const reuse =
        at !== 'text' && held && now() - held.heldAt <= POINTER_HOLD_MS;
      const snapshot = reuse ? held.snapshot : capture(at, { recentMs });
      if (!reuse && at !== 'text') held = null;
      active = snapshot?.fresh ? snapshot : null;
      return snapshot;
    },
    /** The current turn's referent, or null. */
    activeSnapshot() {
      return active;
    },
    /** Test and harness hook: place the pointer at element pixels. */
    moveTo(px, py) {
      if (!destroyed) moveTo(Number(px), Number(py));
    },
    /**
     * Session end: forget every snapshot. A Space hold that is starting the
     * next session keeps its keydown snapshot.
     */
    clear({ keepHold = false } = {}) {
      if (!keepHold) held = null;
      active = null;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelDwell();
      listeners.abort();
      held = null;
      active = null;
    },
  };
}
