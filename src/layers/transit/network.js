import * as Cesium from 'cesium';
import {
  activeAlertsByRoute,
  alertCardLines,
  decodePolyline,
  hasDisruption,
  isDisruption,
} from '../../data/transitNetwork.js';
import { TRANSIT_MODE_ICON } from '../../data/transitFeeds.js';

/** How often an active feed's alert list is re-read (the proxy caches 60 s). */
export const NETWORK_ALERTS_REFRESH_MS = 60_000;
/**
 * An alert list older than this is still shown, but labelled with its age:
 * the proxy serves its last good copy for up to half an hour during an outage,
 * and "no alerts" from twenty minutes ago is not "no alerts now".
 */
export const NETWORK_ALERTS_AGED_MS = 5 * 60_000;
/** First retry after a failed network load; doubles to the ceiling. */
export const NETWORK_RETRY_BASE_MS = 15_000;
export const NETWORK_RETRY_MAX_MS = 5 * 60_000;
/** How often an in-progress line build is checked for readiness. */
const BUILD_POLL_MS = 200;
/** Give up holding frames for a build after this long. */
const BUILD_HOLD_MAX_MS = 20_000;

/** Pick-id prefix for route lines. Vehicle keys never start with it. */
export const TRANSIT_ROUTE_PICK_PREFIX = 'transit-route:';

/**
 * Line weight per mode. Rapid transit is drawn heavy and opaque so it reads
 * as the backbone; buses are thin and translucent, because 150 bus routes at
 * full weight would bury both the trains and the vehicles riding on them.
 */
export const ROUTE_LINE_STYLE = Object.freeze({
  subway: Object.freeze({ width: 4.5, alpha: 0.95 }),
  tram: Object.freeze({ width: 4, alpha: 0.95 }),
  rail: Object.freeze({ width: 3, alpha: 0.85 }),
  ferry: Object.freeze({ width: 2.5, alpha: 0.8 }),
  bus: Object.freeze({ width: 1.6, alpha: 0.5 }),
  unknown: Object.freeze({ width: 1.6, alpha: 0.5 }),
});
/** Fallback colour when an operator publishes none. */
const DEFAULT_ROUTE_COLOR = '#8A8F98';
/**
 * Dashes drawn over a disrupted route. Magenta, because no MBTA line uses it:
 * an amber "caution" dash vanished into the yellow of every bus route and the
 * Orange Line, which is exactly where it needs to be seen.
 */
export const DISRUPTION_COLOR = '#FF2D95';
/**
 * Barely wider than the route itself, so a disrupted bus route does not out-
 * weigh a healthy subway line; the dash gaps let the route colour through.
 */
const DISRUPTION_EXTRA_WIDTH_PX = 1.5;

/**
 * Pick id for one route of one feed. Feed ids cannot contain '/', so the
 * first '/' after the prefix always separates the two.
 * @param {string} feedId
 * @param {string} routeId
 * @returns {string}
 */
export function transitRoutePickId(feedId, routeId) {
  return `${TRANSIT_ROUTE_PICK_PREFIX}${feedId}/${routeId}`;
}

/**
 * Inverse of {@link transitRoutePickId}; null for anything else.
 * @param {unknown} id
 * @returns {{feedId: string, routeId: string}|null}
 */
