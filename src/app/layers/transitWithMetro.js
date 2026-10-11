const JOINER = ' · ';

function plural(count, one, many) {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/**
 * Combine Transit (GTFS-RT vehicles) and Metro (Wikidata stations) stats into
 * the one Transit row. Transit stays authoritative for its own feed state;
 * stations only take over the row when no transit feed covers the view, so a
 * city with Wikidata stations but no live feed is not shown as "zoom in".
 * @param {object} [transit] Transit layer stats.
 * @param {object} [metro] Metro layer stats.
 * @returns {object}
 */
export function mergeTransitMetroStats(transit = {}, metro = {}) {
  const vehicles = Number(transit.count) || 0;
  const stations = Number(metro.count) || 0;
  const merged = {
    ...transit,
    count: vehicles + stations,
    source: [transit.source, metro.source].filter(Boolean).join(JOINER),
  };
  const lastUpdate = Math.max(
    Number(transit.lastUpdate) || 0,
    Number(metro.lastUpdate) || 0,
  );
  merged.lastUpdate = lastUpdate || transit.lastUpdate || null;
  if (stations) {
    merged.countLabel = [
      vehicles ? plural(vehicles, 'vehicle', 'vehicles') : '',
      metro.countLabel || plural(stations, 'station', 'stations'),
    ]
      .filter(Boolean)
      .join(JOINER);
  }
  if (!transit.loading && metro.loading) {
    merged.loading = true;
    merged.loadingLabel = metro.loadingLabel || 'Loading metro stations';
  }
  if (transit.status === 'zoom-in' && (stations || metro.loading)) {
    // No GTFS-RT feed here, but Wikidata has (or is fetching) stations.
    merged.status = metro.status;
    merged.statusMessage = metro.statusMessage;
  }
  if (!merged.error && !vehicles && !stations && metro.error)
    merged.error = metro.error;
  return merged;
}

/**
 * Present the Metro stations layer as part of Transit: one catalog entry, one
 * palette row and one share-link token. Turning Transit on or off turns both
 * on or off; the row shows Metro's line legend and station chips.
 *
 * Transit methods are always invoked on the Transit object itself, because its
 * `destroy` calls `this.disable`.
 * @param {object} transit Transit data-layer module.
 * @param {object} metro Metro data-layer module.
 * @returns {object} Data-layer module registered under Transit's id.
 */
export function withMetroStations(transit, metro) {
  let metroLoadPending = false;
  return {
    ...transit,
    source: [transit.source, metro.source].filter(Boolean).join(JOINER),
    init(viewer) {
      const result = transit.init(viewer);
      metro.init(viewer);
      return result;
    },
    enable(viewer) {
      const result = transit.enable(viewer);
      metro.enable(viewer);
      // The manager calls update() right after enable(); Metro's first fetch
      // rides on it, then Metro reloads on its own camera moves.
      metroLoadPending = true;
      return result;
    },
    disable(viewer) {
      metroLoadPending = false;
      metro.disable(viewer);
      return transit.disable(viewer);
    },
    update(...args) {
      if (metroLoadPending) {
        metroLoadPending = false;
        // Metro reports its own failures through getStats().
        void Promise.resolve()
          .then(() => metro.update())
          .catch(() => {});
      }
      return transit.update(...args);
    },
    destroy(viewer) {
      metroLoadPending = false;
      metro.destroy(viewer);
      return transit.destroy(viewer);
    },
    getStats() {
      return mergeTransitMetroStats(transit.getStats(), metro.getStats());
    },
    getRowControls() {
      return metro.getRowControls?.() || null;
    },
    setRowControlsListener(listener) {
      metro.setRowControlsListener?.(listener);
    },
  };
}
