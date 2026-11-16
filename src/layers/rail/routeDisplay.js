import { drawOf } from '../../render/rendererOf.js';
import { cssColor } from '../../render/color.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { distance } from '../../geo/vector.js';
import { classifyTrain, getRegisteredRailFeed } from '../../data/railFeeds.js';
import {
  FEED_RELEASE_AFTER_MS,
  NETWORK_ALPHA,
  NETWORK_FULL_BELOW_M,
  NETWORK_HIDDEN_ABOVE_M,
  NETWORK_SELECTED_DIM,
  NETWORK_WIDTH_PX,
  RAIL_CATEGORY_COLORS,
  ROUTE_AHEAD_WIDTH_PX,
  ROUTE_SPLIT_INTERVAL_MS,
  ROUTE_TRAVELLED_ALPHA,
  STOP_REFRESH_MS,
} from './policy.js';
import {
  networkAltitudeFade,
  railNetworkLineSteps,
  splitFraction,
} from './routeLines.js';
import {
  RAIL_STOP_OVERLAY_SOURCE_ID,
  RAIL_STOP_OVERLAY_SOURCE_OPTIONS,
  createStopOverlayEntries,
  selectStopLabels,
} from './stopLabels.js';

/** Longest slice of network building per task, so a frame is never held (ms). */
const NETWORK_SLICE_MS = 6;
/** The fade is applied in steps, so a slow zoom does not rewrite it per event. */
const FADE_STEP = 0.05;
/** A split that moved less than this share of the line is not redrawn. */
const SPLIT_EPSILON = 1e-5;
/** The selected line's dark rim, which keeps it legible over bright
 *  imagery: the outer 28% of its width at 22% of its colour. */
const ROUTE_RIM = Object.freeze({ shade: 0.22, widthFraction: 0.28 });
/** Arc a route-bound train must cover before its direction is trusted (m). */
const DIRECTION_EVIDENCE_M = 60;
const STOP_DOT_PX = 5;
const STOP_LABELLED_DOT_PX = 8;
const STOP_DOT_OUTLINE = Object.freeze(cssColor('rgba(10, 14, 20, 0.9)'));
/** Two drawn vertices closer than this are one (m), as the line drops repeats. */
const REPEAT_M = 1e-3;

/** Layers built so far, so each one's draw sets have ids of their own. */
let instances = 0;

/** A category's colour (0..1 channels) at `alpha`. */
function categoryColor(category, alpha) {
  const rgba =
    cssColor(RAIL_CATEGORY_COLORS[category] || RAIL_CATEGORY_COLORS.local) ||
    cssColor(RAIL_CATEGORY_COLORS.local);
  return [rgba[0], rgba[1], rgba[2], alpha];
}

/**
 * Route lines for one Rail layer: the faint network of every active feed
 * (built once per path pack), the selected train's line split where the train
 * is, and the selected trip's stops as dots and labels.
 *
 * Every line is draped on the surface through the draw port: each feed's
 * network a set per category, the selected line one set whose segments are
 * coloured travelled or ahead, and the stops a set of dots.
 *
 * Nothing here runs per frame but the far-side test of the stops. The
 * network's opacity follows the camera on camera events; the split and the
 * stops follow the train on a timer that only runs while a train is
 * selected.
 *
 * @param {object} context
 * @returns {object}
 */
