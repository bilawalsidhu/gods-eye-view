/** The standalone tool catalog for voice, loaded the first time voice needs it. */

let pending = null;

export function loadToolCatalog() {
  pending ??= Promise.all([
    import('../tools/index.js'),
    import('../tools/services.js'),
  ]).then(
    ([
      { composeCatalog, coreTools, catalogForSurface },
      { createToolServices },
    ]) =>
      catalogForSurface(
        composeCatalog({
          tools: coreTools,
          services: createToolServices({
            fetchImpl: (...args) => globalThis.fetch(...args),
            appUrl: new URL(globalThis.document.baseURI).origin,
          }),
        }),
        'voice',
      ),
  );
  pending.catch(() => {
    pending = null;
  });
  return pending;
}
