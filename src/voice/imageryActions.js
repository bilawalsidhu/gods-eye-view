/**
 * `find_imagery`: search the Recent Imagery layer's own catalog for an area,
 * pick the best acquisition and show it through the layer's own selection
 * (the pinned day in IMAGE mode), so the panel, the map and the answer agree.
 *
 * The area is an area handle's bounding box, the current view, or a 10 km box
 * around a point. "This spot" arrives as that point: the runner resolves the
 * `'pointer'` sentinel through the turn's pointer snapshot (deixis.js), with
 * the same freshness and session rules as every other pointing tool. The
 * layer's box limits apply unchanged: a box it refuses is refused here with
 * the layer's own reason.
 *
 * The panel is the operator's. Voice owns it only from its own box until its
 * pin shows; any hand change in between (box, pins, sources or mode) ends the
 * request without touching the panel again.
 *
 * @module voice/imageryActions
 */

import { PRODUCTS, rankLatest } from '../layers/recentImagery/model.js';
import {
  displacedLayerResult,
  watchExplicitLayerOff,
} from './layerActionOwnership.js';

const LAYER_ID = 'recent-imagery';
/** How long the catalog search may take before the answer says "still searching". */
const SEARCH_WAIT_MS = 20_000;
/** How long to wait for the chosen day's pixels before answering anyway. */
const DRAPE_WAIT_MS = 8_000;
const DAY_MS = 86_400_000;

const round = (value) => Math.round(value);
/** Identity of a selection box, for telling ours from the operator's. */
const boxKey = (box) =>
  box
    ? ['west', 'south', 'east', 'north']
        .map((edge) => Number(box[edge]).toFixed(6))
        .join(',')
    : '';
/**
 * Identity of everything the operator can change on the panel: box, both
 * pins, sources and mode. Voice records it after each of its own changes;
 * any other difference means the operator took the panel back.
 */
export function panelOwnershipKey(snapshot) {
  return JSON.stringify([
    snapshot?.enabled ?? null,
    boxKey(snapshot?.box),
    snapshot?.pins?.a?.key ?? null,
    snapshot?.pins?.b?.key ?? null,
    snapshot?.mode ?? null,
    snapshot?.sources ?? null,
  ]);
}

/**
 * Parse `dateRange` into epoch-ms bounds. Accepts `{from, to}` ISO dates or
 * `{days}` (the last N days).
 * @returns {{from: number, to: number}|null|{error: string}}
 */
export function imageryDateRange(dateRange, now = Date.now()) {
  if (!dateRange || typeof dateRange !== 'object') return null;
  if (Number.isFinite(Number(dateRange.days)) && Number(dateRange.days) > 0)
    return { from: now - Number(dateRange.days) * DAY_MS, to: now };
  const from = dateRange.from ? Date.parse(dateRange.from) : -Infinity;
  // A bare end date means the whole of that day.
  const to = dateRange.to
    ? Date.parse(dateRange.to) +
      (/^\d{4}-\d{2}-\d{2}$/.test(dateRange.to) ? DAY_MS - 1 : 0)
    : now;
  if (Number.isNaN(from) || Number.isNaN(to))
    return { error: 'dateRange needs ISO dates (YYYY-MM-DD) or days.' };
  return { from, to };
}

/**
 * The candidates that satisfy the filters, ranked by the layer's own rule
 * (coverage, then clear sky, then newest).
 * @param {Array<object>} candidates Layer snapshot candidates.
 * @param {{from?: number, to?: number, maxCloudPct?: number|null, truncated?: boolean}} filters
 */
export function selectImagery(
  candidates,
  {
    from = -Infinity,
    to = Infinity,
    maxCloudPct = null,
    truncated = false,
  } = {},
) {
  // Compared as UTC days: an acquisition belongs to the day it was taken.
  const dayOf = (ms) =>
    Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
  const first = dayOf(from);
  const last = dayOf(to);
  const inRange = (candidate) =>
    (!first || candidate.day >= first) && (!last || candidate.day <= last);
  const cloudOk = (candidate) =>
    maxCloudPct === null ||
    PRODUCTS[candidate.product]?.overview ||
    (candidate.cloud && candidate.cloud.max <= maxCloudPct);
  const eligible = (candidates || []).filter(
    (c) => c.availability !== 'empty' && inRange(c) && cloudOk(c),
  );
  const ranked = rankLatest(eligible, {
    maxCloud: maxCloudPct ?? undefined,
    truncated,
  });
  return { eligible, best: ranked.candidate, reason: ranked.reason };
}

/** Wait until `test(snapshot)` holds, the time runs out, or the turn is superseded. */
function waitFor(layer, test, { timeoutMs, isCurrent }) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    let unsubscribe = () => {};
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      unsubscribe();
      resolve(value);
    };
    const check = () => {
      if (!isCurrent()) return finish('cancelled');
      const snapshot = layer.getSnapshot();
      if (test(snapshot)) finish('ready');
    };
    unsubscribe = layer.subscribe?.(check) || (() => {});
    const poll = setInterval(check, 250);
    timer = setTimeout(() => finish('timeout'), timeoutMs);
    check();
  });
}

