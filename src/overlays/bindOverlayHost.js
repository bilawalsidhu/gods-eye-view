/** Resolve a retained model's overlay calls against its current attachment. */
export function bindOverlayHost(host, getEngine) {
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
