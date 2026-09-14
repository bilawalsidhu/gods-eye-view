import * as Cesium from 'cesium';

/**
 * Cesium options for one tier's frame.
 *
 * `TIME` is pinned to the step the service itself reported rather than composed
 * from the clock: GeoMet declares `nearestValue="0"` and will not snap, and
 * pinning also stops a pan across an hour boundary from compositing two
 * observation times into one view.
 */
export function tierImageryOptions(tier, frame) {
  const options = {
    url: tier.service,
    layers: tier.wmsLayer,
    parameters: {
      // WMS 1.3.0 so Cesium emits CRS; 1.1.1 would send SRS and, on 4326,
      // silently transpose the axes.
      version: '1.3.0',
      format: 'image/png',
      transparent: true,
      // Empty string is the server's default style.
      styles: tier.wmsStyle || '',
    },
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    // Nothing in this layer answers a click, and ten WMS layers would otherwise
    // be ten GetFeatureInfo requests per pick.
    enablePickFeatures: false,
    // Past this the service answers with empty tiles; let Cesium upsample the
    // deepest real level instead of caching holes.
    maximumLevel: tier.maxTileLevel,
  };
  // Pin the step only when the service publishes one; an undated service is
  // asked for whatever is current.
  if (frame?.validTime) options.parameters.TIME = frame.validTime;
  // No per-provider Cesium.Credit here on purpose. One would land in the
  // display's *dynamic* frame credits, while the attribution gate reads
  // `creditDisplay._staticCredits` — so a credit attached here would look like
  // attribution while failing the check. Every source is credited through
  // DATA_CREDITS instead.
  return options;
}

/**
 * The rectangles this tier paints, as a cover. `[null]` means the whole globe.
 *
 * A domain that is not one box — a regional model reaching across North
 * America, Europe and the Arctic, or a radar footprint that cannot share a
 * rectangle with the mainland — is expressed as several rectangles rather than
 * approximated by the one box `ImageryLayer` accepts.
 */
export function tierRectangles(tier) {
  const cover = tier.rectanglesDegrees;
  return cover?.length ? cover : [null];
}

/** Layer options for one rectangle of a tier's cover. */
export function tierLayerOptions(tier, rectangleDegrees = null) {
  // Alpha must stay a plain number. Cesium's type definition still advertises a
  // per-tile function, but the globe shader assigns the value straight into a
  // float uniform (`uniforms.imageryTextureAlpha[i] = imageryLayer.alpha`), so a
  // function silently corrupts the uniform and renders the whole globe black.
  const options = { alpha: tier.alpha };
  if (rectangleDegrees)
    options.rectangle = Cesium.Rectangle.fromDegrees(...rectangleDegrees);
  // Step aside exactly where a sharper tier takes over, and nowhere else.
  if (tier.cutoutRectangleDegrees)
    options.cutoutRectangle = Cesium.Rectangle.fromDegrees(
      ...tier.cutoutRectangleDegrees,
    );
  if (Number.isFinite(tier.minimumTerrainLevel))
    options.minimumTerrainLevel = tier.minimumTerrainLevel;
  if (Number.isFinite(tier.maximumTerrainLevel))
    options.maximumTerrainLevel = tier.maximumTerrainLevel;
  return options;
}

/**
 * Own this layer's imagery handles and nothing else.
 *
 * `MapSourceController` is the only other writer to `viewer.imageryLayers`: it
 * keeps the base map at index 0 and removes only its own handle on a stack
 * switch. This stack therefore appends and removes strictly what it added, so
 * neither owner can evict the other's layers.
 */
export function createImageryStack() {
  const owned = new Map();

  const detach = (viewer, tierId) => {
    const entry = owned.get(tierId);
    if (!entry) return false;
    owned.delete(tierId);
    for (const layer of entry.layers)
      viewer?.imageryLayers?.remove(layer, true);
    return true;
  };

  /**
   * Where this tier belongs in the collection right now.
   *
   * Tiers refresh on their own cadences, so a slow tier re-applying must not
   * land on top of a faster one that happens to have refreshed more recently:
   * Cesium's `add` puts a layer above everything when no index is given. Sit
   * directly beneath the lowest-placed owned tier that outranks this one, and
   * read the live collection rather than a remembered index so the position
   * survives the map controller swapping the base map underneath us.
   */
  const insertIndexFor = (viewer, tier) => {
    const layers = viewer.imageryLayers;
    let index = layers.length;
    for (const entry of owned.values()) {
      if (entry.rung <= tier.rung) continue;
      for (const layer of entry.layers) {
        const at = layers.indexOf(layer);
        if (at >= 0 && at < index) index = at;
      }
    }
    return index;
  };

  return {
    /** Swap one tier to a new frame, leaving the other tiers untouched. */
    apply(viewer, tier, frame) {
      // One provider serves the whole cover. Verified against the installed
      // Cesium: `ImageryLayer.destroy` is `destroyObject(this)` and never
      // touches `_imageryProvider`, and `_imageryCache` is a per-instance
      // field — so sharing costs no lifetime tangle and each rectangle still
      // keeps its own tiles.
      const provider = new Cesium.WebMapServiceImageryProvider(
        tierImageryOptions(tier, frame),
      );
      const next = tierRectangles(tier).map(
        (rectangle) =>
          new Cesium.ImageryLayer(provider, tierLayerOptions(tier, rectangle)),
      );
      // Add before removing so a live tier never blinks through the base map.
      const index = insertIndexFor(viewer, tier);
      next.forEach((layer, offset) =>
        viewer.imageryLayers.add(layer, index + offset),
      );
      detach(viewer, tier.id);
      owned.set(tier.id, { layers: next, rung: tier.rung });
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
    /**
     * Lowest live collection index this tier occupies, for ordering assertions.
     * A tier covering several rectangles owns a contiguous run from here.
     */
    indexOf(viewer, tierId) {
      const entry = owned.get(tierId);
      if (!entry) return -1;
      let lowest = -1;
      for (const layer of entry.layers) {
        const at = viewer.imageryLayers.indexOf(layer);
        if (at >= 0 && (lowest < 0 || at < lowest)) lowest = at;
      }
      return lowest;
    },
    /** Tiers placed, not layers: a cover tier still counts once. */
    get size() {
      return owned.size;
    },
  };
}
