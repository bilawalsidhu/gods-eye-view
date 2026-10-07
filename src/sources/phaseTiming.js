/** Optional development phase measurements; no provider payloads or credentials. */
export function phaseTiming(phase, start, detail = {}, scope = 'roads') {
  if (import.meta.env?.DEV)
    performance.measure(`${scope}:${phase}`, {
      start,
      end: performance.now(),
      detail,
    });
}