/**
 * Run one `find_imagery` call.
 * @param {object} deps
 * @param {object} deps.dataManager
 * @param {object} deps.viewer
 * @param {(areaId: string) => object|null} deps.getArea Stored area by id.
 * @param {(enabled: boolean) => Promise<object>} deps.enableLayer set_layer_visibility for the layer.
 * @param {(step: string, label?: string) => void} [deps.progress] Step reports.
 * @param {object} args Tool arguments; `center` ({lat, lon}) is the resolved
 *   pointer, never a model argument.
 * @param {{isCurrent?: () => boolean, signal?: AbortSignal}} [options]
 */
export async function findImagery(
  {
    dataManager,
    viewer,
    getArea,
    enableLayer,
    progress = () => {},
    now = () => Date.now(),
  },
  args = {},
  { isCurrent = () => true, signal = null } = {},
) {
  const fail = (code, error, extra = {}) => ({
    ok: false,
    action: 'find_imagery',
    code,
    error,
    ...extra,
  });
  const current = () => !signal?.aborted && isCurrent();
  const layer = dataManager?.layers?.get(LAYER_ID)?.module;
  if (!layer?.setBox || !layer?.getSnapshot)
    return fail(
      'LAYER_UNAVAILABLE',
      'The Recent Imagery layer is not available.',
    );

  const range = imageryDateRange(args.dateRange, now());
  if (range?.error) return fail('BAD_VALUE', range.error);
  const maxCloudPct =
    args.maxCloudPct === undefined || args.maxCloudPct === null
      ? null
      : Math.max(0, Math.min(100, Number(args.maxCloudPct)));
  if (maxCloudPct !== null && !Number.isFinite(maxCloudPct))
    return fail('BAD_VALUE', 'maxCloudPct must be 0–100.');

  // The area, resolved before anything changes on screen.
  const center =
    Number.isFinite(args.center?.lat) && Number.isFinite(args.center?.lon)
      ? { lat: args.center.lat, lon: args.center.lon }
      : null;
  const where = args.areaId ? 'area' : center ? 'point' : 'view';
  // An unresolved sentinel never searches the view in its place.
  if (!args.areaId && !center && args.area === 'pointer')
    return fail('NO_POINTER', 'Point at the spot on the map first.');
  let box = null;
  let areaName = null;
  if (where === 'area') {
    const record = getArea(args.areaId);
    if (!record)
      return fail(
        'AREA_UNKNOWN',
        `No area "${args.areaId}" on this page — call resolve_area again.`,
      );
    const [west, south, east, north] = record.bbox;
    if (west > east)
      return fail(
        'DATELINE',
        `${record.name} crosses the date line; the imagery box needs one side of it.`,
      );
    // 30 m pixels over a landmark-sized area show a handful of blobs: a small
    // area gets the layer's own 10 km box around its centre instead.
    const small =
      (north - south) * 111 < 5 &&
      (east - west) * 111 * Math.cos((((north + south) / 2) * Math.PI) / 180) <
        5;
    box = small
      ? { pin: { lon: (west + east) / 2, lat: (south + north) / 2 } }
      : { west, south, east, north };
    areaName = record.name;
  } else if (where === 'point') {
    box = { pin: center };
    areaName = args.centerLabel
      ? String(args.centerLabel)
      : 'the spot under the pointer';
  }

  if (!current())
    return fail('CANCELLED', 'This request was superseded.', {
      cancelled: true,
    });

  const offWatch = watchExplicitLayerOff(dataManager, LAYER_ID);
  let stopCallerAbort = () => {};
  const displaced = () =>
    offWatch.requested()
      ? displacedLayerResult(
          dataManager,
          LAYER_ID,
          'find_imagery',
          'Recent Imagery was turned off while I searched, so I left it off and discarded the result.',
        )
      : fail(
          'DISPLACED',
          'The imagery panel was changed by hand while I searched, so I left it as it is.',
          { cancelled: true, ...(areaName ? { area: areaName } : {}) },
        );
  try {
    if (!dataManager.isEnabled?.(LAYER_ID)) {
      const enabled = await enableLayer(true);
      if (offWatch.requested()) return displaced();
      if (!current())
        return fail('CANCELLED', 'This request was superseded.', {
          cancelled: true,
        });
      if (enabled?.ok === false)
        return fail(
          'LAYER_OFF',
          enabled.error || 'Recent Imagery could not be turned on.',
        );
    }

    const sources =
      args.source === 'hls'
        ? { hls: true, viirs: false }
        : args.source === 'viirs'
          ? { hls: false, viirs: true }
          : args.source === 'any'
            ? { hls: true, viirs: true }
            : { hls: true };
    layer.setSources(sources);
    layer.setMode?.('image');

    const accepted = box?.pin
      ? layer.boxFromPinAt(box.pin.lon, box.pin.lat)
      : box
        ? layer.setBox(box)
        : layer.useCurrentView(viewer);
    if (!accepted) {
      const reason =
        layer.getSnapshot().boxError || 'That area cannot be searched.';
      return fail('BOX_REFUSED', `${reason}. Zoom in or pick a smaller area.`, {
        ...(areaName ? { area: areaName } : {}),
      });
    }

    // This request owns the panel state it just set. The operator can take
    // the panel back at any moment (a new box, CLEAR, a pin, a source or mode
    // switch); from then on it is theirs and this request stops without
    // touching it. Checked in every wait and before every write.
    let owned = panelOwnershipKey(layer.getSnapshot());
    const isOurs = (snap) =>
      !offWatch.requested() && panelOwnershipKey(snap) === owned;
    const cancelOwnedSearch = () => {
      if (isOurs(layer.getSnapshot())) layer.cancelPendingSearch?.();
    };
    signal?.addEventListener?.('abort', cancelOwnedSearch, { once: true });
    stopCallerAbort = () =>
      signal?.removeEventListener?.('abort', cancelOwnedSearch);
    if (signal?.aborted) cancelOwnedSearch();
    progress('catalog', areaName || 'the view');

    const searched = await waitFor(
      layer,
      (snap) => !snap.searching || !isOurs(snap),
      { timeoutMs: SEARCH_WAIT_MS, isCurrent: current },
    );
    if (searched === 'cancelled')
      return fail('CANCELLED', 'This request was superseded.', {
        cancelled: true,
      });
    let snapshot = layer.getSnapshot();
    if (!isOurs(snapshot)) return displaced();
    if (searched === 'timeout' || snapshot.searching)
      return fail(
        'SEARCH_TIMEOUT',
        'The imagery catalog is slow — the panel will fill in when it answers.',
      );
    if (snapshot.error && !snapshot.candidates.length)
      return fail('CATALOG_UNAVAILABLE', snapshot.error);

    const { eligible, best } = selectImagery(snapshot.candidates, {
      ...(range || {}),
      maxCloudPct,
      truncated: snapshot.notes?.some((note) => /truncated/i.test(note)),
    });
    const windowNote = 'the catalog covers the last 30 days';
    if (!best) {
      return {
        ok: true,
        action: 'find_imagery',
        count: 0,
        total: snapshot.candidates.length,
        shown: null,
        say: `No imagery matches${maxCloudPct !== null ? ` under ${maxCloudPct}% cloud` : ''} — ${windowNote}.`,
        display: { window: windowNote },
      };
    }

    // Re-checked at the commit: the candidate list must still be this box's.
    if (!current())
      return fail('CANCELLED', 'This request was superseded.', {
        cancelled: true,
      });
    if (!isOurs(layer.getSnapshot())) return displaced();
    const pinned =
      layer.setAssignment('a', best.key) ||
      layer.getSnapshot().pins?.a?.key === best.key;
    owned = panelOwnershipKey(layer.getSnapshot());
    if (!pinned)
      return fail(
        'PIN_REJECTED',
        `The ${best.day} acquisition could not be shown — it has no pixels over this area.`,
      );
    const pinIsOurs = (snap) => isOurs(snap) && snap.pins?.a?.key === best.key;
    progress('drape', best.day);
    const draped = await waitFor(
      layer,
      (snap) => snap.shown?.a === best.key || !pinIsOurs(snap),
      { timeoutMs: DRAPE_WAIT_MS, isCurrent: current },
    );
    if (draped === 'cancelled')
      return fail('CANCELLED', 'This request was superseded.', {
        cancelled: true,
      });
    snapshot = layer.getSnapshot();
    // A pin the operator replaced, or the layer dropped as empty, is not "still
    // loading" — it is not ours any more.
    if (!pinIsOurs(snapshot)) return displaced();
    const onMap = snapshot.shown?.a === best.key;
    const product = PRODUCTS[best.product];
    const cloudPct = best.cloud ? round(best.cloud.max) : null;
    // The catalog stops at its record cap; say so rather than imply it is all.
    const capped = snapshot.notes?.find((note) => /truncated/i.test(note));
    const date = best.timeRange?.start || best.day;
    return {
      ok: true,
      action: 'find_imagery',
      count: eligible.length,
      total: snapshot.candidates.length,
      shown: {
        date: best.day,
        source: product?.name || best.product,
        resolutionM: product?.resolutionM ?? null,
        cloudPct,
        onMap,
      },
      ...(areaName ? { area: areaName } : {}),
      say: `${product?.name || best.product} from ${best.day}${cloudPct !== null ? `, ${cloudPct}% cloud` : ''}${onMap ? '' : ' — still loading'}`,
      display: {
        acquired: date,
        window: windowNote,
        ...(capped ? { caveat: capped } : {}),
        ...(snapshot.pins?.a?.label ? { label: snapshot.pins.a.label } : {}),
      },
    };
  } finally {
    stopCallerAbort();
    offWatch.stop();
  }
}
