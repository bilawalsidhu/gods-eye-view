const CONTROL_LAYER_IDS = Object.freeze({
  trafficLayer: 'traffic',
  flightsLayer: 'flights',
  militaryFlightsLayer: 'military',
  satellitesLayer: 'satellites',
  cctvLayer: 'cctv',
  streetLevelLayer: 'street-level',
  wildlifeSightingsLayer: 'wildlife-sightings',
  radioLayer: 'radio',
  bikeshareLayer: 'bikeshare',
  transitLayer: 'transit',
  aisLiveVesselsLayer: 'ais-live-vessels',
  militaryAwarenessLayer: 'military-awareness',
  militaryInstallationsLayer: 'military-installations',
  rocketLaunchesLayer: 'rocket-launches',
  localAdsbLayer: 'local-adsb',
});

/** Capture the ordered application instances and their serialization metadata. */
export function createLayerCatalog(layers, metadata) {
  if (!Array.isArray(layers) || !Array.isArray(metadata))
    throw new TypeError(
      'Layer instances and serialization metadata are required',
    );
  const byId = new Map();
  for (const layer of layers) {
    if (typeof layer?.id !== 'string' || !layer.id || byId.has(layer.id))
      throw new TypeError(`Invalid or duplicate catalog layer: ${layer?.id}`);
    byId.set(layer.id, layer);
  }
  const ids = new Set();
  for (const entry of metadata) {
    if (!byId.has(entry?.id) || ids.has(entry.id))
      throw new TypeError(
        `Unmatched or duplicate catalog metadata: ${entry?.id}`,
      );
    ids.add(entry.id);
  }
  if (ids.size !== byId.size)
    throw new TypeError('Catalog metadata is incomplete');
  return Object.freeze({
    layers: Object.freeze([...layers]),
    metadata: Object.freeze(
      metadata.map((entry) => Object.freeze({ ...entry })),
    ),
    get: (id) => byId.get(id),
  });
}

/**
 * Bind the current control surface to the exact instances registered by the
 * app. A layer the catalog leaves out on purpose (another engine's: in
 * `catalog.unavailableMetadata`) gets an empty stand-in, so the shell's
 * optional calls (`layer.method?.()`) do nothing; any other missing layer is
 * a wiring error.
 */
export function catalogControlServices(catalog) {
  if (!catalog?.get)
    throw new TypeError('An application layer catalog is required');
  const omitted = new Set(
    (catalog.unavailableMetadata ?? []).map(({ id }) => id),
  );
  return Object.fromEntries(
    Object.entries(CONTROL_LAYER_IDS).map(([role, id]) => {
      const layer = catalog.get(id);
      if (layer) return [role, layer];
      if (omitted.has(id)) return [role, {}];
      throw new TypeError(`Control layer missing from catalog: ${id}`);
    }),
  );
}