export function createRouteDisplay({
  state,
  services,
  parts,
  stops,
  timetable,
}) {
  const { governorRequestRender } = services.render;
  const instance = (instances += 1);
  /** feedId → when the feed was last seen in use (ms). */
  const feedSeenAt = new Map();
  /** Releases idle feeds while the layer is off. */
  let releaseTimer = null;
  /** The selected line's set and the stop dots' set, made on first use. */
  let routeSet = null;
  /** Route sets made, for ids of their own. */
  let routeBuilds = 0;
  let stopSet = null;
  /** The stop dots drawn now, as pushed to their set. */
  let stopItems = [];
  let timer = null;
  let ticks = 0;

  /** The draw port, or null while the layer has no viewer. */
  function draw() {
    const viewer = state._viewer;
    return viewer && !viewer.isDestroyed?.() ? drawOf(viewer) : null;
  }

  /** ECEF positions on the ellipsoid for a flat `[lat, lon, ...]` run, repeats dropped. */
  function positionsOf(coords) {
    const out = [];
    for (let i = 0; i + 1 < coords.length; i += 2) {
      const point = fromDegrees(coords[i + 1], coords[i], 0);
      if (out.length && distance(out[out.length - 1], point) < REPEAT_M)
        continue;
      out.push(point);
    }
    return out;
  }

  /** A set of draped lines, never picked. */
  function lineSet(id) {
    return draw()?.lines({ id, pickable: false, show: false }) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Network

  /**
   * Start building a feed's network from its decoded pack, in slices between
   * frames. Called once per pack by ingestion.
   * @param {string} feedId
   * @param {object} raw The pack's JSON body.
   */
  function buildNetwork(feedId, raw) {
    const previous = state._networks.get(feedId);
    if (previous) dropNetwork(feedId);
    const feed = getRegisteredRailFeed(feedId);
    const categoryOf = (routeId) =>
      feed ? classifyTrain(feed, routeId)?.category || null : null;
    const network = {
      feedId,
      status: 'building',
      steps: railNetworkLineSteps(raw, categoryOf),
      timer: null,
      layers: new Map(),
      stats: null,
    };
    state._networks.set(feedId, network);
    const slice = () => {
      network.timer = null;
      if (state._networks.get(feedId) !== network) return;
      const started = performance.now();
      for (;;) {
        const next = network.steps.next();
        if (next.done) {
          network.steps = null;
          finishNetwork(network, next.value);
          return;
        }
        if (performance.now() - started > NETWORK_SLICE_MS) break;
      }
      network.timer = setTimeout(slice, 0);
    };
    network.timer = setTimeout(slice, 0);
  }

  function finishNetwork(network, result) {
    network.status = 'ready';
    network.stats = {
      shapes: result.shapesIn,
      pointsIn: result.pointsIn,
      lines: result.lines.length,
      points: result.pointsOut,
    };
    if (!draw()) return;
    const byCategory = new Map();
    for (const line of result.lines) {
      if (!byCategory.has(line.category)) byCategory.set(line.category, []);
      byCategory.get(line.category).push(positionsOf(line.coords));
    }
    for (const [category, runs] of byCategory) {
      const style = { kind: 'solid', color: categoryColor(category, 0) };
      const items = [];
      for (const positions of runs) {
        if (positions.length < 2) continue;
        items.push({
          id: String(items.length),
          positions,
          widthPx: NETWORK_WIDTH_PX,
          mode: 'draped',
          style,
          pickable: false,
        });
      }
      if (!items.length) continue;
      const set = lineSet(
        `rail:${instance}:network:${network.feedId}:${category}`,
      );
      if (!set) continue;
      set.set(items);
      network.layers.set(category, { set, items, category, alpha: -1 });
    }
    applyNetwork();
  }

  function dropNetwork(feedId) {
    const network = state._networks.get(feedId);
    if (!network) return;
    clearTimeout(network.timer);
    network.timer = null;
    network.steps = null;
    for (const layer of network.layers.values()) layer.set.dispose();
    network.layers.clear();
    state._networks.delete(feedId);
  }

  /**
   * Show each feed's network while the feed is active, the category is on and
   * the camera is low enough, at an opacity set by altitude and selection.
   */
  function applyNetwork() {
    const fade = state._networkFade;
    const selected = state._selectedKey !== null;
    let changed = false;
    for (const network of state._networks.values()) {
      // A feed held only for the selected train shows that train's line alone.
      const active =
        state._enabled &&
        state._activeFeeds.has(network.feedId) &&
        network.feedId !== state._heldFeedId;
      for (const [category, layer] of network.layers) {
        const alpha =
          active && state._categories[category] !== false
            ? NETWORK_ALPHA * fade * (selected ? NETWORK_SELECTED_DIM : 1)
            : 0;
        const show = alpha > 0.001;
        if (layer.set.show !== show) {
          layer.set.show = show;
          changed = true;
        }
        if (show && Math.abs(layer.alpha - alpha) > 0.001) {
          const style = {
            kind: 'solid',
            color: categoryColor(layer.category, alpha),
          };
          for (const item of layer.items) item.style = style;
          layer.set.upsert(layer.items);
          layer.alpha = alpha;
          changed = true;
        }
      }
    }
    if (changed) governorRequestRender('rail-network');
  }

  /** Camera moved: recompute the altitude fade, applying it only on a step. */
  function onCamera() {
    const altitude = parts.viewport.cameraAltitude();
    const raw = networkAltitudeFade(
      altitude,
      NETWORK_FULL_BELOW_M,
      NETWORK_HIDDEN_ABOVE_M,
    );
    const fade = Math.round(raw / FADE_STEP) * FADE_STEP;
    if (fade === state._networkFade) return;
    state._networkFade = fade;
    applyNetwork();
  }

  // ---------------------------------------------------------------------------
  // Selected route

  /**
   * The shape the selected train runs on: its binding, else its route's
   * longest.
   */
  function routeShapeFor(entry) {
    const pack = state._pathPacks.get(entry.feedId)?.pack;
    if (entry.path?.path)
      return {
        shapeIndex: entry.path.shapeIndex,
        path: entry.path.path,
        binding: entry.path,
      };
    const routeId = entry.record?.routeId;
    if (!pack || !routeId) return null;
    let best = null;
    for (const index of pack.shapesForRoute(routeId)) {
      const path = pack.pathAt(index);
      if (path && (!best || path.length > best.path.length))
        best = { shapeIndex: index, path, binding: null };
    }
    return best;
  }

  function dropRoute() {
    if (!state._route) return;
    // Let the set go: the next route's is made anew, on top of every line
    // drawn before it (a feed's network loaded since), as each route's
    // primitive was added when it was drawn.
    routeSet?.dispose();
    routeSet = null;
    state._route = null;
  }

  /**
   * Draw (or keep) the selected train's line. Rebuilt only when the train
   * moves to another shape; the split recolours its segments.
   */
  function syncRoute() {
    const entry = state._trains.get(state._selectedKey);
    const shape = entry && state._enabled ? routeShapeFor(entry) : null;
    const port = shape ? draw() : null;
    if (!shape || !port) {
      if (state._route) {
        dropRoute();
        governorRequestRender('rail-route');
      }
      return;
    }
    const id = `${entry.key}\n${entry.feedId}\n${shape.shapeIndex}`;
    if (state._route?.id !== id) {
      dropRoute();
      const { path } = shape;
      const positions = [];
      // The cumulative drawn length per path vertex, which the split's
      // fraction is measured on: metres on the ground, as a draped line's
      // texture runs; one per vertex where the scene draws it over the
      // surface instead, as a polyline's does.
      const ground = port.clampState?.() !== 'overlay';
      const chordAt = new Float64Array(path.n);
      for (let i = 0; i < path.n; i++) {
        const point = fromDegrees(path.lon[i], path.lat[i], 0);
        const last = positions[positions.length - 1];
        const step = last ? distance(last, point) : 0;
        const repeat = last && step < REPEAT_M;
        if (i > 0)
          chordAt[i] = chordAt[i - 1] + (repeat ? 0 : ground ? step : 1);
        if (!repeat) positions.push(point);
      }
      if (positions.length < 2) return;
      routeSet ||= lineSet(`rail:${instance}:route:${++routeBuilds}`);
      if (!routeSet) return;
      routeSet.show = true;
      // Solid ahead of the train, dimmer behind, split where it is.
      const item = {
        id: 'route',
        positions,
        widthPx: ROUTE_AHEAD_WIDTH_PX,
        mode: 'draped',
        style: {
          kind: 'split',
          color: categoryColor(entry.category, 1),
          behind: categoryColor(entry.category, ROUTE_TRAVELLED_ALPHA),
          at: -1,
          rim: ROUTE_RIM,
        },
        pickable: false,
      };
      routeSet.set([item]);
      state._route = {
        id,
        item,
        path,
        chordAt,
        ground,
        binding: shape.binding,
        // A trip's own shape runs the way the trip does; a route's shape may
        // be drawn either way, so its direction is learnt from the train.
        direction: shape.binding?.via === 'trip' ? 1 : 0,
        firstS: shape.binding ? shape.binding.drawS : NaN,
        fraction: NaN,
      };
      governorRequestRender('rail-route');
    } else if (state._route.binding !== shape.binding) {
      // Rebound to the same shape (a new trip on it): follow the new binding.
      state._route.binding = shape.binding;
      state._route.firstS = shape.binding ? shape.binding.drawS : NaN;
      if (shape.binding?.via !== 'trip') state._route.direction = 0;
    }
    updateSplit();
  }

  /**
   * Show the selected line unless a first-person view rides its train
   * (cockpitSubject.js): from inside the train it would run up the middle of
   * the view and under the eye.
   */
  function applyHold() {
    if (!state._route || !routeSet) return;
    const shown = !(
      state._cockpitSubjectKey !== null &&
      state._cockpitSubjectKey === state._selectedKey
    );
    if (routeSet.show !== shown) {
      routeSet.show = shown;
      governorRequestRender('rail-route');
    }
  }

  /** Move the travelled/ahead split to where the train is drawn now. */
  function updateSplit() {
    const route = state._route;
    if (!route) return;
    applyHold();
    const binding = route.binding;
    const s = binding ? binding.drawS : NaN;
    if (route.direction === 0 && Number.isFinite(s)) {
      const moved = s - route.firstS;
      if (Math.abs(moved) >= DIRECTION_EVIDENCE_M)
        route.direction = Math.sign(moved);
    }
    const fraction =
      route.direction !== 0 && Number.isFinite(s)
        ? splitFraction(route.path, route.chordAt, s)
        : NaN;
    const style = route.item.style;
    if (!Number.isFinite(fraction)) {
      // No position on the line yet: draw it all as ahead.
      route.fraction = NaN;
      if (style.at === -1 && !style.reverse) return;
    } else {
      const reverse = route.direction < 0;
      if (
        Number.isFinite(route.fraction) &&
        Math.abs(fraction - route.fraction) < SPLIT_EPSILON &&
        Boolean(style.reverse) === reverse
      )
        return;
      route.fraction = fraction;
    }
    const at = Number.isFinite(fraction) ? fraction : -1;
    route.item = {
      ...route.item,
      style: { ...style, at, reverse: at >= 0 && route.direction < 0 },
    };
    routeSet?.upsert([route.item]);
    governorRequestRender('rail-route-split');
  }

  // ---------------------------------------------------------------------------
  // Stops

  function stopDots() {
    stopSet ||=
      draw()?.points({
        id: `rail:${instance}:stops`,
        blend: 'translucent',
        pickable: false,
      }) ?? null;
    return stopSet;
  }

  function clearStops() {
    stopItems = [];
    stopSet?.clear();
    state._trip = null;
    state._stopsSignature = '';
    state._stopLabelsSignature = '';
    state._stopAnchors.clear();
    state._overlayHost.setEntries(
      RAIL_STOP_OVERLAY_SOURCE_ID,
      [],
      RAIL_STOP_OVERLAY_SOURCE_OPTIONS,
    );
  }

  function anchorFor(stop) {
    const key = `${stop.stopId ?? ''}\n${stop.lat}\n${stop.lon}`;
    let anchor = state._stopAnchors.get(key);
    if (!anchor) {
      const { h, q } = parts.rendering.stopHeight(stop.lat, stop.lon);
      anchor = {
        lat: stop.lat,
        lon: stop.lon,
        h,
        q,
        position: fromDegrees(stop.lon, stop.lat, h),
      };
      state._stopAnchors.set(key, anchor);
    }
    return anchor.position;
  }

  /**
   * Stops placed before their floor cell was warm stand on a fallback (the
   * ellipsoid at worst, which is drawn over the terrain far off its station
   * from a low camera): each refresh reads those again, and once one stands
   * better its dot and label are drawn again there.
   */
  function settleAnchors() {
    let moved = false;
    for (const anchor of state._stopAnchors.values()) {
      if (anchor.q >= 2) continue;
      const { h, q } = parts.rendering.stopHeight(anchor.lat, anchor.lon);
      if (q < anchor.q || (q === anchor.q && Math.abs(h - anchor.h) < 1))
        continue;
      anchor.h = h;
      anchor.q = q;
      anchor.position = fromDegrees(anchor.lon, anchor.lat, h);
      moved = true;
    }
    if (moved) {
      state._stopsSignature = '';
      state._stopLabelsSignature = '';
    }
  }

  /**
   * Hide the stop dots on the far side of the Earth. They are drawn over the
   * terrain, and the selected trip is drawn at any distance (viewport.js), so
   * the rendering pass hands over its horizon test every frame.
   * @param {(position: object) => boolean} facesCamera
   */
  function cullStops(facesCamera) {
    if (!stopSet || !stopItems.length) return;
    let changed = null;
    for (const item of stopItems) {
      const shown = facesCamera(item.pos);
      if (item.show === shown) continue;
      item.show = shown;
      (changed ||= []).push(item);
    }
    if (changed) stopSet.upsert(changed);
  }

  /** Ask the provider for the selected trip's stops and redraw what changed. */
  function refreshStops() {
    const entry = state._trains.get(state._selectedKey);
    if (!entry || !state._enabled || typeof stops?.stopsFor !== 'function') {
      if (state._trip || state._stopsSignature) clearStops();
      return;
    }
    let trip = null;
    try {
      trip = stops.stopsFor(
        {
          feedId: entry.feedId,
          tripId: entry.record?.tripId || null,
          routeId: entry.record?.routeId || null,
          record: entry.record,
        },
        Date.now(),
      );
    } catch (error) {
      console.warn('[Data:Rail] stops unavailable:', error?.message || error);
    }
    const list = Array.isArray(trip?.stops) ? trip.stops : [];
    state._trip = list.length || trip?.headsign ? trip : null;
    settleAnchors();
    const { labels, dots } = selectStopLabels(list);
    const color = categoryColor(entry.category, 1);
    const passedColor = categoryColor(entry.category, 0.45);

    const signature = `${entry.key}|${labels.map((l) => l.index).join(',')}|${dots
      .map((d) => `${d.index}${d.passed ? 'p' : ''}`)
      .join(',')}`;
    if (signature !== state._stopsSignature) {
      state._stopsSignature = signature;
      const points = stopDots();
      if (points) {
        const items = [];
        const add = (stop, passed, size) =>
          items.push({
            id: String(items.length),
            pos: anchorFor(stop),
            pixelSize: size,
            color: passed ? passedColor : color,
            outlineColor: STOP_DOT_OUTLINE,
            outlineWidth: 1.5,
            disableDepthTest: Infinity,
            show: true,
          });
        for (const dot of dots) add(dot.stop, dot.passed, STOP_DOT_PX);
        for (const label of labels)
          add(label.stop, label.stop.state === 'passed', STOP_LABELLED_DOT_PX);
        stopItems = items;
        points.set(items);
      }
      governorRequestRender('rail-stops');
    }

    const entries = createStopOverlayEntries(entry.key, labels, anchorFor);
    const text = JSON.stringify(
      entries.map((item) => [item.id, item.title, item.details, item.accent]),
    );
    if (text !== state._stopLabelsSignature) {
      state._stopLabelsSignature = text;
      state._overlayHost.setEntries(
        RAIL_STOP_OVERLAY_SOURCE_ID,
        entries,
        RAIL_STOP_OVERLAY_SOURCE_OPTIONS,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Selection ticker

  function tick() {
    if (globalThis.document?.visibilityState === 'hidden') return;
    if (!state._enabled || !state._selectedKey) {
      stopTicker();
      return;
    }
    ticks += 1;
    syncRoute();
    if ((ticks * ROUTE_SPLIT_INTERVAL_MS) % STOP_REFRESH_MS === 0) {
      refreshStops();
      parts.selection.refreshSelectedCard(false);
    }
  }

  function startTicker() {
    if (timer) return;
    ticks = 0;
    timer = setInterval(tick, ROUTE_SPLIT_INTERVAL_MS);
  }

  function stopTicker() {
    clearInterval(timer);
    timer = null;
  }

  /** A train was selected, or the selection was cleared. */
  function onSelectionChanged() {
    state._stopAnchors.clear();
    state._stopsSignature = '';
    state._stopLabelsSignature = '';
    const entry = state._enabled ? state._trains.get(state._selectedKey) : null;
    // The provider loads the feed's timetable and polls its delays while a
    // train on it is selected.
    stops?.onSelect?.(
      entry
        ? {
            feedId: entry.feedId,
            tripId: entry.record?.tripId || null,
            routeId: entry.record?.routeId || null,
            record: entry.record,
          }
        : null,
    );
    if (state._selectedKey && state._enabled) {
      syncRoute();
      refreshStops();
      startTicker();
    } else {
      stopTicker();
      dropRoute();
      clearStops();
    }
    applyNetwork();
    governorRequestRender('rail-route');
  }

  /**
   * Give back what a feed out of use for FEED_RELEASE_AFTER_MS holds: its
   * faint network, its path pack and its parsed timetable. A feed in use
   * (polled, or held for the selected train) keeps everything; a pack still
   * loading is left to finish. Called on each poll tick, and once more while
   * the layer is off.
   * @param {number} nowMs
   */
  function releaseIdleFeeds(nowMs) {
    for (const feedId of state._activeFeeds.keys())
      feedSeenAt.set(feedId, nowMs);
    const held = new Set([
      ...state._networks.keys(),
      ...state._pathPacks.keys(),
      ...feedSeenAt.keys(),
    ]);
    for (const feedId of held) {
      if (state._activeFeeds.has(feedId)) continue;
      const seen = feedSeenAt.get(feedId);
      if (seen === undefined) {
        feedSeenAt.set(feedId, nowMs);
        continue;
      }
      if (nowMs - seen < FEED_RELEASE_AFTER_MS) continue;
      if (state._pathPacks.get(feedId)?.status === 'loading') continue;
      dropNetwork(feedId);
      state._pathPacks.delete(feedId);
      timetable?.forget?.(feedId);
      feedSeenAt.delete(feedId);
    }
  }

  /**
   * Layer disabled: hide everything. Built networks stay for a quick return,
   * and are released once they have been out of use FEED_RELEASE_AFTER_MS.
   */
  function hideAll() {
    stops?.onSelect?.(null);
    stopTicker();
    dropRoute();
    clearStops();
    applyNetwork();
    releaseIdleFeeds(Date.now());
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => {
      releaseTimer = null;
      releaseIdleFeeds(Date.now());
    }, FEED_RELEASE_AFTER_MS);
  }

  function destroy() {
    hideAll();
    clearTimeout(releaseTimer);
    releaseTimer = null;
    feedSeenAt.clear();
    for (const feedId of [...state._networks.keys()]) dropNetwork(feedId);
    routeSet?.dispose();
    routeSet = null;
    stopSet?.dispose();
    stopSet = null;
    stopItems = [];
    state._overlayHost.clearSource(RAIL_STOP_OVERLAY_SOURCE_ID);
  }

  /** Counts for QA and the testing surface. */
  function stats() {
    const feeds = {};
    for (const [feedId, network] of state._networks) {
      feeds[feedId] = {
        status: network.status,
        primitives: network.layers.size,
        shown: [...network.layers.values()].filter((l) => l.set.show).length,
        ...(network.stats || {}),
      };
    }
    return {
      fade: state._networkFade,
      feeds,
      route: state._route
        ? {
            id: state._route.id,
            vertices: state._route.path.n,
            fraction: state._route.fraction,
            direction: state._route.direction,
            ground: state._route.ground,
          }
        : null,
      stops: {
        points: stopItems.length,
        trip: state._trip ? state._trip.stops?.length || 0 : 0,
      },
    };
  }

  return {
    buildNetwork,
    dropNetwork,
    applyNetwork,
    onCamera,
    syncRoute,
    applyHold,
    refreshStops,
    cullStops,
    onSelectionChanged,
    hideAll,
    releaseIdleFeeds,
    destroy,
    stats,
  };
}
