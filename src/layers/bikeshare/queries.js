export function createQueries({ state: layerState, services, parts, source }) {
  /**
   * Build a compact HUD detection ID string for a station.
   * Truncates long names to 24 chars for readability.
   * @param {Object} record - Render record from _stationRenderMap.
   * @returns {string} Formatted label like "Station Name [5/20]".
   */

  function buildDetectionId(record) {
    const bikes = Number.isFinite(record.bikesAvailable)
      ? record.bikesAvailable
      : '?';
    const capacity = Number.isFinite(record.capacity) ? record.capacity : '?';
    // Render record stores the station name under `stationName` (see the render-map
    // shape), so `record.name` was always undefined → every label read "Dock N".
    const label = record.stationName || `Dock ${record.stationId}`;
    // Truncate long station names to keep HUD readable
    const short = label.length > 24 ? label.slice(0, 22) + '…' : label;
    return `BIKES ${short} [${bikes}/${capacity}]`;
  }

  /**
   * Collect a sampled subset of visible stations for HUD detection overlay rendering.
   * Uses a deterministic stride pattern controlled by options.seed and options.maxCount
   * to avoid overcrowding the HUD while still providing broad coverage.
   * @param {Object} [options]
   * @param {number} [options.maxCount] - Maximum number of detectable objects to return.
   * @param {number} [options.seed] - Seed for deterministic stride offset selection.
   * @returns {Array<{ position: Cesium.Cartesian3, id: string, type: string, skipLabel: boolean }>}
   */

  function collectDetectableStations(options = {}) {
    if (
      !layerState._enabled ||
      !layerState._pointCollection ||
      !layerState._pointCollection.show ||
      layerState._stationRenderMap.size === 0
    )
      return [];

    // Gather all visible station records (include selected even though its point is hidden)
    const records = [];
    for (const record of layerState._stationRenderMap.values()) {
      const isSelected = record.key === layerState._selectedKey;
      if ((!record.point?.show && !isSelected) || !record.point?.position)
        continue;
      records.push(record);
    }
    if (records.length === 0) return [];

    // Deterministic subsampling: pick every Nth station, offset by seed
    const maxCount = Number.isFinite(options.maxCount)
      ? Math.max(1, Math.floor(options.maxCount))
      : records.length;
    const seed = Number.isFinite(options.seed) ? Math.floor(options.seed) : 0;
    const stride = Math.max(1, Math.ceil(records.length / maxCount));
    const start = ((seed % stride) + stride) % stride;

    const result = [];
    for (let i = start; i < records.length; i += stride) {
      const record = records[i];
      result.push({
        position: record.point.position,
        sourceId: record.key,
        id: buildDetectionId(record),
        type: 'VEH',
        skipLabel: record.key === layerState._selectedKey,
      });
      if (result.length >= maxCount) break;
    }

    return result;
  }
  return { buildDetectionId, collectDetectableStations };
}
