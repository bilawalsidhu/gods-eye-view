/**
 * Shared military-aircraft ICAO24 registry (2026-06-10 playtest fix).
 *
 * adsb.lol /v2/mil tags aircraft via its database's military flag; OpenSky
 * carries no such tag, so military aircraft (e.g. ADAPT91/92) appeared in
 * BOTH layers as duplicate icons and tracks. This registry reconciles them:
 *
 *  - The military layer, while enabled, feeds every poll's ICAO set here and
 *    marks itself active — the commercial flights layer then SUPPRESSES its
 *    duplicates (military layer wins icon, track, and click).
 *  - While the military layer is OFF, the flights layer keeps a low-rate
 *    poll (60s against the dev proxy's cached /api/adsblol/mil) so known
 *    military aircraft are still classified and styled amber.
 */

const MIL_POLL_INTERVAL_MS = 60000;

/** @type {Set<string>} Lowercase ICAO24 hexes a `/v2/mil` feed tagged military. */
const _milIcaos = new Set();
/**
 * @type {Set<string>} Lowercase ICAO24 hexes classified military by the local
 * heuristics below (hex allocation, type designator, callsign) rather than by a
 * feed. These are STYLED military (amber tint, analyst flag) but never trigger
 * the dedicated military layer's duplicate-suppression — that layer only knows
 * the feed set, so suppressing a heuristic hex would erase the aircraft.
 */
const _milHeuristicIcaos = new Set();

/**
 * ICAO 24-bit address blocks allocated to military operators — the same set the
 * readsb / tar1090 "military" db-flag uses. Inclusive `[lo, hi]` integer pairs.
 * Extend freely; a wrong range only mis-tints an aircraft amber.
 */
const MIL_HEX_RANGES = [
  [0xadf7c8, 0xafffff], // United States
  [0x010070, 0x01008f], // Egypt
  [0x0a4000, 0x0a4fff], // Algeria
  [0x33ff00, 0x33ffff], // Italy
  [0x350000, 0x37ffff], // Spain
  [0x3aa000, 0x3affff], // France
  [0x3b7000, 0x3bffff], // France
  [0x3ea000, 0x3ebfff], // Germany
  [0x3f4000, 0x3fbfff], // Germany
  [0x400000, 0x40003f], // United Kingdom
  [0x43c000, 0x43cfff], // United Kingdom
  [0x444000, 0x446fff], // Belgium / NATO pool
  [0x44f000, 0x44ffff], // Belgium
  [0x457000, 0x457fff], // Bulgaria
  [0x45f400, 0x45f4ff], // Denmark
  [0x468000, 0x4683ff], // Greece
  [0x473c00, 0x473c0f], // Hungary
  [0x478100, 0x4781ff], // Norway
  [0x480000, 0x480fff], // Netherlands
  [0x48d800, 0x48d87f], // Poland
  [0x497c00, 0x497cff], // Portugal
  [0x498420, 0x49842f], // Czech Republic
  [0x4b7000, 0x4b7fff], // Switzerland
  [0x4b8200, 0x4b82ff], // Turkey
  [0x506f00, 0x506fff], // Slovenia
  [0x70c070, 0x70c07f], // Oman
  [0x710258, 0x71028f], // Saudi Arabia
  [0x710380, 0x71039f], // Saudi Arabia
  [0x738a00, 0x738aff], // Israel
  [0x7cf800, 0x7cfaff], // Australia
  [0x800200, 0x8002ff], // India
  [0xc20000, 0xc3ffff], // Canada
  [0xe40000, 0xe41fff], // Brazil
];

/**
 * ICAO aircraft type designators that are military-only — a match is decisive.
 * Deliberately excludes types flown by both (business jets: GLF*, CL60, C56X,
 * F2TH, LJ-series; airliner-derived platforms without a distinct designator).
 */
