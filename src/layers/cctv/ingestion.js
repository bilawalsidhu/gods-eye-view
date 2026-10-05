export function createIngestion({
  state: layerState,
  services,
  parts,
  source,
}) {
  const methods = {
    /**
     * Periodic update tick: syncs health state and runs auto-hop logic. Ground
     * geometry is NOT resampled here — v2 grounds each camera once via the
     * staggered load queue (see startGeometryLoadQueue/updateRecordGeometry)
     * and never resamples on a timer. The ONE exception is a one-shot
     * completion pass: the enable-time drain can run while 3D tiles are still
     * streaming (each such pass keeps the fabricated catalog height and leaves
     * the record `!groundResolved`), so the FIRST tick that sees
     * projectionTilesReady() re-enqueues those records once — each then takes
     * its single real sample and freezes (design §4). Guarded by a boolean
     * latch (`_tilesReadyReenqueued`), NOT a timer loop: after it fires, no
     * tick ever samples anything again.
     */
    async update() {
      if (!layerState._enabled) return;
      const now = Date.now();
      layerState._lastUpdate = now;
      if (
        !layerState._tilesReadyReenqueued &&
        parts.model.projectionTilesReady()
      ) {
        layerState._tilesReadyReenqueued = true;
        // Per-regime resolution (Task 5): only records unresolved for the
        // CURRENT surface regime need the completion pass. On globe stacks
        // projectionTilesReady() is false while a (hidden) Google tileset
        // exists, so this latch effectively fires for the google-3d regime —
        // terrain-globe records resolve from the prior in their drain pass.
        const unresolved = layerState._records.filter(
          (record) => !parts.ground.isGroundResolved(record),
        );
        if (unresolved.length)
          parts.geometryQueue.enqueueGeometryRefresh(unresolved);
      }
      await parts.health.syncHealthState();
      parts.navigation.maybeAutoHop(now);
      parts.presentation.notifyListeners();
    },
  };

  return { methods };
}