export function parseTransitRoutePickId(id) {
  if (typeof id !== 'string' || !id.startsWith(TRANSIT_ROUTE_PICK_PREFIX))
    return null;
  const rest = id.slice(TRANSIT_ROUTE_PICK_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { feedId: rest.slice(0, slash), routeId: rest.slice(slash + 1) };
}

/**
 * Next retry delay after `failures` consecutive failures, honouring a server
 * `retryInSec` when it asks for longer.
 * @param {number} failures
 * @param {number|null} retryInSec
 * @returns {number}
 */
export function networkRetryDelayMs(failures, retryInSec = null) {
  const exponent = Math.max(0, Math.min(10, (failures || 1) - 1));
  const backoff = Math.min(
    NETWORK_RETRY_MAX_MS,
    NETWORK_RETRY_BASE_MS * 2 ** exponent,
  );
  const asked = Number.isFinite(retryInSec) ? retryInSec * 1000 : 0;
  return Math.min(NETWORK_RETRY_MAX_MS, Math.max(backoff, asked));
}

/**
 * Route lines and service alerts for the feeds that publish them.
 *
 * Owns, per feed: the route catalog (loaded once, kept across disable so a
 * re-enable redraws without asking again), the alert list (re-read every
 * minute while the feed is active), and up to three ground primitives — bus
 * lines, rail lines drawn over them, and a dashed amber outline over every
 * route with a disruption in force. Lines are only in the scene while their
 * feed is active, which is the same camera gate the vehicles use.
 *
 * @param {object} context
 * @returns {object}
 */
export function createNetwork({ state, services, parts, source }) {
  const {
    governorRequestRender,
    holdContinuousRender,
    releaseContinuousRender,
  } = services.render;
  const available = typeof source?.requestNetwork === 'function';
  let supported = null;
  let buildTimer = null;
  let buildHeldSince = null;

  function scene() {
    return state._viewer?.scene || null;
  }

  function netFor(feed) {
    let net = state._network.get(feed.id);
    if (!net) {
      net = {
        feedId: feed.id,
        feed,
        routes: null,
        routeIndex: new Map(),
        routesFailures: 0,
        routesRetryAt: 0,
        routesController: null,
        alerts: null,
        alertsReceivedAt: null,
        alertsFailures: 0,
        alertsRetryAt: 0,
        alertsController: null,
        byRoute: new Map(),
        disruptedSignature: '',
        busPrimitive: null,
        railPrimitive: null,
        disruptionPrimitive: null,
        shown: false,
        error: null,
      };
      state._network.set(feed.id, net);
    }
    return net;
  }

  function linesSupported() {
    const s = scene();
    if (!s) return false;
    if (supported === null) {
      try {
        supported = Cesium.GroundPolylinePrimitive.isSupported(s);
      } catch {
        supported = false;
      }
      if (!supported)
        console.warn(
          '[Data:Transit] Ground polylines unsupported — route lines disabled, alerts still shown on cards',
        );
    }
    return supported;
  }

  function removePrimitive(primitive) {
    if (!primitive) return;
    const collection = scene()?.groundPrimitives;
    try {
      if (collection?.contains(primitive)) collection.remove(primitive);
      else if (!primitive.isDestroyed?.()) primitive.destroy?.();
    } catch {
      /* the scene may already be torn down */
    }
  }

  /** Keep frames flowing while a primitive builds on the workers. */
  function watchBuilds() {
    if (buildTimer) return;
    buildHeldSince = Date.now();
    holdContinuousRender?.('transit-network');
    buildTimer = setInterval(() => {
      let pending = false;
      for (const net of state._network.values()) {
        for (const p of [
          net.busPrimitive,
          net.railPrimitive,
          net.disruptionPrimitive,
        ]) {
          if (p && !p.isDestroyed?.() && p.ready !== true) pending = true;
        }
      }
      if (!pending || Date.now() - buildHeldSince > BUILD_HOLD_MAX_MS) {
        stopWatchingBuilds();
        governorRequestRender('transit-network-ready');
      }
    }, BUILD_POLL_MS);
  }

  function stopWatchingBuilds() {
    if (!buildTimer) return;
    clearInterval(buildTimer);
    buildTimer = null;
    buildHeldSince = null;
    releaseContinuousRender?.('transit-network');
  }

  /**
   * Geometry instances for a set of routes, one per shape. Shapes that fail to
   * decode are skipped — the server already validated them, so this only
   * guards against a payload that was altered on the way.
   */
  function instancesFor(feedId, routes, styleFor) {
    const instances = [];
    for (const route of routes) {
      const style = styleFor(route);
      if (!style) continue;
      for (const encoded of route.shapes || []) {
        const points = decodePolyline(encoded);
        if (!points) continue;
        const flat = new Array(points.length * 2);
        for (let i = 0; i < points.length; i += 1) {
          flat[i * 2] = points[i][1];
          flat[i * 2 + 1] = points[i][0];
        }
        instances.push(
          new Cesium.GeometryInstance({
            id: transitRoutePickId(feedId, route.id),
            geometry: new Cesium.GroundPolylineGeometry({
              positions: Cesium.Cartesian3.fromDegreesArray(flat),
              width: style.width,
            }),
            attributes: style.color
              ? {
                  color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                    style.color,
                  ),
                }
              : undefined,
          }),
        );
      }
    }
    return instances;
  }

  function colorPrimitive(instances) {
    if (instances.length === 0) return null;
    return new Cesium.GroundPolylinePrimitive({
      geometryInstances: instances,
      appearance: new Cesium.PolylineColorAppearance(),
      // BOTH: drape on terrain (Esri/OSM stacks) and on photoreal 3D tiles
      // alike, so a map-stack switch never strands the lines.
      classificationType: Cesium.ClassificationType.BOTH,
      asynchronous: true,
    });
  }

  function routeLineStyle(route) {
    const style = ROUTE_LINE_STYLE[route.mode] || ROUTE_LINE_STYLE.unknown;
    const color = Cesium.Color.fromCssColorString(
      route.color || DEFAULT_ROUTE_COLOR,
    ).withAlpha(style.alpha);
    return { width: style.width, color };
  }

  /** Draw a feed's route lines. Idempotent: a feed already drawn is left alone. */
  function showLines(net) {
    if (net.shown || !net.routes || !linesSupported()) return;
    const s = scene();
    if (!s?.groundPrimitives) return;
    const routes = net.routes.routes || [];
    const buses = routes.filter(
      (r) => r.mode === 'bus' || r.mode === 'unknown',
    );
    const rail = routes.filter((r) => r.mode !== 'bus' && r.mode !== 'unknown');
    // Buses first so the rail primitive, added after, draws over them.
    net.busPrimitive = colorPrimitive(
      instancesFor(net.feedId, buses, routeLineStyle),
    );
    if (net.busPrimitive) s.groundPrimitives.add(net.busPrimitive);
    net.railPrimitive = colorPrimitive(
      instancesFor(net.feedId, rail, routeLineStyle),
    );
    if (net.railPrimitive) s.groundPrimitives.add(net.railPrimitive);
    net.shown = true;
    net.disruptedSignature = '';
    refreshDisruptions(net);
    watchBuilds();
    governorRequestRender('transit-network');
  }

  function hideLines(net) {
    removePrimitive(net.disruptionPrimitive);
    removePrimitive(net.railPrimitive);
    removePrimitive(net.busPrimitive);
    net.disruptionPrimitive = null;
    net.railPrimitive = null;
    net.busPrimitive = null;
    net.disruptedSignature = '';
    if (net.shown) governorRequestRender('transit-network-hide');
    net.shown = false;
  }

  /**
   * Rebuild the dashed outline when — and only when — the SET of disrupted
   * routes changes. Alerts are re-read every minute and usually say the same
   * thing, and rebuilding ground geometry each time would cost a worker pass
   * for nothing.
   */
  function refreshDisruptions(net) {
    if (!net.shown || !net.routes) return;
    const disrupted = [];
    for (const route of net.routes.routes || []) {
      if (hasDisruption(net.byRoute.get(route.id))) disrupted.push(route);
    }
    const signature = disrupted.map((r) => r.id).join('\u0000');
    if (signature === net.disruptedSignature) return;
    net.disruptedSignature = signature;
    removePrimitive(net.disruptionPrimitive);
    net.disruptionPrimitive = null;
    if (disrupted.length === 0) {
      governorRequestRender('transit-network-alerts');
      return;
    }
    const instances = instancesFor(net.feedId, disrupted, (route) => {
      const style = ROUTE_LINE_STYLE[route.mode] || ROUTE_LINE_STYLE.unknown;
      return { width: style.width + DISRUPTION_EXTRA_WIDTH_PX, color: null };
    });
    if (instances.length === 0) return;
    net.disruptionPrimitive = new Cesium.GroundPolylinePrimitive({
      geometryInstances: instances,
      appearance: new Cesium.PolylineMaterialAppearance({
        material: Cesium.Material.fromType('PolylineDash', {
          color:
            Cesium.Color.fromCssColorString(DISRUPTION_COLOR).withAlpha(0.95),
          gapColor: Cesium.Color.TRANSPARENT,
          dashLength: 12,
        }),
      }),
      classificationType: Cesium.ClassificationType.BOTH,
      asynchronous: true,
    });
    scene()?.groundPrimitives?.add(net.disruptionPrimitive);
    watchBuilds();
    governorRequestRender('transit-network-alerts');
  }

  /** Re-derive which alerts are in force now; periods start and end silently. */
  function reindexAlerts(net, nowMs) {
    net.byRoute = net.alerts
      ? activeAlertsByRoute(net.alerts.alerts || [], Math.floor(nowMs / 1000))
      : new Map();
    refreshDisruptions(net);
  }

  async function loadRoutes(net) {
    if (net.routesController) return;
    const controller = new AbortController();
    net.routesController = controller;
    try {
      const body = await source.requestNetwork('routes', net.feedId, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!Array.isArray(body?.routes))
        throw new Error('route catalog malformed');
      net.routes = body;
      net.routeIndex = new Map(body.routes.map((route) => [route.id, route]));
      net.routesFailures = 0;
      net.error = null;
      if (state._enabled && state._activeFeeds.has(net.feedId)) showLines(net);
      parts.selection?.refreshSelectedCard(true);
      state._dataManager?.refreshLayerStats?.();
    } catch (error) {
      if (controller.signal.aborted) return;
      net.routesFailures += 1;
      net.routesRetryAt =
        Date.now() + networkRetryDelayMs(net.routesFailures, error?.retryInSec);
      net.error = 'routes unavailable';
      console.warn(
        `[Data:Transit] ${net.feedId} routes unavailable: ${error?.message || error}`,
      );
    } finally {
      if (net.routesController === controller) net.routesController = null;
    }
  }

  async function loadAlerts(net) {
    if (net.alertsController) return;
    const controller = new AbortController();
    net.alertsController = controller;
    try {
      const body = await source.requestNetwork('alerts', net.feedId, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!Array.isArray(body?.alerts)) throw new Error('alert list malformed');
      net.alerts = body;
      net.alertsReceivedAt = Date.now();
      net.alertsFailures = 0;
      reindexAlerts(net, Date.now());
      parts.selection?.refreshSelectedCard(true);
      state._dataManager?.refreshLayerStats?.();
    } catch (error) {
      if (controller.signal.aborted) return;
      net.alertsFailures += 1;
      net.alertsRetryAt =
        Date.now() + networkRetryDelayMs(net.alertsFailures, error?.retryInSec);
      console.warn(
        `[Data:Transit] ${net.feedId} alerts unavailable: ${error?.message || error}`,
      );
    } finally {
      if (net.alertsController === controller) net.alertsController = null;
    }
  }

  /**
   * Bring every feed's network presentation in line with what is active.
   * Called on the manager tick and after every proximity check.
   * @param {number} [nowMs=Date.now()]
   */
  function sync(nowMs = Date.now()) {
    if (!available || !state._enabled) return;
    for (const net of state._network.values()) {
      if (!state._activeFeeds.has(net.feedId)) {
        net.routesController?.abort();
        net.alertsController?.abort();
        hideLines(net);
      }
    }
    for (const feed of state._activeFeeds.values()) {
      if (!feed?.network) continue;
      const net = netFor(feed);
      if (feed.network.routesUrl) {
        if (net.routes) showLines(net);
        else if (!net.routesController && nowMs >= net.routesRetryAt)
          void loadRoutes(net);
      }
      if (feed.network.alertsUrl) {
        const due =
          !net.alertsReceivedAt ||
          nowMs - net.alertsReceivedAt >= NETWORK_ALERTS_REFRESH_MS;
        if (due && !net.alertsController && nowMs >= net.alertsRetryAt)
          void loadAlerts(net);
        else reindexAlerts(net, nowMs);
      }
    }
  }

  /** Remove every line and stop every request; keep the loaded data. */
  function clear() {
    for (const net of state._network.values()) {
      net.routesController?.abort();
      net.alertsController?.abort();
      hideLines(net);
    }
    stopWatchingBuilds();
  }

  /** Remove everything, data included. */
  function destroy() {
    clear();
    state._network.clear();
    supported = null;
  }

  function isRoutePick(id) {
    const parsed = parseTransitRoutePickId(id);
    return Boolean(
      parsed &&
      state._network.get(parsed.feedId)?.routeIndex.has(parsed.routeId),
    );
  }

  function routeFor(feedId, routeId) {
    if (!routeId) return null;
    return state._network.get(feedId)?.routeIndex.get(routeId) || null;
  }

  function alertsFor(feedId, routeId) {
    if (!routeId) return [];
    return state._network.get(feedId)?.byRoute.get(routeId) || [];
  }

  /** "Alerts as of 12 min ago" when the list is old enough to say so. */
  function alertsAgeLine(feedId, nowMs) {
    const net = state._network.get(feedId);
    const at = Number(net?.alerts?.fetchedAt);
    if (!Number.isFinite(at)) return null;
    const age = nowMs - at;
    if (age < NETWORK_ALERTS_AGED_MS) return null;
    return `Alerts as of ${Math.round(age / 60_000)} min ago`;
  }

  /**
   * Extra card text for a selected vehicle: the route's human name, and the
   * alerts in force on its route.
   * @returns {{routeName: string|null, description: string|null, lines: string[]}}
   */
  function vehicleCardExtras(feedId, routeId, nowMs = Date.now()) {
    const route = routeFor(feedId, routeId);
    const net = state._network.get(feedId);
    const lines = alertCardLines(alertsFor(feedId, routeId));
    const aged = lines.length ? alertsAgeLine(feedId, nowMs) : null;
    if (aged) lines.push(aged);
    return {
      routeName: route?.name || null,
      description:
        route && route.mode === 'bus' && route.longName ? route.longName : null,
      lines,
      alertsKnown: Boolean(net?.alerts),
    };
  }

  /**
   * Card copy for a clicked route line.
   * @returns {{title: string, details: string[], accent: string}|null}
   */
  function routeCardCopy(feedId, routeId, nowMs = Date.now()) {
    const route = routeFor(feedId, routeId);
    const net = state._network.get(feedId);
    if (!route || !net) return null;
    const icon = TRANSIT_MODE_ICON[route.mode] || TRANSIT_MODE_ICON.unknown;
    const details = [];
    if (route.mode === 'bus' && route.longName) details.push(route.longName);
    const modeWord =
      {
        subway: 'Subway',
        tram: 'Light rail',
        rail: 'Commuter rail',
        ferry: 'Ferry',
        bus: 'Bus',
      }[route.mode] || 'Transit';
    details.push(`${modeWord} route · ${net.feed.name} · ${net.feed.region}`);
    const alerts = alertsFor(feedId, routeId);
    if (!net.alerts) details.push('Service alerts loading…');
    else if (alerts.length === 0) details.push('No service alerts in force');
    else {
      // Station-access alerts alone say nothing about the trains, so the card
      // says so rather than leaving the reader to infer it from an absence.
      if (!alerts.some((alert) => alert.kind === 'service'))
        details.push('No service disruptions');
      details.push(...alertCardLines(alerts, 4));
    }
    const aged = net.alerts ? alertsAgeLine(feedId, nowMs) : null;
    if (aged) details.push(aged);
    details.push('Typical route shown · detours are not drawn');
    return {
      title: `${icon} ${route.name}`,
      details,
      accent: route.color || DEFAULT_ROUTE_COLOR,
    };
  }

  /**
   * One line for the layer row, e.g. "12 routes disrupted", or null when this
   * feed has no network data yet.
   */
  function statsLine(feedId) {
    const net = state._network.get(feedId);
    if (!net?.alerts) return null;
    let disrupted = 0;
    for (const [routeId, alerts] of net.byRoute) {
      if (net.routeIndex.size && !net.routeIndex.has(routeId)) continue;
      if (alerts.some(isDisruption)) disrupted += 1;
    }
    return disrupted === 0
      ? 'no disruptions'
      : `${disrupted} route${disrupted === 1 ? '' : 's'} disrupted`;
  }

  /** Test/QA view of what this part holds. */
  function snapshot() {
    return [...state._network.values()].map((net) => ({
      feedId: net.feedId,
      routes: net.routes?.routes?.length ?? 0,
      alerts: net.alerts?.alerts?.length ?? 0,
      alertRoutes: net.byRoute.size,
      disrupted: net.disruptedSignature
        ? net.disruptedSignature.split('\u0000').length
        : 0,
      shown: net.shown,
      primitivesReady: [
        net.busPrimitive,
        net.railPrimitive,
        net.disruptionPrimitive,
      ]
        .filter(Boolean)
        .every((p) => p.ready === true),
      error: net.error,
    }));
  }

  return {
    available,
    sync,
    clear,
    destroy,
    isRoutePick,
    routeFor,
    alertsFor,
    vehicleCardExtras,
    routeCardCopy,
    statsLine,
    snapshot,
  };
}
