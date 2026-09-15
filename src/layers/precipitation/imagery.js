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
 * switch. This stack therefore appends and removes strictly what it added, so
 * neither owner can evict the other's layers.
 *
 * It stays keyed by tier even though one tier is drawn today. What that buys is
 * not speculative generality but the co-tenancy rule above: ownership has to be
 * per-handle for the two writers to coexist safely.
 */
export function createImageryStack() {
  const owned = new Map();

  const detach = (viewer, tierId) => {
    const layer = owned.get(tierId);
    if (!layer) return false;
    owned.delete(tierId);
    viewer?.imageryLayers?.remove(layer, true);
    return true;
  };

  return {
    /** Swap a tier to a new frame, leaving anything else in the scene alone. */
    apply(viewer, tier) {
      const provider = new Cesium.UrlTemplateImageryProvider(
        tierImageryOptions(tier),
      );
      const next = new Cesium.ImageryLayer(provider, tierLayerOptions(tier));
      // Add before removing so the live layer never blinks through to the base
      // map. Appending also keeps the base map at index 0 where its owner
      // expects it.
      viewer.imageryLayers.add(next);
      detach(viewer, tier.id);
      owned.set(tier.id, next);
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
