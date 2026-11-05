// Identity and attachment counters for the page session, read by the switch
// acceptance scripts (scripts/qa-app-once.mjs, qa-voice-engine-switch.mjs):
// an engine switch keeps every session object and only re-attaches the parts
// bound to an engine, so each id below stays the same across switches.

const ids = new WeakMap();
let nextId = 0;

/**
 * A small number naming one object for this page: the same object always
 * reads the same id, a different object a different one. Null for values
 * that are not objects.
 * @param {unknown} value
 * @returns {number|null}
 */
export function instanceId(value) {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  )
    return null;
  let id = ids.get(value);
  if (id === undefined) {
    id = ++nextId;
    ids.set(value, id);
  }
  return id;
}

/**
 * The page's diagnostic handle (`window.__gevSession`).
 * `read()` returns the session objects by name; `ids` maps each name to its
 * {@link instanceId}. `count(name)` bumps a counter such as `attachments`.
 * @param {() => Record<string, unknown>} read
 */
export function createSessionDiagnostics(read) {
  const counters = {
    applications: 0,
    attachments: 0,
    detaches: 0,
    rollbacks: 0,
  };
  return Object.freeze({
    get ids() {
      return Object.fromEntries(
        Object.entries(read() ?? {}).map(([name, value]) => [
          name,
          instanceId(value),
        ]),
      );
    },
    get counters() {
      return { ...counters };
    },
    get attachments() {
      return counters.attachments;
    },
    get detaches() {
      return counters.detaches;
    },
    count(name) {
      counters[name] = (counters[name] ?? 0) + 1;
      return counters[name];
    },
  });
}