const MIL_TYPE_CODES = new Set([
  // Transport / tanker
  'C5', 'C5M', 'C17', 'C130', 'C30J', 'C160', 'A400',
  'KC10', 'KC30', 'K35E', 'K35R', 'KC135', 'KC46', 'KC767', 'A332', 'VMI',
  'C295', 'CN35', 'SB05', 'C27J', 'C27',
  // ISR / command
  'E3TF', 'E3CF', 'E3SG', 'E3', 'E4', 'E6', 'E8', 'E2', 'RC135', 'R135',
  'P8', 'P3', 'U2', 'RQ4', 'MQ4', 'MQ9', 'RQ1', 'A339',
  // Fighters / attack
  'F16', 'F15', 'F18', 'FA18', 'F22', 'F35', 'F14', 'F5', 'F4', 'A10', 'AV8B',
  'EA18', 'E18', 'TOR', 'TORN', 'GR4', 'EUFI', 'TYP', 'RFAL', 'MIG', 'SU25',
  'SU27', 'SU30', 'SU34', 'JF17', 'J10', 'GRIP', 'JAS39', 'F1', 'MIR2', 'M2000',
  // Bombers
  'B52', 'B1', 'B2', 'B21', 'TU95', 'TU22', 'TU160',
  // Trainers
  'T38', 'T6', 'TEX2', 'T6A', 'T6B', 'T6C', 'T45', 'HAWK', 'PC21', 'PC9', 'PC7',
  'T1', 'T2', 'M346', 'JPTS', 'T7',
  // Rotary
  'UH60', 'H60', 'S70', 'CH47', 'H47', 'CH53', 'H53', 'V22', 'MV22', 'CV22',
  'AH64', 'H64', 'UH1', 'H1', 'AH1', 'H1Y', 'AC13', 'H500M',
]);

/**
 * Callsign prefixes tied to a specific military / state air arm. Kept tight —
 * every entry here should be unambiguous (no civil airline shares it).
 */
const MIL_CALLSIGN_PREFIXES = [
  'RCH',   // Reach — US Air Mobility Command
  'PAT',   // Priority Air Transport — US Army
  'SPAR',  // US Air Force VIP airlift
  'CNV',   // Convoy — US Navy
  'CFC',   // Canadian Forces
  'RRR',   // Ascot — Royal Air Force
  'GAF',   // German Air Force
  'CTM',   // French Air Force (Cotam)
  'IAM',   // Italian Air Force
  'HUAF',  // Hungarian Air Force
  'POAF',  // Portuguese Air Force
  'GRZLY', // US Air Force tanker
];
/** @type {boolean} True while the dedicated military layer is enabled. */
let _militaryLayerActive = false;
/** @type {Set<(active: boolean) => void>} Fired on active-state TRANSITIONS. */
const _activeChangeListeners = new Set();
/** @type {number} Epoch ms of the last registry refresh (any source). */
let _lastRefreshMs = 0;
/** @type {boolean} A self-poll fetch is in flight. */
let _polling = false;

/**
 * True when the dedicated military layer currently renders these aircraft
 * (the flights layer should suppress duplicates rather than restyle them).
 * @returns {boolean}
 */
export function isMilitaryLayerActive() {
  return _militaryLayerActive;
}

/**
 * Marks the dedicated military layer enabled/disabled. On a TRANSITION
 * (value actually changed) the registered change listeners fire so the
 * flights layer can reconcile its duplicates immediately instead of waiting
 * out its 30 s poll (pre-ship audit M2).
 * @param {boolean} active - Whether the military layer renders.
 * @returns {void}
 */
export function setMilitaryLayerActive(active) {
  const next = !!active;
  if (next === _militaryLayerActive) return;
  _militaryLayerActive = next;
  for (const listener of _activeChangeListeners) {
    try {
      listener(next);
    } catch {
      // a broken listener must never break the layer toggle
    }
  }
}

/**
 * Subscribes to military-layer active-state transitions (fired only when the
 * value changes, AFTER the new state is committed).
 * @param {(active: boolean) => void} listener - Change callback.
 * @returns {() => void} Unsubscribe function.
 */
export function onMilitaryLayerActiveChange(listener) {
  if (typeof listener !== 'function') return () => {};
  _activeChangeListeners.add(listener);
  return () => _activeChangeListeners.delete(listener);
}

/**
 * Replaces/extends the known-military set from a fresh poll.
 * Adds only — transient dropouts from one poll must not declassify an
 * aircraft mid-session (the set stays small: a few hundred hexes).
 * @param {Iterable<string>} icaos - ICAO24 hexes from a /v2/mil response.
 * @returns {void}
 */
export function registerMilitaryIcaos(icaos) {
  for (const icao of icaos || []) {
    const hex = String(icao || '').trim().toLowerCase();
    if (hex) _milIcaos.add(hex);
  }
  _lastRefreshMs = Date.now();
}

