import * as Cesium from 'cesium';

/**
 * Cesium options for one tier.
 *
 * The URL is a same-origin template with no time in it: the proxy asks
 * upstream for `current`, so there is no step to pin and nothing here for a
 * frame to change. Refreshing works by building a new layer, which gives
 * Cesium a fresh per-instance tile cache and so re-requests what is on screen.
 */
export function tierImageryOptions(tier) {
  return {
    url: tier.tileUrlTemplate,
    // The vendor serves 256px tiles in Spherical Mercator, which is also
    // Cesium's default scheme; saying so keeps the two from disagreeing.
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    // Nothing in this layer answers a click, so a pick would only be a wasted
    // request.
    enablePickFeatures: false,
    // Past this the service has no more detail and is only upsampling — and
    // every level is a separate set of billable tiles. Cesium magnifies past
    // it for free.
    maximumLevel: tier.maxTileLevel,
  };
  // No per-provider Cesium.Credit here on purpose. One would land in the
  // display's *dynamic* frame credits, while the attribution gate reads
  // `creditDisplay._staticCredits` — so a credit attached here would look like
  // attribution while failing the check. The source is credited through
  // DATA_CREDITS instead.
}

/** Layer options for a tier. */
export function tierLayerOptions(tier) {
  // Alpha must stay a plain number. Cesium's type definition still advertises a
  // per-tile function, but the globe shader assigns the value straight into a
  // float uniform (`uniforms.imageryTextureAlpha[i] = imageryLayer.alpha`), so a
  // function silently corrupts the uniform and renders the whole globe black.
  return { alpha: tier.alpha };
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
  /** Rung per owned tier, so ordering survives without re-reading the table. */
  const rungs = new Map();

  const detach = (viewer, tierId) => {
    const layer = owned.get(tierId);
    if (!layer) return false;
    owned.delete(tierId);
    rungs.delete(tierId);
    viewer?.imageryLayers?.remove(layer, true);
    return true;
  };

  /**
   * Where this tier belongs in the collection right now.
   *
   * Tiers refresh independently, so a slow one re-applying must not land on top
   * of a faster one that happened to refresh more recently: Cesium's `add` puts
   * a layer above everything when no index is given. Sit directly beneath the
   * lowest-placed owned tier that outranks this one, and read the live
   * collection rather than a remembered index so the position survives the map
   * controller swapping the base map underneath us.
   *
   * With continuous fields at a low rung and sparse overlays above them, this
   * is what stops an hourly temperature field from burying the lightning drawn
   * over it until the next lightning tick.
   */
  const insertIndexFor = (viewer, tier) => {
    const layers = viewer.imageryLayers;
    let index = layers.length;
    for (const [tierId, layer] of owned) {
      if (tierId === tier.id) continue;
      if ((rungs.get(tierId) ?? 0) <= tier.rung) continue;
      const at = layers.indexOf(layer);
      if (at >= 0 && at < index) index = at;
    }
    return index;
  };

  return {
    /** Swap a tier to a new frame, leaving anything else in the scene alone. */
    apply(viewer, tier) {
      const provider = new Cesium.UrlTemplateImageryProvider(
        tierImageryOptions(tier),
      );
      const next = new Cesium.ImageryLayer(provider, tierLayerOptions(tier));
      // Add before removing so the live layer never blinks through to the base
      // map. Inserting at the tier's rung — rather than appending — keeps the
      // base map at index 0 and the paint order independent of refresh order.
      viewer.imageryLayers.add(next, insertIndexFor(viewer, tier));
      detach(viewer, tier.id);
      owned.set(tier.id, next);
      rungs.set(tier.id, tier.rung);
      return next;
    },
    remove: detach,
    /** Drop every owned handle; safe to call before init and after destroy. */
    clear(viewer) {
      for (const tierId of [...owned.keys()]) detach(viewer, tierId);
    },
    has(tierId) {
      return owned.has(tierId);
    },
    ownedIds() {
      return [...owned.keys()];
    },
    /** Live collection index of an owned tier, for ordering assertions. */
    indexOf(viewer, tierId) {
      const layer = owned.get(tierId);
      return layer ? viewer.imageryLayers.indexOf(layer) : -1;
    },
    get size() {
      return owned.size;
    },
  };
}
