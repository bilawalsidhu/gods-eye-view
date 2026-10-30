/** Optional development phase measurements; no provider payloads or credentials. */
export function phaseTiming(phase, start, detail = {}, scope = 'roads') {
  if (import.meta.env?.DEV)
    performance.measure(`${scope}:${phase}`, {
      start,
      end: performance.now(),
      detail,
    });
}

/** Bounded development evidence for one physical outline installation. */
export function createWorkTrace() {
  if (!import.meta.env?.DEV) return null;
  try {
    return {
      timeOrigin: performance.timeOrigin,
      slices: [],
      dropped: 0,
      probes: 0,
      samplerStart: null,
      samplerStatus: null,
      rendererStatus: null,
      status: 'pending',
      completedAt: null,
    };
  } catch {
    return null;
  }
}

/** Never let optional diagnostic recording change an installation outcome. */
export function recordWorkSlice(trace, phase, start, end, detail) {
  if (!trace) return;
  try {
    if (trace.slices.length >= 16) {
      trace.dropped += 1;
      return;
    }
    trace.slices.push({
      phase,
      start,
      end: end ?? performance.now(),
      ...(detail === undefined ? {} : { detail }),
    });
  } catch {
    try {
      trace.dropped += 1;
    } catch {
      // Missing or incomplete evidence fails the measurement, not the product.
    }
  }
}
