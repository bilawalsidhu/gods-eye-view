/** The standalone tool catalog for voice, loaded the first time voice needs it. */

let pending = null;

export function loadToolCatalog() {
  pending ??= Promise.all([
    import('../tools/index.js'),
    import('../tools/services.js'),
    import('../tools/queries/worldmonitor.js'),
    import('../tools/worldmonitorService.js'),
  ]).then(
    ([
      { composeCatalog, coreTools, catalogForSurface },
      { createToolServices },
      { worldMonitorTools },
      { createWorldMonitorService },
    ]) =>
      catalogForSurface(
        composeCatalog({
          tools: [...coreTools, ...worldMonitorTools],
          services: {
            ...createToolServices({
              fetchImpl: (...args) => globalThis.fetch(...args),
              appUrl: new URL(globalThis.document.baseURI).origin,
            }),
            worldmonitor: createWorldMonitorService({
              fetchImpl: (...args) => globalThis.fetch(...args),
            }),
          },
        }),
        'voice',
      ),
  );
  pending.catch(() => {
    pending = null;
  });
  return pending;
}
