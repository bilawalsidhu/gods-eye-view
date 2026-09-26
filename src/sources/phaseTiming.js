/** Optional development phase measurements; no provider payloads or credentials. */
export function phaseTiming(phase, start, detail = {}) {
  if (import.meta.env?.DEV)
    performance.measure(`roads:${phase}`, {
      start,
      end: performance.now(),
      detail,
    });
}
