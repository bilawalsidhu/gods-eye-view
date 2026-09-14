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
      TIME: frame.validTime,
    },
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
  };
  if (tier.attribution) options.credit = new Cesium.Credit(tier.attribution);
  return options;
}

/**
 * Ramp a bounded tier's alpha down across the outer edge of its footprint so it
 * dissolves into the tier beneath instead of ending on a straight line.
 *
 * Cesium evaluates layer alpha once per tile, not per pixel, so the gradient is
 * quantised to the tile grid. That is coarse when zoomed out and unnoticeable at
 * the zooms where a bounded inlay is actually drawn.
 */
export function edgeFadedAlpha(tier, tilingScheme) {
  const bounds = Cesium.Rectangle.fromDegrees(...tier.rectangleDegrees);
  const margin = Cesium.Math.toRadians(tier.edgeFadeDegrees);
  return (_frameState, _layer, x, y, level) => {
    const tile = tilingScheme.tileXYToRectangle(x, y, level);
    const longitude = (tile.west + tile.east) / 2;
    const latitude = (tile.south + tile.north) / 2;
    const inset = Math.min(
      longitude - bounds.west,
      bounds.east - longitude,
      latitude - bounds.south,
      bounds.north - latitude,
    );
    if (inset <= 0) return 0;
    return tier.alpha * Math.min(1, inset / margin);
  };
}

/** Layer options carrying this tier's place in the precedence stack. */
export function tierLayerOptions(tier) {
  const options = { alpha: tier.alpha };
  if (tier.rectangleDegrees) {
    options.rectangle = Cesium.Rectangle.fromDegrees(...tier.rectangleDegrees);
    if (tier.edgeFadeDegrees > 0)
      options.alpha = edgeFadedAlpha(
        tier,
        new Cesium.WebMercatorTilingScheme(),
      );
  }
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
    const layer = owned.get(tierId);
    if (!layer) return false;
    owned.delete(tierId);
    viewer?.imageryLayers?.remove(layer, true);
    return true;
  };

  return {
    /** Swap one tier to a new frame, leaving the other tiers untouched. */
    apply(viewer, tier, frame) {
      const provider = new Cesium.WebMapServiceImageryProvider(
        tierImageryOptions(tier, frame),
      );
      const next = new Cesium.ImageryLayer(provider, tierLayerOptions(tier));
      // Append: index 0 belongs to the base map.
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
    get size() {
      return owned.size;
    },
  };
}
