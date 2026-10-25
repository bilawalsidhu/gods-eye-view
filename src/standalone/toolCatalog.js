/** The standalone tool catalog for voice, loaded the first time voice needs it. */

let pending = null;

/** `worldMonitor` adds the World Monitor tools, for a configured local backend. */
export function loadToolCatalog({ worldMonitor = false } = {}) {
  pending ??= Promise.all([
    import('../tools/index.js'),
    import('../tools/services.js'),
    worldMonitor ? import('../tools/queries/worldmonitor.js') : null,
    worldMonitor ? import('../tools/worldmonitorService.js') : null,
  ]).then(
    ([
      { composeCatalog, coreTools, catalogForSurface },
      { createToolServices },
      queries,
      service,
    ]) => {
      const fetchImpl = (...args) => globalThis.fetch(...args);
      const services = createToolServices({
        fetchImpl,
        appUrl: new URL(globalThis.document.baseURI).origin,
      });
      return catalogForSurface(
        composeCatalog({
          tools: queries
            ? [...coreTools, ...queries.worldMonitorTools]
            : coreTools,
          services: service
            ? {
                ...services,
                worldmonitor: service.createWorldMonitorService({ fetchImpl }),
              }
            : services,
        }),
        'voice',
      );
    },
  );
  pending.catch(() => {
    pending = null;
  });
  return pending;
}
