/** The standalone tool catalog for voice, loaded the first time voice needs it. */

let pending = null;

/** Load voice queries and the internal aircraft lookup on the same providers. */
export function loadToolCatalog() {
  pending ??= Promise.all([
    import('../tools/index.js'),
    import('../tools/services.js'),
  ]).then(
    ([
      { composeCatalog, coreTools, catalogForSurface },
      { createToolServices },
    ]) =>
      voiceCatalog(
        composeCatalog({
          tools: coreTools,
          services: createToolServices({
            fetchImpl: (...args) => globalThis.fetch(...args),
            appUrl: new URL(globalThis.document.baseURI).origin,
          }),
        }),
        catalogForSurface,
      ),
  );
  pending.catch(() => {
    pending = null;
  });
  return pending;
}

// Keep the internal feed operation out of the model-facing tool list/schema.
function voiceCatalog(catalog, surface) {
  return Object.freeze({
    ...surface(catalog, 'voice'),
    lookupAircraft: (args, options) =>
      catalog.call('find_aircraft', args, options),
  });
}
