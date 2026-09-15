import * as Cesium from 'cesium';

/**
 * Cesium options for one spec.
 *
 * The URL carries no time step — the proxy always asks upstream for `current`
 * — but it does carry a freshness floor. Rebuilding the layer is what makes
 * Cesium re-request the tiles on screen; `notBefore` is what stops the proxy
 * answering every one of those from a cache that outlives the weather. It is
 * the moment the user (or their timer) asked for new data, so a tile cached
 * before then is refetched exactly once and everything cached since is served
 * as it stands.
 *
 * @param {object} spec Layer spec.
 * @param {object} [options]
 * @param {number} [options.notBefore=0] Epoch ms; 0 means "cache as normal".
 * @returns {object} Cesium provider options.
 */
export function imageryOptionsFor(spec, { notBefore = 0 } = {}) {
  return {
    url: notBefore
      ? `${spec.tileUrlTemplate}?t=${notBefore}`
      : spec.tileUrlTemplate,
    // The vendor serves 256px tiles in Spherical Mercator, which is also
    // Cesium's default scheme; saying so keeps the two from disagreeing.
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    // Nothing in this layer answers a click, so a pick would only be a wasted
    // request.
    enablePickFeatures: false,
    // Past this the service has no more detail and is only upsampling — and
    // every level is a separate set of billable tiles. Cesium magnifies past
    // it for free.
    maximumLevel: spec.maxTileLevel,
  };
  // No per-provider Cesium.Credit here on purpose. One would land in the
  // display's *dynamic* frame credits, while the attribution gate reads
  // `creditDisplay._staticCredits` — so a credit attached here would look like
  // attribution while failing the check. The source is credited through
  // DATA_CREDITS instead.
}

/** Layer options for a spec. */
export function layerOptionsFor(spec) {
  // Alpha must stay a plain number. Cesium's type definition still advertises a
  // per-tile function, but the globe shader assigns the value straight into a
  // float uniform (`uniforms.imageryTextureAlpha[i] = imageryLayer.alpha`), so a
  // function silently corrupts the uniform and renders the whole globe black.
  return { alpha: spec.alpha };
}

/**
 * Own this layer's imagery handles and nothing else.
 *
 * `MapSourceController` is the only other writer to `viewer.imageryLayers`: it
 * keeps the base map at index 0 and removes only its own handle on a stack
 * switch. This stack therefore inserts and removes strictly what it added, so
 * neither owner can evict the other's layers.
 */
export function createImageryStack() {
  const owned = new Map();
  /** Rung per owned spec, so ordering survives without re-reading the table. */
  const rungs = new Map();

  const detach = (viewer, specId) => {
    const layer = owned.get(specId);
    if (!layer) return false;
    owned.delete(specId);
    rungs.delete(specId);
    viewer?.imageryLayers?.remove(layer, true);
    return true;
  };

  /**
   * Where this spec belongs in the collection right now.
   *
   * Layers refresh independently, so a slow one re-applying must not land on top
   * of a faster one that happened to refresh more recently: Cesium's `add` puts
   * a layer above everything when no index is given. Sit directly beneath the
   * lowest-placed owned spec that outranks this one, and read the live
   * collection rather than a remembered index so the position survives the map
   * controller swapping the base map underneath us.
   *
   * With continuous fields at a low rung and sparse overlays above them, this
   * is what stops an hourly temperature field from burying the lightning drawn
   * over it until the next lightning tick.
   */
  const insertIndexFor = (viewer, spec) => {
    const layers = viewer.imageryLayers;
    let index = layers.length;
    for (const [specId, layer] of owned) {
      if (specId === spec.id) continue;
      if ((rungs.get(specId) ?? 0) <= spec.rung) continue;
      const at = layers.indexOf(layer);
      if (at >= 0 && at < index) index = at;
    }
    return index;
  };

  return {
    /**
     * Swap a spec to a new layer, leaving anything else in the scene alone.
     * @param {object} viewer Cesium viewer.
     * @param {object} spec Layer spec.
     * @param {object} [options]
     * @param {number} [options.notBefore=0] Freshness floor for its tiles.
     */
    apply(viewer, spec, { notBefore = 0 } = {}) {
      const provider = new Cesium.UrlTemplateImageryProvider(
        imageryOptionsFor(spec, { notBefore }),
      );
      const next = new Cesium.ImageryLayer(provider, layerOptionsFor(spec));
      // Add before removing so the live layer never blinks through to the base
      // map. Inserting at the spec's rung — rather than appending — keeps the
      // base map at index 0 and the paint order independent of refresh order.
      viewer.imageryLayers.add(next, insertIndexFor(viewer, spec));
      detach(viewer, spec.id);
      owned.set(spec.id, next);
      rungs.set(spec.id, spec.rung);
      return next;
    },
    remove: detach,
    /** Drop every owned handle; safe to call before init and after destroy. */
    clear(viewer) {
      for (const specId of [...owned.keys()]) detach(viewer, specId);
    },
    has(specId) {
      return owned.has(specId);
    },
    ownedIds() {
      return [...owned.keys()];
    },
    /** Live collection index of an owned spec, for ordering assertions. */
    indexOf(viewer, specId) {
      const layer = owned.get(specId);
      return layer ? viewer.imageryLayers.indexOf(layer) : -1;
    },
    get size() {
      return owned.size;
    },
  };
}
