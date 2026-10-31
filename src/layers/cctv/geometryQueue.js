import * as Cesium from 'cesium';
import {
  GEO_PROGRESS_NOTIFY_INTERVAL_MS,
  GEO_PROGRESS_NOTIFY_BATCH_LIMIT,
  GEO_TRACKING_BATCH_SIZE,
  GEO_TRACKING_BATCH_DELAY_MS,
  GEO_LOAD_BATCH_SIZE,
  GEO_LOAD_BATCH_DELAY_MS,
  VIEW_GEOMETRY_ATTEMPTS,
  VIEW_GEOMETRY_RETRY_MS,
} from './policy.js';

export function createGeometryQueue({
  state: layerState,
  services,
  parts,
  source,
}) {
  /**
   * Stops the staggered geometry-load queue and optionally clears progress
   * counters (kept when pausing mid-flight is not needed — we always clear).
   * @param {boolean} [clearProgress=true]
   */

  function stopGeometryLoadQueue(clearProgress = true) {
    if (layerState._geoQueueTimer) {
      clearTimeout(layerState._geoQueueTimer);
      layerState._geoQueueTimer = 0;
    }
    clearTimeout(layerState._viewGeometryRetryTimer);
    layerState._viewGeometryRetryTimer = 0;
    layerState._geoQueue = [];
    layerState._geoProgressNotifier = null;
    if (clearProgress) {
      layerState._geoLoading = false;
      layerState._geoLoadTotal = 0;
      layerState._geoLoadDone = 0;
    }
  }

  /**
   * Creates the notification coalescer used by a staggered geometry drain.
   * Progress emits after roughly 300 ms or ten batches, whichever comes first;
   * finish always emits once even when the last progress tick just fired.
   *
   * @param {Function} notify Notification callback.
   * @param {Object} [options={}] Testable timing options.
   * @param {() => number} [options.now] Monotonic clock returning milliseconds.
   * @param {number} [options.intervalMs] Maximum progress-notification cadence.
   * @param {number} [options.batchLimit] Maximum batches between progress ticks.
   * @returns {{ progress: () => boolean, finish: () => void }} Drain notifier.
   */

  function createGeometryProgressNotifier(notify, options = {}) {
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const intervalMs = Number.isFinite(options.intervalMs)
      ? Math.max(0, options.intervalMs)
      : GEO_PROGRESS_NOTIFY_INTERVAL_MS;
    const batchLimit = Number.isFinite(options.batchLimit)
      ? Math.max(1, Math.floor(options.batchLimit))
      : GEO_PROGRESS_NOTIFY_BATCH_LIMIT;
    let lastNotifyAt = now();
    let batchesSinceNotify = 0;

    return {
      progress() {
        batchesSinceNotify += 1;
        const current = now();
        if (
          current - lastNotifyAt < intervalMs &&
          batchesSinceNotify < batchLimit
        ) {
          return false;
        }
        batchesSinceNotify = 0;
        lastNotifyAt = current;
        notify?.();
        return true;
      },
      finish() {
        batchesSinceNotify = 0;
        lastNotifyAt = now();
        notify?.();
      },
    };
  }

  /**
   * Processes one geometry-queue batch and routes progress/completion through
   * the callbacks shared by production and the unit drain harness.
   *
   * @param {Object} options Batch inputs.
   * @param {Object[]} options.queue Mutable record queue.
   * @param {number} options.batchSize Maximum records to visit.
   * @param {(record: Object) => void} options.visit Per-record geometry work.
   * @param {() => void} options.progress Coalesced progress publication.
   * @param {() => void} options.complete Unconditional completion publication.
   * @returns {boolean} True when more records remain.
   */

  function processCctvGeometryQueueBatch({
    queue,
    batchSize,
    visit,
    progress,
    complete,
  }) {
    const safeQueue = Array.isArray(queue) ? queue : [];
    const take = Number.isFinite(batchSize)
      ? Math.max(1, Math.floor(batchSize))
      : 1;
    const batch = safeQueue.splice(0, take);
    for (const record of batch) visit?.(record);
    if (safeQueue.length) {
      progress?.();
      return true;
    }
    complete?.();
    return false;
  }

  /**
   * Selects per-batch geometry-drain pacing from current camera ownership.
   * Called for every batch so releasing tracking immediately restores normal
   * throughput without restarting the queue.
   *
   * @param {Object} [ownership={}] Current camera-ownership state.
   * @param {*} [ownership.trackedEntity] Cesium tracked entity, if any.
   * @param {boolean} [ownership.cockpitActive] Whether cockpit owns the camera.
   * @returns {{ batchSize: number, delayMs: number }} Drain pacing.
   */

  function cctvGeometryDrainPacing({
    trackedEntity = null,
    cockpitActive = false,
  } = {}) {
    if (trackedEntity || cockpitActive) {
      return {
        batchSize: GEO_TRACKING_BATCH_SIZE,
        delayMs: GEO_TRACKING_BATCH_DELAY_MS,
      };
    }
    return { batchSize: GEO_LOAD_BATCH_SIZE, delayMs: GEO_LOAD_BATCH_DELAY_MS };
  }

  /**
   * Processes one tracking-aware geometry-drain batch. Ownership is read inside
   * every call so a mid-drain tracking/cockpit transition changes the very next
   * batch's size and delay.
   *
   * @param {Object} options Batch inputs.
   * @param {Object[]} options.queue Mutable record queue.
   * @param {() => Object} [options.readOwnership] Current camera ownership.
   * @param {(record: Object) => void} options.visit Per-record geometry work.
   * @param {() => void} options.progress Coalesced progress publication.
   * @param {() => void} options.complete Unconditional completion publication.
   * @returns {{ hasMore: boolean, batchSize: number, delayMs: number }} Batch result and pacing.
   */

  function processCctvGeometryDrainBatch({
    queue,
    readOwnership,
    visit,
    progress,
    complete,
  }) {
    const pacing = cctvGeometryDrainPacing(readOwnership?.() || {});
    const hasMore = processCctvGeometryQueueBatch({
      queue,
      batchSize: pacing.batchSize,
      visit,
      progress,
      complete,
    });
    return { hasMore, ...pacing };
  }

  /**
   * Moves the current active record to the front of a live drain queue.
   * @param {Object[]} queue Mutable geometry queue.
   * @param {Object|null} activeRecord Current active CCTV record.
   * @returns {boolean} Whether the queue order changed.
   */

  function prioritizeActiveCctvGeometryRecord(queue, activeRecord) {
    if (!Array.isArray(queue) || !activeRecord) return false;
    const index = queue.indexOf(activeRecord);
    if (index <= 0) return false;
    queue.splice(index, 1);
    queue.unshift(activeRecord);
    return true;
  }

  /**
   * Processes one batch (GEO_LOAD_BATCH_SIZE records) of the geometry queue:
   * full ground-sampled coverage geometry per record, then yields back to the
   * event loop before the next batch so tile rendering never stalls. When the
   * initial-load pass completes it clears the loading flag and refreshes styles.
   */

  function processGeometryBatch() {
    layerState._geoQueueTimer = 0;
    if (!layerState._viewer) {
      stopGeometryLoadQueue();
      return;
    }
    // Active-camera-first is re-established every batch because the operator
    // can select a new camera while a long catalog drain is in flight.
    prioritizeActiveCctvGeometryRecord(
      layerState._geoQueue,
      parts.selection.getActiveRecord(),
    );
    const batchResult = processCctvGeometryDrainBatch({
      queue: layerState._geoQueue,
      readOwnership: () => ({
        trackedEntity: layerState._viewer.trackedEntity,
        cockpitActive:
          typeof document !== 'undefined' &&
          document.body?.classList.contains('cockpit-mode'),
      }),
      visit: (record) => {
        try {
          parts.geometry.updateRecordGeometry(record);
        } catch (err) {
          console.warn(
            '[Data:CCTV] geometry refresh error:',
            err?.message || err,
          );
        }
        noteViewAttempt(record);
        if (
          layerState._geoLoading &&
          layerState._geoLoadDone < layerState._geoLoadTotal
        ) {
          layerState._geoLoadDone += 1;
        }
      },
      progress: () => layerState._geoProgressNotifier?.progress(),
      complete: () => {
        const wasInitialLoad = layerState._geoLoading;
        layerState._geoLoading = false;
        if (wasInitialLoad) {
          layerState._geoLoadDone = layerState._geoLoadTotal;
          if (layerState._enabled) parts.rendering.refreshCoverageStyles();
        }
        // Geometry refinement may have replaced record.position objects — every
        // drain's completion re-anchors the card entries (event-driven, not a
        // per-frame or timer pass).
        // While the camera moves, moveEnd reselects them instead.
        if (layerState._enabled && !layerState._cameraMoving)
          parts.cards.refreshAmbientCards();
        scheduleViewGeometryRetry();
        // Completion is never coalesced: subscribers must observe the final
        // loading state even if the last progress tick just happened.
        layerState._geoProgressNotifier?.finish();
        layerState._geoProgressNotifier = null;
      },
    });
    if (batchResult.hasMore) {
      layerState._geoQueueTimer = setTimeout(
        processGeometryBatch,
        batchResult.delayMs,
      );
      return;
    }
  }

  /**
   * Appends records to the geometry queue (no progress tracking) and starts
   * the batch timer if idle. Used by update()'s one-shot tiles-ready
   * completion pass and by enqueueViewGeometry, so both share the initial
   * load's stagger machinery. Never driven by a recurring timer.
   * @param {Object[]} records - Camera records needing geometry refresh.
   */

  function enqueueGeometryRefresh(records) {
    const queued = new Set(layerState._geoQueue);
    for (const record of records) {
      if (!queued.has(record)) {
        queued.add(record);
        layerState._geoQueue.push(record);
      }
    }
    if (!layerState._geoQueueTimer && layerState._geoQueue.length) {
      layerState._geoProgressNotifier = createGeometryProgressNotifier(
        parts.presentation.notifyListeners,
      );
      layerState._geoQueueTimer = setTimeout(processGeometryBatch, 0);
    }
  }

  /**
   * Starts the initial staggered load over the geometry working set: active
   * camera first, then by distance from the current viewer position (nearest
   * first), and exposes loaded/total progress through uiState()/getStats()
   * while running. Cameras outside the view refine when they come into it.
   */

  function startGeometryLoadQueue() {
    stopGeometryLoadQueue();
    // Fresh drain → fresh one-shot completion pass: re-arm the tiles-ready
    // latch so update() can complete any records this drain leaves unresolved.
    layerState._tilesReadyReenqueued = false;
    if (!layerState._records.length) return;
    const active = parts.selection.getActiveRecord();
    const carto = layerState._viewer?.camera?.positionCartographic;
    const refLat = carto
      ? Cesium.Math.toDegrees(carto.latitude)
      : (active?.camera.lat ?? 0);
    const refLon = carto
      ? Cesium.Math.toDegrees(carto.longitude)
      : (active?.camera.lon ?? 0);
    const pending = geometryWorkingSet()
      .filter((record) => record !== active)
      .map((record) => ({
        record,
        distKm: parts.model.haversineKm(
          refLat,
          refLon,
          record.camera.lat,
          record.camera.lon,
        ),
      }))
      .sort((a, b) => a.distKm - b.distKm)
      .map((entry) => entry.record);
    layerState._geoQueue = active ? [active, ...pending] : pending;
    layerState._geoLoadTotal = layerState._geoQueue.length;
    layerState._geoLoadDone = 0;
    layerState._geoLoading = true;
    layerState._geoProgressNotifier = createGeometryProgressNotifier(
      parts.presentation.notifyListeners,
    );
    layerState._geoQueueTimer = setTimeout(processGeometryBatch, 0);
  }
  /**
   * The records whose geometry the view needs: the shown icons, the active
   * camera and the coverage cohort drawn around it.
   * @returns {Object[]}
   */

  function geometryWorkingSet() {
    const records = new Set(layerState._viewRecords);
    const active = parts.selection.getActiveRecord();
    if (active) records.add(active);
    for (const id of layerState._coverageVisibleIds) {
      const record = layerState._recordById.get(id);
      if (record) records.add(record);
    }
    return [...records];
  }

  /** The regime key a view attempt counts against: interim while tiles stream. */
  function viewAttemptKey() {
    const regime = parts.ground.currentSurfaceRegime();
    const tilesReady =
      regime !== 'google-3d' || parts.model.projectionTilesReady();
    return { key: tilesReady ? regime : `${regime}:interim`, tilesReady };
  }

  /**
   * Counts a processed geometry attempt against the current regime key; each
   * key keeps its own count, so tile streaming going on and off does not
   * reset the ready-tiles budget.
   */
  function noteViewAttempt(record) {
    const { key } = viewAttemptKey();
    record.viewAttempts ??= {};
    record.viewAttempts[key] = (record.viewAttempts[key] || 0) + 1;
    record.viewAttemptAt = performance.now();
  }

  /**
   * Whether a record may be attempted again under `key`. After a first
   * unresolved attempt, the second waits out VIEW_GEOMETRY_RETRY_MS so its
   * elevation cell can warm, rather than going to the next motion tick.
   */
  /** Whether a record still has an attempt left under the current key. */
  function withinViewBudget(record) {
    const { key } = viewAttemptKey();
    return (record.viewAttempts?.[key] || 0) < VIEW_GEOMETRY_ATTEMPTS;
  }

  function attemptsLeft(record, key) {
    const attempts = record.viewAttempts?.[key] || 0;
    if (attempts >= VIEW_GEOMETRY_ATTEMPTS) return false;
    return (
      attempts === 0 ||
      performance.now() - record.viewAttemptAt >= VIEW_GEOMETRY_RETRY_MS
    );
  }

  /**
   * After a drain, gives working-set cameras it left ungrounded one more
   * attempt once their elevation cells have had time to warm. The timer is
   * set for the earliest such camera and re-arms for the rest when it fires.
   */
  function scheduleViewGeometryRetry() {
    if (!layerState._enabled || layerState._viewGeometryRetryTimer) return;
    const { key } = viewAttemptKey();
    const active = parts.selection.getActiveRecord();
    let due = Infinity;
    for (const record of geometryWorkingSet()) {
      const attempts = record.viewAttempts?.[key] || 0;
      if (
        record === active ||
        attempts === 0 ||
        attempts >= VIEW_GEOMETRY_ATTEMPTS ||
        !parts.ground.needsGeometry(record)
      )
        continue;
      due = Math.min(due, record.viewAttemptAt + VIEW_GEOMETRY_RETRY_MS);
    }
    if (due === Infinity) return;
    layerState._viewGeometryRetryTimer = setTimeout(
      () => {
        layerState._viewGeometryRetryTimer = 0;
        enqueueViewGeometry();
        // A drain re-arms on completion; with none running, the cameras still
        // cooling down need their own timer.
        if (!layerState._geoQueueTimer) scheduleViewGeometryRetry();
      },
      Math.max(0, due - performance.now()),
    );
  }

  /**
   * Queues working-set cameras the current surface has not grounded yet,
   * after a camera move brings new ones into view. Attempts are counted when
   * a record is processed, not queued, so a drain cut short by disable() is
   * not lost; each record gets VIEW_GEOMETRY_ATTEMPTS per surface regime,
   * spaced by VIEW_GEOMETRY_RETRY_MS, so a sample the shared floor refuses
   * (too far, too high) is not retried on every move. While photoreal tiles are still streaming the attempts are
   * interim, and the update() completion pass is re-armed to retry these
   * records when they land. The active camera is left to selection, which
   * owns its re-sampling.
   */

  function enqueueViewGeometry() {
    if (!layerState._enabled) return;
    const { key, tilesReady } = viewAttemptKey();
    const active = parts.selection.getActiveRecord();
    const pending = [];
    let coolingDown = false;
    for (const record of geometryWorkingSet()) {
      if (record === active || !parts.ground.needsGeometry(record)) continue;
      if (!attemptsLeft(record, key)) {
        coolingDown ||=
          (record.viewAttempts?.[key] || 0) < VIEW_GEOMETRY_ATTEMPTS;
        continue;
      }
      pending.push(record);
    }
    // A camera back in view during its cooldown still needs its retry timer.
    if (coolingDown && !layerState._geoQueueTimer) scheduleViewGeometryRetry();
    if (!pending.length) return;
    if (!tilesReady) layerState._tilesReadyReenqueued = false;
    enqueueGeometryRefresh(pending);
  }
  return {
    enqueueViewGeometry,
    withinViewBudget,
    geometryWorkingSet,
    stopGeometryLoadQueue,
    createGeometryProgressNotifier,
    processCctvGeometryQueueBatch,
    cctvGeometryDrainPacing,
    processCctvGeometryDrainBatch,
    prioritizeActiveCctvGeometryRecord,
    processGeometryBatch,
    enqueueGeometryRefresh,
    startGeometryLoadQueue,
  };
}