/**
 * Whether an aircraft should be PRESENTED as military — a `/v2/mil` feed tagged
 * it, or a local heuristic did. Drives amber tint and the analyst flag.
 * @param {string} icao24 - ICAO24 hex (any case).
 * @returns {boolean}
 */
export function isMilitaryIcao(icao24) {
  const hex = String(icao24 || '').toLowerCase();
  return _milIcaos.has(hex) || _milHeuristicIcaos.has(hex);
}

/**
 * Whether a `/v2/mil` feed tagged this aircraft military. Only feed-confirmed
 * hexes drive the dedicated military layer's duplicate-suppression — a
 * heuristic hex has no counterpart on that layer to hand off to.
 * @param {string} icao24 - ICAO24 hex (any case).
 * @returns {boolean}
 */
export function isFeedMilitaryIcao(icao24) {
  return _milIcaos.has(String(icao24 || '').toLowerCase());
}

/** Parse a 6-hex ICAO24 to an int, or NaN. */
function icaoToInt(icao24) {
  const hex = String(icao24 || '').trim();
  return /^[0-9a-fA-F]{6}$/.test(hex) ? parseInt(hex, 16) : NaN;
}

/** True when the ICAO24 falls in a military-allocated address block. */
export function militaryHexInReservedRange(icao24) {
  const n = icaoToInt(icao24);
  if (!Number.isFinite(n)) return false;
  for (const [lo, hi] of MIL_HEX_RANGES) if (n >= lo && n <= hi) return true;
  return false;
}

/** True when the ICAO type designator is military-only (e.g. `C130`, `F16`). */
export function militaryTypeCode(type) {
  const t = String(type || '').trim().toUpperCase();
  return t.length > 0 && MIL_TYPE_CODES.has(t);
}

/**
 * True when the callsign is `<known prefix><digit>…` — the digit immediately
 * after the prefix is what separates `RCH271` from `PATRIOT1`.
 */
export function militaryCallsignPrefix(callsign) {
  const cs = String(callsign || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!cs) return false;
  return MIL_CALLSIGN_PREFIXES.some((p) => cs.startsWith(p) && /^\d/.test(cs.slice(p.length)));
}

/**
 * Local, feed-independent military classification: hex allocation OR type
 * designator OR callsign prefix. Any one is sufficient.
 * @param {{icao24?: string, type?: string, callsign?: string}} aircraft
 * @returns {boolean}
 */
export function classifyMilitaryHeuristic({ icao24, type, callsign } = {}) {
  return militaryHexInReservedRange(icao24)
    || militaryTypeCode(type)
    || militaryCallsignPrefix(callsign);
}

/**
 * Run the heuristics over one aircraft and, on a match, remember its hex so
 * every downstream `isMilitaryIcao` check agrees. Returns whether this call
 * newly classified the aircraft (already-known hexes return `false`).
 * @param {{icao24?: string, type?: string, callsign?: string}} aircraft
 * @returns {boolean} true only on a first-time classification
 */
export function noteMilitaryCandidate(aircraft = {}) {
  const hex = String(aircraft.icao24 || '').trim().toLowerCase();
  if (!hex || _milIcaos.has(hex) || _milHeuristicIcaos.has(hex)) return false;
  if (!classifyMilitaryHeuristic(aircraft)) return false;
  _milHeuristicIcaos.add(hex);
  return true;
}

/**
 * Refreshes the registry from /api/adsblol/mil when stale — used by the
 * flights layer so classification works while the military layer is off
 * (the military layer's own polls keep it fresh otherwise). The dev proxy
 * caches upstream responses, so this is nearly free.
 * @returns {void} Fire-and-forget; failures leave the current set intact.
 */
export function refreshMilitaryRegistryIfStale() {
  if (_militaryLayerActive) return; // military layer's polls keep us fresh
  if (_polling || (Date.now() - _lastRefreshMs) < MIL_POLL_INTERVAL_MS) return;
  _polling = true;
  (async () => {
    try {
      const response = await fetch('/api/adsblol/mil', { signal: AbortSignal.timeout(10000) });
      if (!response.ok) return;
      const data = await response.json();
      const aircraft = Array.isArray(data?.ac) ? data.ac : [];
      registerMilitaryIcaos(aircraft.map((entry) => entry?.hex));
    } catch {
      // keep the existing set on any failure
    } finally {
      _polling = false;
    }
  })();
}
