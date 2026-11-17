import { fromDegrees } from '../../geo/ellipsoid.js';
import { drawOf, findCamera, findFrame } from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
import { filterPorts } from './source.js';

const ICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="12" fill="#051d2b" stroke="#4fd1c5" stroke-width="2"/><path d="M16 7v16M10 13h12M8 18q8 12 16 0" fill="none" stroke="#4fd1c5" stroke-width="2"/></svg>',
  );
let instances = 0;

/** Own a keyless port reference layer. UI publication and data source are injected. */
export function createPortsLayer({
  source,
  publish = () => {},
  input = inputFor,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Ports require a snapshot source');
  let viewer, markers, offClick, request, snapshot, selected, error;
  let enabled = false;
  let destroyed = false;
  let country = '',
    facility = '';
  const shown = () => filterPorts(snapshot?.rows || [], { country, facility });
  function present() {
    publish(
      enabled
        ? {
            country,
            facility,
            countries: [
              ...new Set(
                (snapshot?.rows || []).map((r) => r.country).filter(Boolean),
              ),
            ].sort(),
            rows: shown().map(({ id, name }) => ({ id, name })),
            total: snapshot?.rows.length || 0,
            selected: selected || null,
            loading: Boolean(request),
            error: error || null,
            fetchedAt: snapshot?.fetchedAt || null,
            sourceUpdatedAt: snapshot?.sourceUpdatedAt || null,
            partial: snapshot?.partial || false,
            excluded: (snapshot?.rejected || 0) + (snapshot?.duplicates || 0),
          }
        : null,
    );
  }
  function render() {
    if (!markers) return;
    const rows = shown();
    if (selected && !rows.some((r) => r.id === selected.id)) selected = null;
    markers.set(
      rows.map((row) => ({
        id: `port:${row.id}`,
        pos: fromDegrees(row.lon, row.lat),
        image: ICON,
        size: [22, 22],
        height: 'clampGround',
        disableDepthTest: Infinity,
      })),
    );
    findFrame(viewer)?.requestRender('ports');
    present();
  }
  function select(id, fly = false) {
    selected = shown().find((r) => r.id === id) || null;
    if (selected && fly)
      findCamera(viewer)?.flyTo(
        {
          lon: selected.lon,
          lat: selected.lat,
          height: 120000,
        },
        {
          durationS: 1,
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        },
      );
    present();
  }
  const layer = {
    id: 'world-ports',
    name: 'Ports & terminals',
    icon: '⚓',
    source: 'NGA WPI · DOE NETL mirror',
    updateInterval: 86400000,
    init(next) {
      if (viewer || destroyed)
        throw new Error('Ports layer cannot be initialized again');
      viewer = next;
      markers = drawOf(viewer).icons({
        id: `ports:${++instances}`,
        show: false,
        horizonCull: true,
      });
    },
    enable() {
      if (destroyed) return;
      enabled = true;
      if (markers) markers.show = true;
      offClick ||= input(viewer)?.onClick((event) => {
        const hit = event.drawHit;
        if (hit?.set === markers?.id && hit.id?.startsWith('port:'))
          select(hit.id.slice(5));
      });
      present();
    },
    disable() {
      enabled = false;
      request?.abort();
      request = null;
      offClick?.();
      offClick = null;
      if (markers) markers.show = false;
      selected = null;
      present();
    },
    async update() {
      if (!enabled || destroyed || !markers) return false;
      request?.abort();
      const current = new AbortController();
      request = current;
      present();
      try {
        const next = await source.getSnapshot({ signal: current.signal });
        if (
          current.signal.aborted ||
          request !== current ||
          !enabled ||
          destroyed
        )
          return false;
        snapshot = next;
        selected = selected
          ? next.rows.find((r) => r.id === selected.id)
          : null;
        error = null;
        render();
        return true;
      } catch (e) {
        if (!current.signal.aborted && request === current) error = e.message;
        return false;
      } finally {
        if (request === current) {
          request = null;
          present();
        }
      }
    },
    /** Filter options are session-local; shared URLs restore only the layer toggle. */
    setParams(params = {}) {
      if (destroyed) return false;
      // Validate the whole change before mutating either filter.
      if (
        Object.hasOwn(params, 'facility') &&
        !['', 'container', 'bulk', 'oil', 'lng'].includes(params.facility)
      )
        return false;
      if (Object.hasOwn(params, 'country')) {
        if (
          typeof params.country !== 'string' ||
          (params.country &&
            !snapshot?.rows.some((r) => r.country === params.country))
        )
          return false;
        country = params.country;
      }
      if (Object.hasOwn(params, 'facility')) {
        facility = params.facility;
      }
      render();
      return true;
    },
    select,
    /** Return only currently enabled, filtered reference records, with field provenance. */
    getAnalystRecords(maxCount = 6000) {
      return enabled
        ? shown()
            .slice(
              0,
              Math.max(0, Math.min(6000, Math.floor(Number(maxCount) || 0))),
            )
            .map((r) => structuredClone(r))
        : [];
    },
    getStats() {
      return {
        count: shown().length,
        lastUpdate: snapshot?.fetchedAt || null,
        sourceUpdatedAt: snapshot?.sourceUpdatedAt || null,
        error: error || null,
        loading: Boolean(request),
        partial: snapshot?.partial || false,
        rejected: snapshot?.rejected || 0,
        duplicates: snapshot?.duplicates || 0,
        received: snapshot?.received || 0,
        stale: Boolean(snapshot && Date.now() - snapshot.fetchedAt > 86400000),
      };
    },
    destroy() {
      layer.disable();
      destroyed = true;
      markers?.dispose();
      markers = null;
      viewer = null;
      snapshot = null;
    },
  };
  return layer;
}
