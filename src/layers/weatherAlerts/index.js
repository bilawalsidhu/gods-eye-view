import * as Cesium from 'cesium';

const SEVERITY = Object.freeze({
  Extreme: { color: '#e33b35', label: 'Extreme' },
  Severe: { color: '#ed7d31', label: 'Severe' },
  Moderate: { color: '#e6c229', label: 'Moderate' },
  Minor: { color: '#4aa3df', label: 'Minor' },
  Unknown: { color: '#9aa3a8', label: 'Unknown' },
});
const reduceMotion = (matchMedia) =>
  Boolean(matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);

/** One CAP-backed NWS warning layer with polygon selection and panel readout. */
export function createWeatherAlertsLayer({
  feed,
  cesium = Cesium,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
} = {}) {
  if (typeof feed?.getSnapshot !== 'function')
    throw new TypeError('Weather alerts require a snapshot source');
  let viewer = null;
  let source = null;
  let snapshot = null;
  let selectedId = null;
  let request = null;
  let listener = null;
  let runNavigation = null;
  let enabled = false;
  let loading = false;
  let error = null;
  let destroyed = false;
  const notify = () => listener?.();
  const selected = () =>
    snapshot?.alerts.find((item) => item.id === selectedId) || null;
  const position = ([longitude, latitude]) =>
    cesium.Cartesian3.fromDegrees(longitude, latitude, 0);
  const alertPositions = (alert) =>
    alert.geometries.flatMap((geometry) => {
      const polygons =
        geometry.type === 'Polygon'
          ? [geometry.coordinates]
          : geometry.coordinates;
      return polygons.flatMap((rings) => rings[0].map(position));
    });
  const clearEntities = () => {
    if (source && !viewer?.isDestroyed?.()) source.entities.removeAll();
  };
  function render() {
    if (!source || viewer?.isDestroyed?.()) return;
    source.entities.removeAll();
    for (const alert of snapshot?.alerts || []) {
      const severity = SEVERITY[alert.severity] || SEVERITY.Unknown;
      const color = cesium.Color.fromCssColorString(severity.color);
      for (const [geometryIndex, geometry] of alert.geometries.entries()) {
        const polygons =
          geometry.type === 'Polygon'
            ? [geometry.coordinates]
            : geometry.coordinates;
        polygons.forEach((rings, polygonIndex) => {
          const exterior = rings[0].map(position);
          const holes = rings
            .slice(1)
            .map((ring) => new cesium.PolygonHierarchy(ring.map(position)));
          const active = alert.id === selectedId;
          source.entities.add({
            id: `weather-alert:${alert.id}:${geometryIndex}:${polygonIndex}`,
            name: alert.headline,
            description: `${alert.event} · ${alert.severity}`,
            polygon: {
              hierarchy: new cesium.PolygonHierarchy(exterior, holes),
              classificationType: cesium.ClassificationType.BOTH,
              material: color.withAlpha(active ? 0.42 : 0.2),
              outline: true,
              outlineColor: color.withAlpha(active ? 1 : 0.82),
              outlineWidth: active ? 3 : 1.5,
              arcType: cesium.ArcType.GEODESIC,
            },
          });
        });
      }
    }
    viewer.scene.requestRender?.();
  }
  const layer = {
    id: 'weather-alerts',
    name: 'Weather alerts',
    icon: '!',
    source: 'NOAA NWS / CAP',
    updateInterval: 60_000,
    init(nextViewer) {
      viewer = nextViewer;
      source = new cesium.CustomDataSource('weather-alerts');
      viewer.dataSources.add(source);
    },
    attachShellServices(services) {
      runNavigation =
        typeof services?.runNavigation === 'function'
          ? services.runNavigation
          : null;
    },
    enable() {
      if (!destroyed) enabled = true;
    },
    disable() {
      enabled = false;
      request?.abort();
      request = null;
      loading = false;
      snapshot = null;
      selectedId = null;
      error = null;
      clearEntities();
      notify();
    },
    async update(_viewer, { signal } = {}) {
      if (!enabled || destroyed) return false;
      request?.abort();
      const controller = new AbortController();
      if (signal?.aborted) controller.abort(signal.reason);
      request = controller;
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      loading = true;
      notify();
      try {
        signal?.throwIfAborted();
        const next = await feed.getSnapshot({ signal: controller.signal });
        if (!enabled || controller.signal.aborted || request !== controller)
          return false;
        snapshot = next;
        error = null;
        if (!snapshot.alerts.some((item) => item.id === selectedId))
          selectedId = snapshot.alerts[0]?.id || null;
        render();
        return true;
      } catch (cause) {
        if (controller.signal.aborted || request !== controller) return false;
        error = cause?.message || 'Weather alerts unavailable';
        snapshot = null;
        selectedId = null;
        clearEntities();
        return true;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (request === controller) {
          request = null;
          loading = false;
          notify();
        }
      }
    },
    setParams(params = {}) {
      if (!enabled || destroyed) return;
      if (params.clear === true || params.alertId === null) {
        selectedId = null;
        render();
        notify();
        return;
      }
      if (
        typeof params.alertId === 'string' &&
        snapshot?.alerts.some((item) => item.id === params.alertId)
      ) {
        selectedId = params.alertId;
        render();
        notify();
      }
      const alert = selected();
      if (params.focus === true && alert && runNavigation) {
        const positions = alertPositions(alert);
        if (positions.length) {
          const sphere = cesium.BoundingSphere.fromPoints(positions);
          sphere.radius = Math.max(sphere.radius, 30_000);
          runNavigation(() =>
            viewer.camera.flyToBoundingSphere(sphere, {
              duration: reduceMotion(matchMedia) ? 0 : 1.2,
            }),
          );
        }
      }
    },
    getRowControls() {
      const active = snapshot?.alerts || [];
      const alert = selected();
      const detail = `${active.length} active warning${active.length === 1 ? '' : 's'}`;
      const status = error || (loading ? 'Loading NWS alerts…' : null);
      const counts = Object.fromEntries(
        Object.keys(SEVERITY).map((name) => [
          name,
          active.filter((item) => item.severity === name).length,
        ]),
      );
      return {
        readout: true,
        summary: {
          label: 'Alerts · NOAA NWS',
          coverage: 'United States',
          detail: alert
            ? `${alert.event} · ${alert.areas
                .map((area) => area.description)
                .filter(Boolean)
                .slice(0, 2)
                .join(', ')}`
            : detail,
          compact: alert ? `${active.length} active · ${alert.event}` : detail,
          status:
            status ||
            (active.length ? null : snapshot ? 'No active warnings' : null),
          lines: alert
            ? [
                {
                  id: 'area',
                  text:
                    alert.areas
                      .map((area) => area.description)
                      .filter(Boolean)
                      .slice(0, 3)
                      .join(' · ') || 'Area details unavailable',
                },
                {
                  id: 'valid',
                  text: `Expires ${alert.expires ? new Date(alert.expires).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'at issuer discretion'}`,
                },
                ...(alert.description
                  ? [{ id: 'description', text: alert.description }]
                  : []),
                ...(alert.instruction
                  ? [{ id: 'instruction', text: alert.instruction }]
                  : []),
              ]
            : [],
          units: '',
        },
        list: {
          ariaLabel: 'Active NOAA weather alerts',
          items: active.map((item, index) => ({
            id: item.id,
            ordinal: index + 1,
            lead: item.severity,
            text: `${item.event} · ${
              item.areas
                .map((area) => area.description)
                .filter(Boolean)
                .slice(0, 1)
                .join('') || 'Area unavailable'
            }`,
            active: item.id === selectedId,
            params: { alertId: item.id, focus: true },
          })),
        },
        legend: Object.entries(SEVERITY).map(([name, item]) => ({
          label: `${item.label}${counts[name] ? ` · ${counts[name]}` : ''}`,
          color: item.color,
        })),
        info: alert
          ? `${alert.headline}\n${alert.event} · ${alert.severity}\n${alert.areas
              .map((area) => area.description)
              .filter(Boolean)
              .join(
                ', ',
              )}\nExpires ${alert.expires || 'at issuer discretion'}\n${alert.description}\n${alert.instruction}`
          : `${detail}${status ? `\n${status}` : ''}`,
        infoTitle:
          'Select an active alert to highlight its warning area and move the camera. NOAA NWS alerts are advisory context; follow official emergency instructions.',
      };
    },
    setRowControlsListener(value) {
      listener = typeof value === 'function' ? value : null;
    },
    getStats() {
      return {
        count: snapshot?.alerts.length || 0,
        loading,
        error,
        source: 'NOAA NWS / CAP',
        empty: Boolean(snapshot && !snapshot.alerts.length),
      };
    },
    destroy() {
      if (destroyed) return;
      this.disable();
      destroyed = true;
      if (source && viewer && !viewer.isDestroyed?.())
        viewer.dataSources.remove(source, true);
      source = null;
      viewer = null;
      listener = null;
      runNavigation = null;
    },
  };
  return layer;
}
