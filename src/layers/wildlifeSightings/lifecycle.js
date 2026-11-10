import { msg } from '../../i18n/marker.js';
import { getWildlifeHeightBand, rowInWildlifeBoxes } from './model.js';
import {
  combineWildlifeGridSnapshots,
  preferredWildlifeFailure,
  wildlifeFailureDelayMs,
  wildlifeFailures,
  wildlifeRetryAfterMs,
} from './source.js';
import { wildlifeMeasure } from './performance.js';
import { isRecentWildlifeSighting } from './records.js';
import {
  wildlifeGridViewportBoxes,
  chooseWildlifeGridZoom,
  wildlifeGridTiles,
  wildlifeGridCellId,
} from './gridViewport.js';
import { wildlifeViewportBoxes, snapWildlifeBox } from './viewport.js';
import {
  WILDLIFE_DEBOUNCE_MS,
  WILDLIFE_MAX_ROWS,
  WILDLIFE_GRID_HEIGHT_METERS,
} from './policy.js';

/** Manager-owned acquisition with camera debounce and guarded transactions. */
export function createLifecycle({ state, services, parts }) {
  let requestQueryKey = null;
  let removeManagerListener = null;
  let lifetimeEpoch = 0;
  let initialCameraDeadline = 0;
  let initialSettle = null;
  // The manager invokes update immediately after enable. Settle startup camera
  // events before dispatching anything, then acquire only the resulting view.
  const INITIAL_CAMERA_SETTLE_MS = 300;

  function settleInitialCamera(signal) {
    if (!initialCameraDeadline || services.now() >= initialCameraDeadline) {
      initialCameraDeadline = 0;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const finish = () => {
        services.clearTimer(state.cameraTimer);
        state.cameraTimer = null;
        initialSettle = null;
        initialCameraDeadline = 0;
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      initialSettle = {
        schedule() {
          services.clearTimer(state.cameraTimer);
          state.cameraTimer = services.setTimer(
            finish,
            Math.max(0, initialCameraDeadline - services.now()),
          );
        },
        finish,
      };
      signal?.addEventListener('abort', finish, { once: true });
      initialSettle.schedule();
    });
  }

  function renderBatch(fn) {
    parts.rendering.beginBatch?.();
    try {
      return fn();
    } finally {
      parts.rendering.endBatch?.();
    }
  }

  function clearPending() {
    if (!state.pendingParams) return;
    if (state.error) state.failedParams = state.pendingParams;
    state.pendingParams = null;
    parts.controls.notify();
  }

  function failParams(params) {
    // An acquisition can fail during an ordinary refresh, when no option is
    // pending. Keep the chosen taxa visible and retryable in that case too.
    state.failedParams = {
      ...params,
      keys: [
        ...new Set([
          ...(state.pendingParams?.keys || []),
          'taxa',
          ...(params.confirmed ? ['confirmed'] : []),
        ]),
      ],
    };
    state.pendingParams = null;
  }

  function applyRetry(
    errors,
    retryAfterSec = null,
    previousMs = state.failures || 0,
  ) {
    // Only 429/5xx failures impose cooldown; client, network and schema
    // errors retry on pan. Several requests can fail together: wait for the
    // longest effective delay among them.
    const delays = [
      ...wildlifeFailures(errors).map((error) =>
        wildlifeFailureDelayMs(error, previousMs),
      ),
      wildlifeRetryAfterMs(retryAfterSec),
    ].filter((delay) => delay !== null);
    if (!delays.length) {
      state.failures = 0;
      state.retryAt = 0;
      return;
    }
    const backoff = Math.max(...delays);
    state.failures = backoff;
    state.retryAt = services.now() + backoff;
  }

  function pageHidden() {
    return (
      services.eventTarget?.document?.hidden || globalThis.document?.hidden
    );
  }

  function currentQuery() {
    const height = state.viewer?.camera?.positionCartographic?.height;
    state.band = getWildlifeHeightBand(height ?? Infinity, state.band);
    const boxes =
      state.band === 'global'
        ? null
        : wildlifeViewportBoxes(state.viewer)?.map((box) =>
            snapWildlifeBox(box),
          );
    const visibleBoxes = wildlifeGridViewportBoxes(state.viewer);
    const scope =
      state.band === 'global' ||
      (!boxes && (height ?? Infinity) > WILDLIFE_GRID_HEIGHT_METERS)
        ? 'global'
        : 'view';
    if (scope === 'view' && (!boxes?.length || boxes.some((box) => !box)))
      return null;
    const baseKey = JSON.stringify([
      scope,
      scope === 'global' ? null : boxes,
      state.confirmed,
      state.taxa,
    ]);
    const canvas = state.viewer?.scene?.canvas;
    const zoom = visibleBoxes?.length
      ? chooseWildlifeGridZoom({
          boxes: visibleBoxes,
          width: canvas?.clientWidth || 1400,
          height: canvas?.clientHeight || 900,
        })
      : 0;
    const tiles = visibleBoxes?.length
      ? wildlifeGridTiles({ boxes: visibleBoxes, z: zoom })
      : [];
    return {
      scope,
      boxes: scope === 'global' ? null : boxes,
      visibleBoxes,
      tiles,
      key: JSON.stringify([baseKey, tiles]),
    };
  }

  function refreshView() {
    const query = currentQuery();
    const superseded = state.query?.key !== query?.key;
    state.query = query;
    if (superseded) {
      state.request?.abort();
      state.background?.abort();
    }
    // Keep the previous validated display while changing filters. Its rows
    // and parameter chips are replaced together when acquisition succeeds.
    renderBatch(() => {
      const pending =
        !state.pendingClear && parts.rendering.rebuild() === 'pending';
      parts.rendering.cull();
      if (pending) return;
      parts.selection.refreshAmbient();
      parts.selection.refreshContexts();
      parts.selection.syncCredits();
    });
    return query;
  }

  async function refresh() {
    if (!state.enabled || pageHidden()) {
      clearPending();
      return;
    }
    const controller = new AbortController();
    const pendingParams = state.pendingParams;
    state.background?.abort();
    state.background = controller;
    try {
      if (state.manager)
        await state.manager.refreshLayer('wildlife-sightings', {
          signal: controller.signal,
        });
      else await methods.update(undefined, { signal: controller.signal });
    } catch {
      // update exposes expected source errors through stats; manager failures
      // already have their own normalized status path.
    } finally {
      if (state.background === controller) {
        state.background = null;
        // A manager may decline acquisition while it is enabling, or the view
        // may disappear before update. Only queued/in-flight work is busy.
        if (
          state.pendingParams === pendingParams &&
          !state.loading &&
          state.cameraTimer == null
        )
          clearPending();
      }
    }
  }

  function scheduleRefresh() {
    services.clearTimer(state.cameraTimer);
    state.cameraTimer = null;
    if (!state.enabled || pageHidden()) {
      clearPending();
      return;
    }
    if (initialSettle) {
      initialSettle.schedule();
      return;
    }
    const query = currentQuery();
    if (!query || query.key === state.lastQueryKey) {
      clearPending();
      return;
    }
    if (
      query.key === requestQueryKey &&
      state.request &&
      !state.request.signal.aborted
    )
      return;
    state.cameraTimer = services.setTimer(
      () => {
        state.cameraTimer = null;
        if (!state.enabled || pageHidden()) {
          clearPending();
          return;
        }
        const query = currentQuery();
        if (!query || query.key === state.lastQueryKey) {
          clearPending();
          return;
        }
        if (
          query.key === requestQueryKey &&
          state.request &&
          !state.request.signal.aborted
        )
          return;
        if (services.now() < state.retryAt) {
          scheduleRefresh();
          return;
        }
        void refresh();
      },
      Math.max(WILDLIFE_DEBOUNCE_MS, state.retryAt - services.now()),
    );
  }

  function applyAccepted({
    snapshot,
    grid,
    gridError,
    query,
    params,
    request,
    signal,
    epoch,
    previousFailures,
    replaceRows = true,
  }) {
    const current = currentQuery();
    if (
      !state.enabled ||
      state.destroyed ||
      epoch !== lifetimeEpoch ||
      request.signal.aborted ||
      signal?.aborted ||
      params.taxa !== state.taxa ||
      params.confirmed !== state.confirmed ||
      current?.key !== query.key
    )
      return;
    renderBatch(() => {
      const sameParams =
        params.taxa === state.drawnParams?.taxa &&
        params.confirmed === state.drawnParams?.confirmed;
      const gridParams = state.gridParams || state.drawnParams;
      const sameGridParams =
        params.taxa === gridParams?.taxa &&
        params.confirmed === gridParams?.confirmed;
      // Tiles may beat a slow observation page. Publish their density without
      // replacing observations or claiming their filter transaction succeeded.
      // A pending filter keeps its previous display until both paths agree.
      if (!snapshot) {
        if (state.drawnParams && !sameParams) return;
        if (grid) {
          state.gridCells = grid.cells || [];
          state.gridParams = params;
          state.gridAvailable = true;
          state.gridTotal = grid.totalResults || 0;
          if (state.lastUpdate == null)
            state.lastUpdate = Number.isFinite(grid.fetchedAt)
              ? grid.fetchedAt
              : services.now();
          const pendingRender = parts.rendering.rebuild() === 'pending';
          if (!pendingRender) {
            parts.selection.refreshAmbient();
            parts.selection.publishSelected();
            parts.selection.refreshContexts();
            parts.selection.syncCredits();
          }
          parts.controls.notify();
        }
        return;
      }
      if (replaceRows) {
        if (state.selectedId && !state.selectedRow)
          state.selectedRow =
            state.rowById.get(state.selectedId) ||
            state.rows.get(state.selectedId) ||
            null;
        const retainedRows = sameParams
          ? (parts.selection.retainedAmbientRows?.() || []).filter(
              (row) =>
                state.rows.has(row.stableId) &&
                isRecentWildlifeSighting(row, services.now(), params.taxa),
            )
          : [];
        const retainedIds = new Set(retainedRows.map((row) => row.stableId));
        if (state.selectedRow) retainedIds.add(state.selectedRow.stableId);
        if (state.pendingClear || state.loadedScope !== query.scope)
          state.rows.clear();
        state.loadedScope = query.scope;
        state.pendingClear = false;
        // A successful page replaces this queried area, including a healthy
        // empty page. Keep only other visited areas in the bounded LRU. Areas
        // whose iNaturalist request failed keep their last iNaturalist rows.
        const inat = snapshot.sources?.inaturalist;
        const failedInatBoxes =
          inat?.ok === false ? inat.failedBoxes || query.boxes : null;
        for (const [id, row] of state.rows) {
          if (
            failedInatBoxes &&
            row.origin === 'inaturalist' &&
            rowInWildlifeBoxes(row, failedInatBoxes, 0)
          )
            continue;
          if (rowInWildlifeBoxes(row, query.boxes, 0)) state.rows.delete(id);
        }
        for (const row of snapshot.rows) {
          state.rows.delete(row.stableId);
          state.rows.set(row.stableId, row);
          if (row.stableId === state.selectedId) state.selectedRow = row;
        }
        // Selection owns a real observation until explicit deselection. It is
        // independent of sample/window/filter and ambient-card eligibility.
        if (state.selectedRow && !state.rows.has(state.selectedId))
          state.rows.set(state.selectedId, state.selectedRow);
        // Random samples may omit a photograph already displayed. Its bounded
        // incumbent row stays selectable until the card leaves the view/window.
        for (const row of retainedRows) {
          if (!state.rows.has(row.stableId)) state.rows.set(row.stableId, row);
        }
        if (state.rows.size > WILDLIFE_MAX_ROWS) {
          for (const id of state.rows.keys()) {
            if (!retainedIds.has(id)) state.rows.delete(id);
            if (state.rows.size <= WILDLIFE_MAX_ROWS) break;
          }
        }
        if (state.rows.size > WILDLIFE_MAX_ROWS) {
          for (const id of state.rows.keys()) {
            if (id !== state.selectedId) state.rows.delete(id);
            if (state.rows.size <= WILDLIFE_MAX_ROWS) break;
          }
        }
      }
      const failedStale = [snapshot, grid].filter(
        (value) =>
          value?.stale === true &&
          Number.isFinite(value.retryAfterSec) &&
          (value.upstreamStatus === undefined ||
            value.upstreamStatus === 429 ||
            value.upstreamStatus >= 500),
      );
      // The filter above admits only 429/5xx or an unmarked stale answer.
      const staleError = failedStale.length
        ? Object.assign(
            new Error(msg('Wildlife sightings source unavailable')),
            {
              upstreamStatus: Math.max(
                ...failedStale.map((value) => value.upstreamStatus || 503),
              ),
              retryAfterSec: Math.max(
                ...failedStale.map((value) => value.retryAfterSec),
              ),
            },
          )
        : null;
      const inat = snapshot.sources?.inaturalist;
      const acartia = snapshot.sources?.acartia;
      // Keep each failed request's status and Retry-After; the displayed
      // error is the one whose effective delay sets the cooldown.
      const sourceErrors = [
        gridError,
        staleError,
        inat?.ok === false
          ? inat.error ||
            new Error(msg('Wildlife sightings source unavailable'))
          : null,
        acartia?.ok === false
          ? Object.assign(new Error(msg('Acartia feed unavailable')), {
              ...(acartia.error?.status
                ? { status: acartia.error.status }
                : {}),
              ...(acartia.error?.upstreamStatus
                ? { upstreamStatus: acartia.error.upstreamStatus }
                : {}),
              ...(Number.isFinite(acartia.error?.retryAfterSec)
                ? { retryAfterSec: acartia.error.retryAfterSec }
                : {}),
            })
          : null,
      ].filter(Boolean);
      const sourceError = preferredWildlifeFailure(
        sourceErrors,
        previousFailures,
      );
      state.stale =
        !sourceError && (snapshot.stale === true || grid?.stale === true);
      const fetchedAt = [snapshot.fetchedAt, grid?.fetchedAt].filter(
        Number.isFinite,
      );
      state.lastUpdate =
        (snapshot.stale === true || grid?.stale === true) && fetchedAt.length
          ? Math.min(...fetchedAt)
          : services.now();
      state.error = sourceError?.message || null;
      state.drawnParams = params;
      const retryAfter = [snapshot, grid]
        .filter(
          (value) =>
            value &&
            (value.upstreamStatus === undefined ||
              value.upstreamStatus === 429 ||
              value.upstreamStatus >= 500),
        )
        .map((value) => value.retryAfterSec)
        .filter(Number.isFinite);
      if (sourceError) {
        failParams(params);
        applyRetry(
          sourceErrors,
          retryAfter.length ? Math.max(...retryAfter) : null,
          previousFailures,
        );
      } else {
        state.pendingParams = null;
        state.failedParams = null;
        state.retryAt = retryAfter.length
          ? services.now() + wildlifeRetryAfterMs(Math.max(...retryAfter))
          : 0;
        state.failures = 0;
      }
      state.query = currentQuery();
      if (grid !== undefined || !sameGridParams) {
        state.gridCells = grid?.cells || [];
        state.gridParams = grid ? params : null;
        state.gridAvailable = !!grid;
        state.gridTotal = grid?.totalResults || 0;
      }
      const pendingRender = parts.rendering.rebuild() === 'pending';
      if (pendingRender) {
        state.lastQueryKey = sourceError ? null : state.query?.key || query.key;
        parts.controls.notify();
        return;
      }
      parts.selection.refreshAmbient();
      parts.selection.publishSelected();
      parts.selection.notify();
      parts.selection.refreshContexts();
      parts.selection.syncCredits();
      state.lastQueryKey = sourceError ? null : state.query?.key || query.key;
      parts.controls.notify();
    });
  }

  function disable() {
    lifetimeEpoch += 1;
    initialSettle?.finish();
    initialCameraDeadline = 0;
    state.enabled = false;
    services.clearTimer(state.cameraTimer);
    state.cameraTimer = null;
    state.request?.abort();
    state.request = null;
    requestQueryKey = null;
    state.background?.abort();
    state.background = null;
    state.loading = false;
    clearPending();
    state.removeCamera?.();
    state.removeCamera = null;
    parts.rendering.deactivate?.();
    removeManagerListener?.();
    removeManagerListener = null;
    parts.selection.remove();
    services.picking?.unregisterPickOwner?.('wildlife-sightings');
    parts.rendering.clear();
    parts.photos.clear();
    parts.controls.notify();
    parts.rendering.requestRender('disable');
    return true;
  }

  const methods = {
    /** Attach this layer's Cesium resources to one viewer. */
    init(viewer, { signal } = {}) {
      if (state.viewer)
        throw new Error('Wildlife sightings layer is already initialized');
      if (state.destroyed || signal?.aborted) return false;
      state.viewer = viewer;
      parts.rendering.init();
      return true;
    },
    /** Show retained observations and acquire the settled camera view. */
    enable(_viewer, { signal } = {}) {
      if (state.destroyed || signal?.aborted) return false;
      if (!state.viewer)
        throw new Error('Wildlife sightings layer must be initialized');
      if (state.enabled) return true;
      state.enabled = true;
      initialCameraDeadline = services.now() + INITIAL_CAMERA_SETTLE_MS;
      parts.rendering.activate?.();
      state.points.show = true;
      refreshView();
      for (const id of parts.selection.sourceIds)
        services.overlayHost?.setVisible?.(id, true);
      parts.selection.install();
      services.picking?.registerPickOwner?.(
        'wildlife-sightings',
        (id) =>
          typeof id === 'string' &&
          id.startsWith('wildlife:') &&
          state.rowById.has(id.slice(9)),
      );
      state.removeCamera = state.viewer.camera?.moveEnd?.addEventListener?.(
        () => {
          if (!state.enabled) return;
          wildlifeMeasure('moveEnd', () => {
            if (
              initialCameraDeadline &&
              services.now() < initialCameraDeadline
            ) {
              initialCameraDeadline = services.now() + INITIAL_CAMERA_SETTLE_MS;
              refreshView();
              initialSettle?.schedule();
            } else {
              refreshView();
              scheduleRefresh();
            }
            parts.controls.notify();
          });
        },
      );
      // A debounce can expire while the manager is still enabling and cannot
      // accept refreshLayer yet. Its settled visibility event is the one
      // catch-up edge; completed initial queries are skipped by their key.
      removeManagerListener =
        state.manager?.subscribe?.((change) => {
          if (
            change.type === 'visibility' &&
            change.layerId === 'wildlife-sightings' &&
            change.enabled === true &&
            state.enabled
          )
            scheduleRefresh();
        }) || null;
      if (services.sprites?.restoreSpriteOrderOnEnable)
        services.sprites.restoreSpriteOrderOnEnable(
          'wildlife-sightings',
          state.viewer,
        );
      else services.sprites?.restoreSpriteOrder?.(state.viewer);
      return true;
    },
    /** Refresh observations and density independently for the current filters. */
    async update(_viewer, { signal } = {}) {
      if (
        !state.enabled ||
        !state.points ||
        state.destroyed ||
        signal?.aborted
      ) {
        if (!state.request) clearPending();
        return false;
      }
      if (initialCameraDeadline && services.now() < initialCameraDeadline)
        await settleInitialCamera(signal);
      initialCameraDeadline = 0;
      if (!state.enabled || state.destroyed || signal?.aborted) return false;
      const query = currentQuery();
      state.query = query;
      if (!query || pageHidden()) {
        clearPending();
        return true;
      }
      if (services.now() < state.retryAt) {
        if (state.pendingParams && state.cameraTimer == null) scheduleRefresh();
        return true;
      }
      if (
        requestQueryKey === query.key &&
        state.request &&
        !state.request.signal.aborted
      )
        return true;
      state.request?.abort();
      const request = new AbortController();
      const requestLifetime = lifetimeEpoch;
      // One acquisition publishes several times (tiles, rows, final grid).
      // Each derives its default backoff from the backoff before it started.
      const previousFailures = state.failures || 0;
      const supersededResult = () =>
        state.enabled &&
        !state.destroyed &&
        lifetimeEpoch === requestLifetime &&
        !signal?.aborted;
      state.request = request;
      requestQueryKey = query.key;
      const onAbort = () => request.abort(signal.reason);
      signal?.addEventListener?.('abort', onAbort, { once: true });
      const params = { confirmed: state.confirmed, taxa: state.taxa };
      state.loading = true;
      if (!state.pendingParams) {
        const drawn = state.drawnParams || { confirmed: false, taxa: null };
        const keys = ['confirmed', 'taxa'].filter(
          (key) => params[key] !== drawn[key],
        );
        if (keys.length) state.pendingParams = { ...params, keys };
      }
      parts.controls.notify();
      let received = false;
      let gridPending = false;
      let acceptedSnapshot = null;
      let gridRequest = null;
      let gridResult = null;
      const tileSnapshots = new Map();
      const gridParams = state.gridParams || state.drawnParams;
      const retainedGrid =
        params.taxa === gridParams?.taxa &&
        params.confirmed === gridParams?.confirmed
          ? state.gridCells || []
          : [];
      function aggregateTiles(complete = false) {
        if (!tileSnapshots.size) return undefined;
        const grid = combineWildlifeGridSnapshots([...tileSnapshots.values()]);
        if (!complete && retainedGrid.length) {
          const zoom = query.tiles[0]?.z;
          const covered = new Set(tileSnapshots.keys());
          const retained = retainedGrid.filter(
            (cell) =>
              !covered.has(
                wildlifeGridCellId(cell.lat, cell.lon, zoom)?.split(':')[1],
              ),
          );
          return combineWildlifeGridSnapshots([
            { ...grid, cells: [...retained, ...grid.cells] },
          ]);
        }
        return grid;
      }
      function completedGrid(value) {
        if (!value) return value;
        const aggregate = aggregateTiles(!value.error);
        return aggregate
          ? combineWildlifeGridSnapshots([aggregate, value], value.error)
          : value;
      }
      function publish(grid, gridError = null, replaceRows = false) {
        applyAccepted({
          snapshot: acceptedSnapshot,
          grid,
          gridError,
          replaceRows,
          query,
          params,
          request,
          signal,
          epoch: requestLifetime,
          previousFailures,
        });
      }
      function finishTiles() {
        signal?.removeEventListener?.('abort', onAbort);
        if (state.request === request) {
          state.request = null;
          requestQueryKey = null;
          state.loading = false;
          if (request.signal.aborted && state.cameraTimer == null)
            clearPending();
          parts.controls.notify();
        }
      }
      function continueTiles() {
        if (!gridRequest || gridResult) return;
        gridPending = true;
        void gridRequest
          .then((result) => {
            if (
              acceptedSnapshot &&
              !request.signal.aborted &&
              state.request === request &&
              state.enabled
            )
              publish(result?.value, result?.error || result?.value?.error);
          })
          .finally(finishTiles);
      }
      try {
        const options = {
          signal: request.signal,
          boxes: query.boxes,
          box: query.boxes?.[0] || null,
          scope: query.scope,
          ...params,
        };
        // Observation requests enter the shared proxy queue first. A slow tile
        // never holds the manager's initial enable or the first observations.
        const observationRequest =
          typeof services.source.getSnapshotDetail === 'function'
            ? services.source.getSnapshotDetail(options)
            : Promise.resolve(services.source.getSnapshot(options)).then(
                (rows) => ({ rows, stale: false, fetchedAt: services.now() }),
              );
        const hasGrid =
          typeof services.source.getGridSnapshot === 'function' &&
          query.tiles.length;
        gridRequest = hasGrid
          ? services.source
              .getGridSnapshot({
                signal: request.signal,
                tiles: query.tiles,
                ...params,
                onTile(value, { tile }) {
                  if (request.signal.aborted || state.request !== request)
                    return;
                  tileSnapshots.set(`${tile.z}/${tile.x}/${tile.y}`, value);
                  publish(aggregateTiles());
                },
              })
              .then(
                (value) => {
                  gridResult = { value: completedGrid(value) };
                  if (!acceptedSnapshot)
                    publish(gridResult.value, value?.error);
                  return gridResult;
                },
                (error) => (gridResult = { error }),
              )
          : null;
        const snapshot = await observationRequest;
        if (
          request.signal.aborted ||
          state.request !== request ||
          !state.enabled
        )
          return supersededResult();
        if (!Array.isArray(snapshot?.rows))
          throw new Error('Malformed iNaturalist response');
        received = true;
        acceptedSnapshot = snapshot;
        publish(
          gridResult?.value || aggregateTiles(),
          gridResult?.error || gridResult?.value?.error,
          true,
        );
        if (hasGrid && !gridResult) {
          continueTiles();
        } else if (gridResult && !gridResult.value && gridResult.error) {
          // Observation rows remain visible when the first tile set fails.
          publish(undefined, gridResult.error);
        }
        return true;
      } catch (error) {
        if (
          request.signal.aborted ||
          state.request !== request ||
          !state.enabled
        )
          return supersededResult();
        if (received) throw error;
        // Observation failures must not cancel independent density tiles.
        continueTiles();
        state.stale = false;
        state.error =
          preferredWildlifeFailure(error, previousFailures)?.message ||
          msg('Wildlife sightings source unavailable');
        failParams(params);
        state.lastQueryKey = null;
        requestQueryKey = null;
        applyRetry(error, null, previousFailures);
        console.warn('[Data:WildlifeSightings] Update failed:', state.error);
        return true;
      } finally {
        if (!gridPending) finishTiles();
      }
    },
    /** Stop acquisition and release visible resources while retaining filters. */
    disable,
    /** Release requests, subscriptions, caches and scene resources. */
    destroy() {
      if (state.destroyed) return;
      disable();
      state.destroyed = true;
      parts.selection.destroy();
      parts.photos.destroy();
      parts.rendering.destroy();
      state.rows.clear();
      state.lastUpdate = null;
      state.error = null;
      state.stale = false;
      state.drawnParams = null;
      state.gridParams = null;
      state.pendingParams = null;
      state.failedParams = null;
      state.controlsListener = null;
      state.manager = null;
      state.viewer = null;
    },
  };
  return {
    methods,
    scheduleRefresh,
  };
}
