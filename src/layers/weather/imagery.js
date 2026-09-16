import * as Cesium from 'cesium';
import { DRAPED_ALPHA_SCALE } from '../../data/xweatherCatalogue.js';

/**
 * Cesium options for one spec.
 *
 * The URL names no frame — the proxy asks upstream for `current`, the only
 * step that means the same thing at every moment — but it does carry a
 * freshness floor. Rebuilding the layer is what makes
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

/**
 * Layer options for a spec in the regime it is about to be drawn in.
 *
 * @param {object} spec Layer spec.
 * @param {'globe'|'tileset'} [regime] Where the layer is being added.
 * @returns {object} Cesium imagery-layer options.
 */
export function layerOptionsFor(spec, regime = 'globe') {
  // Alpha must stay a plain number. Cesium's type definition still advertises a
  // per-tile function, but the globe shader assigns the value straight into a
  // float uniform (`uniforms.imageryTextureAlpha[i] = imageryLayer.alpha`), so a
  // function silently corrupts the uniform and renders the whole globe black.
  return {
    alpha: regime === 'tileset' ? spec.alpha * DRAPED_ALPHA_SCALE : spec.alpha,
  };
}

/**
 * Own this layer's imagery handles and nothing else.
 *
 * Imagery is drawn into whichever collection is being rendered: the globe's
 * while a globe stack is up, a photoreal tileset's while one hides the globe.
 * Each handle therefore records the collection it was added to, and is only
 * ever removed from that one — which is what lets a regime switch move the
 * layers without orphaning imagery in the collection it left.
 *
 * Neither collection belongs to this stack. `MapSourceController` keeps the
 * base map at index 0 of the globe's, and the tileset's is the tileset's own.
 * Inserting and removing strictly what it added is what stops this stack from
 * evicting either owner's layers.
 */
export function createImageryStack() {
  /** @type {Map<string, {layer: object, collection: object, rung: number}>} */
  const owned = new Map();

  const detach = (specId) => {
    const entry = owned.get(specId);
    if (!entry) return false;
    owned.delete(specId);
    entry.collection.remove(entry.layer, true);
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
   *
   * Only peers already in this collection can order this one within it: mid
   * re-home the rest of the selection is still in the collection being left.
   */
  const insertIndexFor = (collection, spec) => {
    let index = collection.length;
    for (const [specId, entry] of owned) {
      if (specId === spec.id) continue;
      if (entry.collection !== collection) continue;
      if (entry.rung <= spec.rung) continue;
      const at = collection.indexOf(entry.layer);
      if (at >= 0 && at < index) index = at;
    }
    return index;
  };

  return {
    /**
     * Swap a spec to a new layer in the given collection, leaving anything
     * else in the scene alone.
     *
     * Re-homing between regimes needs no separate path: the add lands in the
     * new collection and the detach reads the old one off the handle.
     *
     * @param {object} collection Cesium ImageryLayerCollection to draw into.
     * @param {object} spec Layer spec.
     * @param {object} [options]
     * @param {number} [options.notBefore=0] Freshness floor for its tiles.
     * @param {'globe'|'tileset'} [options.regime] Which collection this is.
     * @returns {object} The Cesium ImageryLayer now owned for this spec.
     */
    apply(collection, spec, { notBefore = 0, regime = 'globe' } = {}) {
      const provider = new Cesium.UrlTemplateImageryProvider(
        imageryOptionsFor(spec, { notBefore }),
      );
      const next = new Cesium.ImageryLayer(
        provider,
        layerOptionsFor(spec, regime),
      );
      // Add before removing so the live layer never blinks through to what is
      // beneath. Inserting at the spec's rung — rather than appending — keeps
      // the paint order independent of refresh order, and leaves index 0 to
      // whoever owns it.
      collection.add(next, insertIndexFor(collection, spec));
      detach(spec.id);
      owned.set(spec.id, { layer: next, collection, rung: spec.rung });
      return next;
    },
    remove: detach,
    /** Drop every owned handle; safe to call before init and after destroy. */
    clear() {
      for (const specId of [...owned.keys()]) detach(specId);
    },
    has(specId) {
      return owned.has(specId);
    },
    /** Drawn, and drawn in the collection being rendered now. */
    isDrawnIn(collection, specId) {
      return owned.get(specId)?.collection === collection;
    },
    ownedIds() {
      return [...owned.keys()];
    },
    get size() {
      return owned.size;
    },
  };
}
