/** Resolve a retained model's overlay calls against its current attachment. */
export function bindOverlayHost(host, getEngine) {
  if (typeof host === 'function') {
    return new Proxy(
      {},
      {
        get:
          (_target, name) =>
          (...args) =>
            host(getEngine())?.[name]?.(...args),
      },
    );
  }
  if (!host?.forEngine) return host;
  return Object.fromEntries(
    Object.entries(host)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => [
        name,
        (...args) => host.forEngine(getEngine())?.[name]?.(...args),
      ]),
  );
}
