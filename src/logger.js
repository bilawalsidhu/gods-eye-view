/**
 * gevLogger — level-gated logging with a bounded in-memory ring buffer.
 *
 * The codebase has ~860 `console.*` call sites; migrating them wholesale is
 * neither safe nor useful (PLAN.md Batch 4d). This module gives hot-path
 * modules a single surface to migrate to, one module at a time.
 *
 *  - LEVEL GATE: the console only sees calls at or above the active level.
 *    The default is `debug` (log everything) so migrated call sites keep
 *    their shipped behavior — including the boot-verification `console.log`
 *    lines the QA harnesses assert on. Operators quiet a noisy build with
 *    `?log=warn` (or `window.__godsEyeView.logger.setLogLevel()`).
 *  - RING BUFFER: the most recent LOG_RING_CAPACITY entries are retained
 *    regardless of the console gate, so a session's history survives for
 *    diagnosis (`drainLogBuffer()`); the voice debug-log pipeline records its
 *    structured events here too (`recordDebugEvent`).
 *
 * Web-primitives only (no `node:*`), so the module also runs in workers.
 */

export const LOG_LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
});

/** Bounded history: 500 entries covers a long QA session without growing. */
export const LOG_RING_CAPACITY = 500;

/**
 * Parse a level name; case-insensitive, unknown names are rejected so a typo
 * can never silently silence the console.
 * @param {string} raw - Untrusted level name, e.g. `?log=warn` value or a
 *   persisted preference.
 * @returns {string|null} One of the LOG_LEVELS keys, or null.
 */
export function parseLogLevelName(raw) {
  const name = String(raw || '').trim().toLowerCase();
  return Object.hasOwn(LOG_LEVELS, name) ? name : null;
}

/**
 * Resolve the startup level: `?log=<level>` wins, else log everything.
 * @param {string} [search] A `location.search`-shaped query string.
 * @returns {string} Requested level, else `'debug'`.
 */
export function initialLogLevel(search = typeof location !== 'undefined' ? location.search : '') {
  try {
    const requested = parseLogLevelName(new URLSearchParams(search).get('log'));
    if (requested) return requested;
  } catch { /* non-browser context — keep the default */ }
  return 'debug';
}

let _level = initialLogLevel();
/** @type {object[]} */
let _ring = [];

/** @returns {string} The active console gate. */
export function getLogLevel() {
  return _level;
}

/**
 * Set the console gate. Unknown names throw rather than guess.
 * @param {string} level One of the LOG_LEVELS keys.
 */
export function setLogLevel(level) {
  const name = parseLogLevelName(level);
  if (!name) throw new Error(`Unknown log level: ${level}`);
  _level = name;
}

/**
 * Newest-last snapshot of the retained history.
 * @returns {object[]} Copy of the ring buffer entries; callers may mutate it
 *   without corrupting the live buffer.
 */
export function peekLogBuffer() {
  return _ring.slice();
}

/**
 * Hand the history to a diagnostic sink and start a fresh buffer.
 * @returns {object[]} All retained entries in insertion order; the buffer is
 *   emptied as a side effect.
 */
export function drainLogBuffer() {
  const drained = _ring;
  _ring = [];
  return drained;
}

/**
 * Record one structured event from the voice debug-log pipeline into the ring
 * buffer. The payload is already sanitized by the caller; nothing is posted
 * from here — the console gate does not apply (the pipeline owns its transport).
 * @param {string} event Structured event name (e.g. 'session.starting').
 * @param {object} record The sanitized debug-log record.
 */
export function recordDebugEvent(event, record) {
  _ring.push({
    timestamp: record?.timestamp || new Date().toISOString(),
    level: 'debug',
    namespace: 'GEV:voice-debug',
    text: `event=${event}`,
    detail: record,
  });
  if (_ring.length > LOG_RING_CAPACITY) _ring.splice(0, _ring.length - LOG_RING_CAPACITY);
}

/**
 * Render a non-string detail compactly; a broken render must never break the
 * caller (logging is a diagnostics path, not an application path).
 * @param {*} part - Any value from a log call's variadic tail.
 * @returns {string} JSON for plain objects, the stack for `Error`s, and
 *   `String(part)` when JSON serialization throws (circular structures).
 */
function renderDetail(part) {
  if (part instanceof Error) return part.stack || `${part.name}: ${part.message}`;
  try {
    return JSON.stringify(part);
  } catch {
    return String(part);
  }
}

/**
 * Single funnel for the `log*` wrappers: gate the console write, then append
 * the flattened line to the ring buffer regardless of the gate.
 * @param {string} level - One of the LOG_LEVELS keys below `silent`.
 * @param {string} namespace - Module-owned prefix rendered as `[namespace]`.
 * @param {Array<*>} parts - Variadic tail; non-strings pass through
 *   {@link renderDetail}.
 */
function emit(level, namespace, parts) {
  const prefix = `[${namespace}]`;
  const [first, ...rest] = parts;
  // `debug` maps onto console.log: today's call sites are console.log, and
  // console.debug hides under browser verbosity filters.
  const method = level === 'debug' ? 'log' : level;
  if (LOG_LEVELS[level] >= LOG_LEVELS[_level]) {
    console[method](first == null ? prefix : `${prefix} ${first}`, ...rest);
  }
  const text = `${prefix} ${[first, ...rest].map((part) => (
    typeof part === 'string' ? part : renderDetail(part)
  )).join(' ')}`;
  _ring.push({
    timestamp: new Date().toISOString(),
    level,
    namespace,
    text,
  });
  if (_ring.length > LOG_RING_CAPACITY) _ring.splice(0, _ring.length - LOG_RING_CAPACITY);
}

/**
 * Debug-level write — the default gate, so it reaches the console today.
 * @param {string} namespace - Module-owned prefix, e.g. 'Data:Flights'.
 * @param {...*} parts - Message fragments joined with spaces in the ring entry.
 */
export function logDebug(namespace, ...parts) {
  emit('debug', namespace, parts);
}

/**
 * Informational write for lifecycle and progress events.
 * @param {string} namespace - Module-owned prefix, e.g. 'Data:Flights'.
 * @param {...*} parts - Message fragments joined with spaces in the ring entry.
 */
export function logInfo(namespace, ...parts) {
  emit('info', namespace, parts);
}

/**
 * Warning write; survives a `?log=warn` quieting.
 * @param {string} namespace - Module-owned prefix, e.g. 'Data:Flights'.
 * @param {...*} parts - Message fragments joined with spaces in the ring entry.
 */
export function logWarn(namespace, ...parts) {
  emit('warn', namespace, parts);
}

/**
 * Error write; the highest non-silent gate, always visible unless silenced.
 * @param {string} namespace - Module-owned prefix, e.g. 'Data:Flights'.
 * @param {...*} parts - Message fragments joined with spaces in the ring entry.
 */
export function logError(namespace, ...parts) {
  emit('error', namespace, parts);
}

/** Test seam: restore the default gate and drop retained history. */
export function resetLoggerForTest() {
  _level = 'debug';
  _ring = [];
}
