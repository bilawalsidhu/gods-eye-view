import * as Cesium from 'cesium';
import { t, msg, formatNumber } from '../../i18n/index.js';
import { createContactTrailRenderer } from '../../data/contactTrailRenderer.js';
import { transitStyleProfile } from '../../data/transitPresetStyle.js';
import { createRadiosondeRendering } from './rendering.js';
import {
  normalizeSondeFrame,
  mergeFrame,
  decimateTrack,
  flightPhase,
  isSondeAloft,
  isSondeLanded,
  trackPoint,
  SONDE_RETAIN_MS,
  SONDE_MAX_SERIALS,
  SONDE_TRACK_MAX_POINTS,
} from './records.js';
import {
  buildSelectedSondeCard,
  sondeTrackerUrl,
  formatAge,
  launchWindowText,
  RADIOSONDES_OVERLAY_SOURCE_ID,
  RADIOSONDES_SELECTED_SOURCE_ID,
  RADIOSONDES_SELECTED_OPTIONS,
} from './cards.js';
import * as policy from './policy.js';

/** Compose a Weather balloons layer with supplied sources and scene services. */
export function createRadiosondesLayer({
  source,
  services = {},
  overlayHost = null,
  openExternal = null,
  screenSpaceEventHandlerFactory = null,
  now = Date.now,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  getVisionStyle = () =>
    globalThis.document?.documentElement?.dataset?.gevVisionStyle ??
    globalThis.document?.documentElement?.dataset?.gevStyle ??
    'normal',
} = {}) {
  if (
    typeof source?.getSnapshot !== 'function' ||
    typeof source?.getTrack !== 'function' ||
    typeof source?.getHistory !== 'function'
  )
    throw new TypeError(
      'Weather balloons require snapshot, track and history sources',
    );
  const records = new Map();
  let viewer = null,
    rendering = null,
    enabled = false,
    destroyed = false;
  let unsubscribe = null,
    clickHandler = null,
    removeCamera = null,
    request = null,
    selectionRequest = null;
  let manager = null,
    retryTimer = null,
    retryDue = false,
    retryDocument = null,
    lifetime = null;
  let batchTimer = null,
    pendingBatch = null,
    lastBatchMs = -Infinity;
  let selected = null,
    selectedCardId = null,
    selectedLink = null,
    selectedTrack = [],
    trail = null,
    trailRevision = 0,
    trailReadyRevision = -1,
    trailSignature = '',
    trailStyle = '',
    trailFrameMs = null,
    selectedCardSignature = '',
    removeTrailReady = null,
    trailDisplay = null;
  let streamState = 'closed',
    upstream = 'closed',
    lastFrameMs = null,
    lastUpdate = null,
    observedAt = null;
  let error = null,
    loading = false,
    proxyStale = false,
    partial = false,
    style = 'normal',
    rowListener = null,
    pushRevision = 0;
  const notify = () => {
    try {
      rowListener?.();
    } catch {
      /* panel already disposed */
    }
  };
  const render = (reason) =>
    services.render?.governorRequestRender?.(`radiosondes-${reason}`);
  const reconnecting = () =>
    typeof source.subscribe === 'function' &&
    streamState !== 'unavailable' &&
    streamState !== 'open';
  const starting = () =>
    !records.size &&
    lastUpdate === null &&
    (upstream === 'closed' || upstream === 'connecting');
  function clearRetry() {
    if (retryTimer !== null) clearTimeoutImpl(retryTimer);
    retryTimer = null;
    retryDue = false;
    retryDocument?.removeEventListener?.('visibilitychange', onRetryVisibility);
    retryDocument = null;
  }
  function onRetryVisibility() {
    if (!enabled || !retryDue || retryDocument?.hidden) return;
    clearRetry();
    void manager?.refreshLayer('radiosondes', { signal: lifetime.signal });
  }
  function armRetry(retryAfterSec) {
    clearRetry();
    if (!Number.isFinite(retryAfterSec) || retryAfterSec <= 0) return;
    retryDocument = globalThis.document;
    retryDocument?.addEventListener?.('visibilitychange', onRetryVisibility);
    retryTimer = setTimeoutImpl(
      () => {
        retryTimer = null;
        retryDue = true;
        onRetryVisibility();
      },
      Math.min(retryAfterSec * 1000, policy.RADIOSONDE_BUILDING_RETRY_MAX_MS),
    );
  }
  function selectedCard() {
    if (!enabled || !overlayHost) return false;
    const record = records.get(selected);
    selectedLink = record ? sondeTrackerUrl(record.frame.serial) : null;
    const entries = record
      ? [
          {
            ...buildSelectedSondeCard(
              record.frame,
              selectedTrack,
              now(),
              record.phase,
            ),
            interactive: Boolean(selectedLink && openExternal),
            position: () => rendering.visibleAnchor(record.frame.serial),
          },
        ]
      : [];
    const card = entries[0];
    if (card?.interactive) {
      const link = selectedLink;
      card.accessibilityLabel = t('Open the source for {title}', {
        title: card.title,
      });
      card.activate = () => {
        openExternal(link);
        return true;
      };
    }
    selectedCardId = card?.id ?? null;
    const signature = JSON.stringify(entries);
    if (signature === selectedCardSignature) return false;
    selectedCardSignature = signature;
    overlayHost.setEntries(
      RADIOSONDES_SELECTED_SOURCE_ID,
      entries,
      RADIOSONDES_SELECTED_OPTIONS,
    );
    overlayHost.setVisible?.(RADIOSONDES_SELECTED_SOURCE_ID, true);
    return true;
  }
  function clearSelection() {
    selected = null;
    selectedCardId = selectedLink = null;
    selectedTrack = [];
    selectionRequest?.abort();
    selectionRequest = null;
    removeTrailReady?.();
    removeTrailReady = null;
    trail?.destroy();
    trail = null;
    trailSignature = '';
    trailReadyRevision = -1;
    trailStyle = '';
    trailFrameMs = null;
    selectedCardSignature = '';
    trailDisplay = null;
    rendering?.setTrail(null, []);
    rendering?.setBurst(null);
    overlayHost?.clearSource(RADIOSONDES_SELECTED_SOURCE_ID);
  }
  function updateTrail() {
    if (!enabled || !selected || !trail) return false;
    const record = records.get(selected);
    if (!record) return false;
    const { frame } = record;
    const positions = selectedTrack.map((p) => rendering.position(p));
    const segments = positions
      .slice(1)
      .map((p, i) => ({
        fromSeq: i,
        toSeq: i + 1,
        fromT: selectedTrack[i].timeMs,
        toT: selectedTrack[i + 1].timeMs,
        positions: [positions[i], p],
      }))
      .filter(
        (segment) =>
          Cesium.Cartesian3.distanceSquared(...segment.positions) >
          policy.RADIOSONDE_TRAIL_MIN_SEGMENT_M ** 2,
      );
    const nextStyle =
      transitStyleProfile(style) === 'mono'
        ? policy.RADIOSONDE_MONO_COLOR
        : policy.RADIOSONDE_COLOR;
    let changed = nextStyle !== trailStyle || trailFrameMs !== frame.timeMs;
    if (nextStyle !== trailStyle) trail.setStyle(nextStyle);
    trailStyle = nextStyle;
    trailFrameMs = frame.timeMs;
    const signature = JSON.stringify(positions);
    if (signature !== trailSignature) {
      changed = true;
      removeTrailReady?.();
      removeTrailReady = null;
      trailSignature = signature;
      trail.replaceHistory({ revision: ++trailRevision, segments });
    }
    const display = () =>
      trail?.setDisplaySample(
        {
          displayT: frame.timeMs,
          fromSeq: Math.max(0, positions.length - 2),
          toSeq: positions.length - 1,
          fraction: 1,
        },
        rendering.anchor(selected) ?? positions.at(-1),
      );
    trailDisplay = display;
    display();
    if (
      trail.diagnostics?.().body &&
      !trail.diagnostics().body.ready &&
      !removeTrailReady &&
      trailReadyRevision !== trailRevision
    ) {
      trailReadyRevision = trailRevision;
      const stagingTrail = trail,
        revision = trailRevision;
      let checks = 0;
      removeTrailReady = viewer.scene.postRender?.addEventListener(() => {
        if (!enabled || trail !== stagingTrail || trailRevision !== revision)
          return;
        trailDisplay?.();
        if (!trail.diagnostics().body || trail.diagnostics().body.ready) {
          removeTrailReady?.();
          removeTrailReady = null;
          // Display attributes were just changed after the completed frame.
          render('trail-ready');
        } else if (++checks >= policy.RADIOSONDE_TRAIL_READY_MAX_CHECKS) {
          removeTrailReady?.();
          removeTrailReady = null;
        } else render('trail-staging');
      });
    }
    rendering.setTrail(trail, positions);
    const { burstIndex } = flightPhase(selectedTrack, frame);
    rendering.setBurst(
      isSondeAloft(record.phase) && burstIndex !== null
        ? selectedTrack[burstIndex]
        : null,
    );
    return changed;
  }
  function flushDisplay(force = false) {
    if (!enabled) return;
    const record = records.get(selected);
    if (record) {
      selectedTrack = decimateTrack(
        [...selectedTrack, ...record.track],
        policy.RADIOSONDE_TRAIL_MAX_VERTICES,
      );
    }
    const clock = now();
    for (const record of records.values())
      record.phase = flightPhase(record.track, record.frame, clock).phase;
    const population = rendering.sync(records, selected, force);
    const trailChanged = updateTrail();
    const sceneChanged = force || population.changed || trailChanged;
    if (sceneChanged) {
      rendering.cull();
      rendering.labels(selected);
    }
    const cardChanged = selectedCard();
    if (sceneChanged || cardChanged) render('flush');
    notify();
  }
  function apply(event) {
    if (!enabled) return;
    if (
      event.type === 'snapshot' &&
      lastUpdate !== null &&
      event.fetchedAt !== null &&
      event.fetchedAt < lastUpdate
    )
      return;
    upstream = event.upstream ?? upstream;
    lastFrameMs = event.lastFrameMs ?? lastFrameMs;
    proxyStale = event.stale === true || upstream !== 'live';
    if (event.type === 'status') {
      if (upstream === 'unavailable') {
        clearRetry();
        loading = false;
        error = msg('Live feed unavailable on this server');
      } else if (upstream === 'live') {
        clearRetry();
        error = null;
        loading = false;
      } else if (!records.size) {
        loading = starting() && !error;
        if (!loading) error ??= msg('Weather balloon source unavailable');
      }
      notify();
      return;
    }
    partial = event.partial === true;
    const clock = now();
    const firstData = records.size === 0;
    let changed = false;
    const incoming = new Set();
    for (const raw of event.frames) {
      const frame = normalizeSondeFrame(raw, clock);
      if (!frame) continue;
      incoming.add(frame.serial);
      const previous = records.get(frame.serial);
      if (mergeFrame(previous?.frame, frame) !== frame) continue;
      const track = previous?.track ?? [];
      track.push(trackPoint(frame));
      if (track.length > SONDE_TRACK_MAX_POINTS)
        track.splice(0, track.length - SONDE_TRACK_MAX_POINTS);
      records.set(frame.serial, { frame, track });
      changed = true;
    }
    for (const [serial, record] of records) {
      record.track = record.track.filter(
        (p) => p.timeMs >= clock - SONDE_RETAIN_MS,
      );
      if (
        record.frame.timeMs < clock - SONDE_RETAIN_MS ||
        (event.type === 'snapshot' && !partial && !incoming.has(serial))
      ) {
        records.delete(serial);
        changed = true;
      }
    }
    if (records.size > SONDE_MAX_SERIALS) {
      const oldest = [...records].sort(
        (a, b) => a[1].frame.timeMs - b[1].frame.timeMs,
      );
      for (let i = 0; i < oldest.length - SONDE_MAX_SERIALS; i++)
        records.delete(oldest[i][0]);
      changed = true;
    }
    if (selected && !records.has(selected)) clearSelection();
    observedAt = records.size
      ? Math.max(...[...records.values()].map((r) => r.frame.timeMs))
      : null;
    lastUpdate = event.fetchedAt ?? lastUpdate;
    if (starting()) loading = !error;
    else {
      clearRetry();
      loading = false;
      error =
        upstream === 'unavailable'
          ? msg('Live feed unavailable on this server')
          : null;
      if (!records.size && upstream !== 'live')
        error ??= msg('Weather balloon source unavailable');
    }
    if (changed && (firstData || event.type === 'snapshot'))
      console.log(`[Data:Radiosondes] Updated: ${records.size} balloons`);
    // Fix age changes even when telemetry does not. Geometry/style signatures
    // preserve billboard identities and skip writes for unchanged content.
    flushDisplay();
  }
  function clearBatch() {
    if (batchTimer !== null) clearTimeoutImpl(batchTimer);
    batchTimer = null;
    pendingBatch = null;
    lastBatchMs = -Infinity;
  }
  function flushBatch() {
    batchTimer = null;
    if (!enabled || !pendingBatch) return;
    const { frames, ...metadata } = pendingBatch;
    pendingBatch = null;
    lastBatchMs = now();
    apply({ ...metadata, frames: [...frames.values()] });
  }
  function queuePush(event) {
    if (event.type === 'status') {
      // Feed state is cheap and also releases cold-start retries promptly.
      if (pendingBatch) {
        pendingBatch.upstream = event.upstream ?? pendingBatch.upstream;
        pendingBatch.lastFrameMs =
          event.lastFrameMs ?? pendingBatch.lastFrameMs;
        pendingBatch.stale =
          event.stale === true || pendingBatch.upstream !== 'live';
      }
      apply(event);
      return true;
    }
    const newestBatchMs = pendingBatch?.fetchedAt ?? lastUpdate;
    if (
      event.type === 'snapshot' &&
      newestBatchMs !== null &&
      event.fetchedAt !== null &&
      event.fetchedAt < newestBatchMs
    )
      return false;
    const replaces = event.type === 'snapshot' && event.partial !== true;
    const frames = replaces || !pendingBatch ? new Map() : pendingBatch.frames;
    // A bounded sample adds membership. Later completion metadata must not
    // turn its coalesced delta into an authoritative replacement snapshot.
    const type =
      replaces || pendingBatch?.type === 'snapshot' ? 'snapshot' : 'frames';
    for (const frame of event.frames) {
      const previous = frames.get(frame.serial);
      if (!previous || frame.timeMs > previous.timeMs)
        frames.set(frame.serial, frame);
    }
    // The coalescing buffer has the same bound as the retained feed. Keep the
    // freshest telemetry when a producer temporarily exceeds that contract.
    if (frames.size > SONDE_MAX_SERIALS) {
      const ranked = [...frames.values()].sort(
        (a, b) =>
          (b.serial === selected) - (a.serial === selected) ||
          b.timeMs - a.timeMs,
      );
      frames.clear();
      for (const frame of ranked.slice(0, SONDE_MAX_SERIALS))
        frames.set(frame.serial, frame);
    }
    pendingBatch = { ...event, type, frames };
    if (frames.size) clearRetry();
    if (!records.size && frames.size) {
      if (batchTimer !== null) clearTimeoutImpl(batchTimer);
      flushBatch();
      return true;
    }
    if (batchTimer !== null) return true;
    if (now() - lastBatchMs >= policy.RADIOSONDE_DATA_BATCH_MS) flushBatch();
    else
      batchTimer = setTimeoutImpl(flushBatch, policy.RADIOSONDE_DATA_BATCH_MS);
    return true;
  }
  function select(serial) {
    clearSelection();
    const record = records.get(serial);
    if (!record) return;
    selected = serial;
    trail = (services.createTrailRenderer ?? createContactTrailRenderer)(
      viewer.scene,
      { fade: false, drape: false },
    );
    selectedTrack = record.track.slice();
    flushDisplay();
    services.focus?.requestWorldFocus?.({
      kind: 'radiosonde',
      id: `radiosonde:${serial}`,
      label: t('BALLOON'),
      position: rendering.anchor(serial) ?? rendering.position(record.frame),
    });
    const controller = new AbortController();
    selectionRequest = controller;
    const active = () =>
      enabled &&
      !controller.signal.aborted &&
      selectionRequest === controller &&
      selected === serial;
    void (async () => {
      for (const method of ['getTrack', 'getHistory']) {
        let result;
        try {
          result = await source[method]({ serial, signal: controller.signal });
        } catch {
          if (!active()) return;
          continue;
        }
        if (!active()) return;
        // Retain live points received while history was in flight.
        selectedTrack = decimateTrack(
          [...result.track, ...selectedTrack],
          policy.RADIOSONDE_TRAIL_MAX_VERTICES,
        );
        // Keep recent history with the contact so landing survives deselection
        // and later live fixes. Full history belongs only to the selected path.
        const currentRecord = records.get(serial);
        currentRecord.track = decimateTrack(
          [...result.track, ...currentRecord.track].filter(
            (p) => p.timeMs >= now() - SONDE_RETAIN_MS,
          ),
          SONDE_TRACK_MAX_POINTS,
        );
        flushDisplay();
      }
    })();
  }
  function onVision(event) {
    if (!enabled) return;
    style = event.detail?.style ?? 'normal';
    rendering.setStyle(style);
    flushDisplay(true);
  }
  function disable() {
    enabled = false;
    clearRetry();
    clearBatch();
    lifetime?.abort();
    lifetime = null;
    request?.abort();
    request = null;
    unsubscribe?.();
    unsubscribe = null;
    clearSelection();
    clickHandler?.destroy();
    clickHandler = null;
    removeCamera?.();
    removeCamera = null;
    globalThis.window?.removeEventListener('gev:vision-change', onVision);
    services.picking?.unregisterPickOwner?.('radiosondes');
    services.credits?.hide?.(viewer, policy.RADIOSONDE_CREDIT);
    for (const id of [
      RADIOSONDES_OVERLAY_SOURCE_ID,
      RADIOSONDES_SELECTED_SOURCE_ID,
    ]) {
      overlayHost?.clearSource(id);
      overlayHost?.setVisible?.(id, false);
    }
    rendering?.setEnabled(false);
    records.clear();
    lastUpdate = observedAt = lastFrameMs = null;
    loading = false;
    partial = false;
    error = null;
    streamState = upstream = 'closed';
    render('disable');
  }
  return {
    id: 'radiosondes',
    name: msg('Weather balloons'),
    icon: '🎈',
    source: 'SondeHub',
    updateInterval: policy.RADIOSONDE_UPDATE_INTERVAL_MS,
    attachDataManager(nextManager) {
      manager = nextManager;
    },
    init(nextViewer) {
      if (viewer || destroyed)
        throw new Error('Weather balloons already initialized or destroyed');
      viewer = nextViewer;
      rendering = createRadiosondeRendering({
        viewer,
        services,
        overlayHost,
      });
      console.log('[Data:Radiosondes] Initialized');
    },
    enable() {
      if (!viewer || destroyed)
        throw new Error('Weather balloons require init');
      if (enabled) return;
      enabled = true;
      loading = true;
      error = null;
      lifetime = new AbortController();
      const { signal } = lifetime;
      style = getVisionStyle();
      rendering.setStyle(style);
      rendering.setEnabled(true);
      services.sprites?.restoreSpriteOrder?.(viewer);
      services.credits?.show?.(viewer, policy.RADIOSONDE_CREDIT);
      services.picking?.registerPickOwner?.('radiosondes', (id) =>
        String(id).startsWith('radiosonde:'),
      );
      for (const id of [
        RADIOSONDES_OVERLAY_SOURCE_ID,
        RADIOSONDES_SELECTED_SOURCE_ID,
      ])
        overlayHost?.setVisible?.(id, true);
      if (screenSpaceEventHandlerFactory) {
        clickHandler = screenSpaceEventHandlerFactory(viewer);
        clickHandler.setInputAction((click) => {
          if (!enabled || services.pointer?.isPointerFree?.() === false) return;
          const cardHit = overlayHost?.hitTest?.(
            click.position?.x,
            click.position?.y,
            { sourceId: RADIOSONDES_SELECTED_SOURCE_ID },
          );
          if (cardHit && cardHit.entryId === selectedCardId) {
            if (selectedLink && openExternal) openExternal(selectedLink);
            return;
          }
          const picked = viewer.scene.pick(click.position);
          const id =
            services.picking?.resolvePickId?.(picked) ??
            picked?.id ??
            picked?.primitive?.id;
          if (
            typeof id === 'string' &&
            id.startsWith('radiosonde:') &&
            records.has(id.slice(11))
          ) {
            select(id.slice(11));
            return;
          }
          if (
            picked &&
            services.picking?.isOwnedByOtherLayer?.('radiosondes', id)
          )
            return;
          clearSelection();
          flushDisplay();
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      }
      removeCamera = viewer.camera?.moveEnd?.addEventListener(() => {
        if (!enabled) return;
        rendering.cull();
        rendering.labels(selected);
        render('camera');
      });
      globalThis.window?.addEventListener('gev:vision-change', onVision);
      if (typeof source.subscribe === 'function')
        unsubscribe = source.subscribe(
          (event) => {
            if (!signal.aborted) {
              if (queuePush(event)) pushRevision++;
            }
          },
          (state) => {
            if (!signal.aborted) {
              streamState = state;
              notify();
            }
          },
        );
      if (typeof services.geoid?.ensureGeoidReady === 'function') {
        Promise.resolve(services.geoid.ensureGeoidReady())
          .then(() => {
            if (signal.aborted) return;
            rendering.setGeoidReady();
            flushDisplay(true);
          })
          .catch(() => {
            /* ellipsoid baseline remains usable */
          });
      }
    },
    async update(_viewer, { signal } = {}) {
      if (!enabled) return false;
      // Classify on the clock even if the backstop request fails, is superseded
      // or returns an older snapshot. No additional transmissions are needed.
      flushDisplay();
      if (pendingBatch) return true;
      if (
        streamState === 'open' &&
        lastFrameMs !== null &&
        now() - lastFrameMs < policy.RADIOSONDE_STREAM_FRESH_MS
      ) {
        return true;
      }
      request?.abort();
      const controller = new AbortController();
      request = controller;
      const revision = pushRevision;
      const combined = signal
        ? AbortSignal.any([controller.signal, signal])
        : controller.signal;
      const active = () =>
        enabled && !combined.aborted && request === controller;
      let snapshot;
      try {
        snapshot = await source.getSnapshot({ signal: combined });
      } catch (caught) {
        if (!active()) return false;
        if (revision !== pushRevision) return true;
        clearRetry();
        loading = false;
        proxyStale = false;
        error = caught?.message || msg('Weather balloon source unavailable');
        console.warn('[Data:Radiosondes] Source unavailable');
        flushDisplay();
        return true;
      }
      if (!active()) return false;
      if (snapshot.status === 'building') {
        // Empty startup/status pushes do not replace acquisition. Data or a
        // live/failed status received during this read still takes precedence.
        if (revision !== pushRevision && (!loading || error)) return true;
        loading = true;
        error = null;
        proxyStale = false;
        armRetry(snapshot.retryAfterSec);
        notify();
        return true;
      }
      // Receiver timestamps are data ages, not store revisions. A push event
      // supersedes this HTTP read even when their fetchedAt values are equal.
      if (revision !== pushRevision) return true;
      clearRetry();
      apply({ ...snapshot, type: 'snapshot' });
      return true;
    },
    disable,
    destroy() {
      if (destroyed) return;
      disable();
      rendering?.destroy();
      rendering = null;
      viewer = null;
      destroyed = true;
      rowListener = null;
      manager = null;
    },
    setRowControlsListener(listener) {
      rowListener = typeof listener === 'function' ? listener : null;
    },
    getStats() {
      const clock = now();
      const count = [...records.values()].filter((r) =>
        isSondeAloft(r.phase),
      ).length;
      const stale =
        enabled &&
        !error &&
        (proxyStale ||
          reconnecting() ||
          (count > 0 &&
            observedAt !== null &&
            clock - observedAt > policy.STALE_AFTER_MS));
      const delta = Math.max(0, clock - (lastUpdate ?? clock));
      const age = formatAge(delta);
      const freshAge =
        delta < 60_000
          ? t('<1m ago')
          : delta < 90 * 60_000
            ? t('{count}m ago', {
                count: formatNumber(Math.floor(delta / 60_000)),
              })
            : t('{count}h ago', {
                count: formatNumber(Math.round(delta / 3600000)),
              });
      const empty =
        upstream === 'live' && records.size === 0 && !error && !partial;
      return {
        count,
        lastUpdate,
        observedAt,
        loading: loading && !error,
        partial,
        stale,
        error,
        loadingLabel:
          loading && !error
            ? t('loading...')
            : error || lastUpdate === null
              ? ''
              : stale
                ? t('STALE · cached {age}', { age })
                : t('LIVE · updated {age}', { age: freshAge }),
        ...(empty
          ? {
              status: 'empty',
              statusMessage: msg(
                'None aloft — launches are around 00:00 and 12:00 UTC',
              ),
            }
          : {}),
      };
    },
    getRowControls() {
      const counts = {
        ascending: 0,
        descending: 0,
        unknown: 0,
        landed: 0,
        'signal-lost': 0,
      };
      for (const { phase } of records.values())
        counts[isSondeLanded(phase) ? 'landed' : phase]++;
      const legendEntry = (phase, label) => ({
        label,
        count: counts[phase],
        color: policy.RADIOSONDE_SYMBOLS[phase].color,
      });
      return {
        chips: [],
        legend: [
          legendEntry('ascending', t('Ascending')),
          legendEntry('descending', t('Descending')),
          ...(counts.unknown
            ? [legendEntry('unknown', t('Aloft (direction unknown)'))]
            : []),
          legendEntry('landed', t('Landed')),
          legendEntry('signal-lost', t('Signal lost')),
        ],
        info:
          upstream === 'unavailable'
            ? t('Live feed unavailable on this server')
            : error || upstream !== 'live' || reconnecting()
              ? t('Reconnecting to SondeHub…')
              : records.size === 0
                ? t('None aloft — launches are around 00:00 and 12:00 UTC')
                : launchWindowText(now()),
      };
    },
  };
}
