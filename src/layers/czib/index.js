import * as Cesium from 'cesium';
import { CZIB_LIST_URL } from './records.js';
export * from './records.js';
export { createCzibSource } from './source.js';

const LAYER_ID = 'easa-czib';
const ENTITY_PREFIX = `${LAYER_ID}:`;
const COLORS = Object.freeze({ whole: '#ff5a36', part: '#ffb020' });
const FILL_ALPHA = Object.freeze({ whole: 0.2, part: 0.1, selected: 0.36 });
const LABEL_LIMIT = 32;
const LABEL_MAX_CHARS = 40;
const DAY_MS = 86_400_000;
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
const DISCLAIMER =
  'EASA Conflict Zone Information Bulletins give information and recommendations to air operators about risks to civil flights. The shading marks the countries a bulletin names, not the exact airspace it covers; read the bulletin and the current NOTAMs before relying on it.';
const CAVEAT = 'Shading marks the countries named, not the exact airspace';

const day = (ms) => {
  const date = new Date(ms);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
};
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const clip = (text, max) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/**
 * A globe label for a bulletin: its area, with a sub-country area shortened
 * to the country ("Pakistan (part)").
 */
export function czibLabelTitle(bulletin) {
  if (!bulletin.partial) return clip(bulletin.area, LABEL_MAX_CHARS);
  const [country] = bulletin.area.split(/\s[–—-]\s|, /);
  return clip(`${country} (part)`, LABEL_MAX_CHARS);
}

/**
 * Own one EASA conflict zone display: the countries named by each active
 * Conflict Zone Information Bulletin, shaded from the boundaries
 * `resolveCountry` returns (`{ id, name, polygons, areaKm2, label }`, or null
 * when it has none; dashed when the bulletin covers only part of the
 * country), labelled on the globe and listed in the row. Without a resolver
 * the bulletins are listed but nothing is drawn. Globe selection needs the
 * application's `picking` registry and `pointer` ownership; without them the
 * row list still selects and focuses bulletins. Labels are world-overlay
 * labels, drawn only when an `overlayHost` is supplied.
 */
export function createCzibLayer({
  source,
  cesium = Cesium,
  now = () => Date.now(),
  resolveCountry = async () => null,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
  openExternal = (url) =>
    globalThis.open?.(url, '_blank', 'noopener,noreferrer'),
  picking = null,
  pointer = null,
  overlayHost = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('EASA CZIB requires a snapshot source');
  const C = cesium;
  let _viewer = null;
  let _dataSource = null;
  let _request = null;
  let _enabled = false;
  /** Active bulletins with their resolved countries, newest revision first. */
  let _zones = [];
  let _linksMissing = false;
  let _outlinesFailed = false;
  let _signature = null;
  let _selectedId = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  let _listener = null;
  let _runNavigation = null;
  let _clickHandler = null;
  let _navigationGeneration = 0;
  let _labelIds = [];
  /** Country name -> resolved area, or null when it has no bundled match. */
  const _countries = new Map();
  /** entity id -> bulletin id, for picks and ownership. */
  const _entityZones = new Map();
  /** bulletin id -> entities */
  const _drawn = new Map();

  const notify = () => _listener?.();
  const requestRender = () => {
    if (!_viewer?.isDestroyed?.()) _viewer?.scene?.requestRender?.();
  };
  const selected = () =>
    _zones.find((zone) => zone.bulletin.id === _selectedId) || null;

  async function resolveAll(bulletins, signal) {
    let failed = false;
    const names = [...new Set(bulletins.flatMap((entry) => entry.countries))];
    await Promise.all(
      names
        .filter((name) => !_countries.has(name))
        .map(async (name) => {
          try {
            const area = await resolveCountry(name);
            if (!signal.aborted) _countries.set(name, area || null);
          } catch {
            // A failed boundary load is retried on the next refresh.
            failed = true;
          }
        }),
    );
    return failed;
  }

  function zoneOf(bulletin) {
    const parts = [];
    const unresolved = [];
    for (const name of bulletin.countries) {
      const area = _countries.get(name);
      if (area) parts.push({ name, area });
      else unresolved.push(name);
    }
    // The label sits at the area-weighted centre of the named countries.
    const total = parts.reduce((sum, { area }) => sum + area.areaKm2, 0);
    const anchor = parts.length
      ? parts.reduce(
          (point, { area }) => ({
            lon: point.lon + (area.label.lon * area.areaKm2) / total,
            lat: point.lat + (area.label.lat * area.areaKm2) / total,
          }),
          { lon: 0, lat: 0 },
        )
      : null;
    return { bulletin, parts, unresolved, anchor, areaKm2: total };
  }

  const kindOf = (zone) => (zone.bulletin.partial ? 'part' : 'whole');

  function styleZone(zone) {
    const active = zone.bulletin.id === _selectedId;
    const color = C.Color.fromCssColorString(COLORS[kindOf(zone)]);
    for (const entity of _drawn.get(zone.bulletin.id) || []) {
      entity.polygon.material = new C.ColorMaterialProperty(
        color.withAlpha(
          active ? FILL_ALPHA.selected : FILL_ALPHA[kindOf(zone)],
        ),
      );
      entity.polyline.width = active ? 3 : 1.5;
      const stroke = active ? C.Color.WHITE : color.withAlpha(0.9);
      entity.polyline.material = zone.bulletin.partial
        ? new C.PolylineDashMaterialProperty({ color: stroke, dashLength: 12 })
        : new C.ColorMaterialProperty(stroke);
    }
  }

  const positionsOf = (ring) =>
    ring.map(([lon, lat]) => C.Cartesian3.fromDegrees(lon, lat));

  /** Label every active bulletin at the centre of the countries it names. */
  function publishLabels() {
    if (!overlayHost || !_enabled) return;
    const entries = _zones
      .filter((zone) => zone.anchor && _drawn.has(zone.bulletin.id))
      .map((zone, index) => {
        const active = zone.bulletin.id === _selectedId;
        return {
          id: zone.bulletin.id,
          position: C.Cartesian3.fromDegrees(zone.anchor.lon, zone.anchor.lat),
          variant: 'label',
          title: czibLabelTitle(zone.bulletin),
          accent: COLORS[kindOf(zone)],
          priority: 1000 - index + (active ? 10_000 : 0),
          protected: active,
          collisionGroup: 'ambient-label',
          paintLane: 'ambient-label',
          interactive: false,
          edgeFade: 'keyhole',
          horizonCull: true,
          terrainOcclusion: false,
          gapPx: 6,
          verticalOnly: true,
          placement: 'above',
        };
      })
      .sort((a, b) => b.priority - a.priority)
      .slice(0, LABEL_LIMIT);
    _labelIds = entries.map(({ id }) => id);
    overlayHost.setEntries(LAYER_ID, entries, {
      cohortLimit: LABEL_LIMIT,
      collisionCapacity: 32,
      moving: false,
    });
  }

  function clearLabels() {
    _labelIds = [];
    overlayHost?.clearSource(LAYER_ID);
    overlayHost?.setVisible(LAYER_ID, false);
  }

  function render() {
    // Only what is drawn decides a rebuild; a fresh fetch of the same
    // bulletins leaves the entities alone.
    const signature = JSON.stringify(
      _zones.map(({ bulletin, parts }) => [
        bulletin.id,
        bulletin.partial,
        parts.map(({ area }) => area.id || area.name),
      ]),
    );
    if (signature === _signature) return;
    _signature = signature;
    _dataSource.entities.removeAll();
    _entityZones.clear();
    _drawn.clear();
    for (const zone of _zones) {
      const entities = [];
      for (const { area } of zone.parts) {
        for (const [index, rings] of area.polygons.entries()) {
          const [outer, ...holes] = rings;
          const outerPositions = positionsOf(outer);
          const id = `${ENTITY_PREFIX}${zone.bulletin.id}:${area.id || area.name}:${index}`;
          entities.push(
            _dataSource.entities.add(
              new C.Entity({
                id,
                name: zone.bulletin.title,
                polygon: {
                  hierarchy: new C.PolygonHierarchy(
                    outerPositions,
                    holes.map(
                      (hole) => new C.PolygonHierarchy(positionsOf(hole)),
                    ),
                  ),
                  // Drape over photorealistic tiles as well as terrain.
                  classificationType: C.ClassificationType.BOTH,
                },
                // Entity polygons cannot outline clamped geometry themselves.
                polyline: {
                  positions: [...outerPositions, outerPositions[0]],
                  clampToGround: true,
                  classificationType: C.ClassificationType.BOTH,
                },
              }),
            ),
          );
          _entityZones.set(id, zone.bulletin.id);
        }
      }
      if (!entities.length) continue;
      _drawn.set(zone.bulletin.id, entities);
      styleZone(zone);
    }
    publishLabels();
    requestRender();
  }

  function select(id) {
    if (_selectedId !== id) ++_navigationGeneration;
    const previous = _selectedId;
    _selectedId = id;
    for (const zone of _zones) {
      if (zone.bulletin.id === previous || zone.bulletin.id === id)
        styleZone(zone);
    }
    if (previous !== id) publishLabels();
    requestRender();
  }

  // Photorealistic 3D Tiles pick as tileset content without an entity id;
  // that is empty map, the same as no pick at all on the globe.
  const isSurfacePick = (picked) =>
    !picked ||
    (picked.id === undefined &&
      (picked.content !== undefined ||
        (typeof C.Cesium3DTileset === 'function' &&
          picked.primitive instanceof C.Cesium3DTileset)));

  function installSelection() {
    const canvas = _viewer?.scene?.canvas;
    if (
      _clickHandler ||
      !picking ||
      !canvas ||
      typeof C.ScreenSpaceEventHandler !== 'function'
    )
      return;
    const owner = new C.ScreenSpaceEventHandler(canvas);
    _clickHandler = owner;
    owner.setInputAction((click) => {
      // Ambient selection yields to draw tools and Director; it never claims
      // the pointer, camera or tracking state.
      if (
        !_enabled ||
        _clickHandler !== owner ||
        (pointer && !pointer.isPointerFree()) ||
        !click?.position
      )
        return;
      const picked = _viewer.scene.pick(click.position);
      const pickedId = picking.resolvePickId(picked);
      const bulletinId = pickedId ? _entityZones.get(pickedId) : null;
      if (bulletinId) {
        layer.setParams({ bulletinId });
        return;
      }
      // A sibling layer's pick (an aircraft, a vessel) is not empty map.
      if (pickedId && picking.isOwnedByOtherLayer(LAYER_ID, pickedId)) return;
      if (_selectedId && isSurfacePick(picked))
        layer.setParams({ clear: true });
    }, C.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeSelection() {
    const owner = _clickHandler;
    _clickHandler = null;
    if (owner && !owner.isDestroyed?.()) owner.destroy();
  }

  function detailLines({ bulletin, parts, unresolved }) {
    const expired =
      bulletin.validUntilMs !== null && now() >= bulletin.validUntilMs + DAY_MS;
    return [
      bulletin.title,
      bulletin.number,
      bulletin.countries.length
        ? `Countries named: ${bulletin.countries.join(', ')}`
        : 'No country named; see the bulletin for its area',
      bulletin.partial
        ? 'Covers part of the country; the bulletin defines the area'
        : '',
      bulletin.validUntilMs === null
        ? ''
        : expired
          ? `Validity ended ${day(bulletin.validUntilMs)}; check EASA for a revision`
          : `Valid until ${day(bulletin.validUntilMs)}${/unless reviewed earlier/i.test(bulletin.validity) ? ', unless reviewed earlier' : ''}`,
      Number.isFinite(bulletin.revisedMs)
        ? `Revised ${day(bulletin.revisedMs)}`
        : '',
      unresolved.length && parts.length
        ? `Not drawn: ${unresolved.join(', ')}`
        : '',
    ].filter(Boolean);
  }

  function summaryLines() {
    const named = new Set(_zones.flatMap(({ bulletin }) => bulletin.countries));
    const unresolved = [...new Set(_zones.flatMap((zone) => zone.unresolved))];
    return [
      _zones.length
        ? `${plural(_zones.length, 'active bulletin')} · ${plural(named.size, 'country')} named`.replace(
            'countrys',
            'countries',
          )
        : _lastUpdate
          ? 'No active EASA conflict zone bulletins'
          : _lastError
            ? 'EASA bulletins unavailable'
            : 'Loading EASA bulletins…',
      _outlinesFailed
        ? 'Country outlines unavailable this refresh'
        : unresolved.length
          ? `Not drawn: ${unresolved.join(', ')}`
          : '',
      _linksMissing ? 'Bulletin numbers unavailable this refresh' : '',
      _stale ? 'Showing a cached copy' : '',
      _lastError && _zones.length ? `Last refresh failed: ${_lastError}` : '',
      CAVEAT,
    ].filter(Boolean);
  }

  const layer = {
    id: LAYER_ID,
    name: 'Conflict Zone Bulletins',
    icon: '✈',
    source: 'EASA',
    updateInterval: 3_600_000,

    init(viewer) {
      if (_viewer) throw new Error('EASA CZIB layer is already initialized');
      _viewer = viewer;
      _dataSource = new C.CustomDataSource(LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      overlayHost?.setVisible(LAYER_ID, false);
    },

    attachShellServices(services) {
      _runNavigation =
        typeof services?.runNavigation === 'function'
          ? services.runNavigation
          : null;
    },

    enable() {
      if (_enabled) return;
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      picking?.registerPickOwner(
        LAYER_ID,
        (id) => _enabled && _entityZones.has(String(id)),
      );
      installSelection();
      overlayHost?.setVisible(LAYER_ID, true);
      publishLabels();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      picking?.unregisterPickOwner(LAYER_ID);
      removeSelection();
      if (_selectedId) select(null);
      clearLabels();
      if (_dataSource) _dataSource.show = false;
      notify();
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      const current = () =>
        !request.signal.aborted && _request === request && _enabled;
      try {
        const snapshot = await source.getSnapshot({ signal: request.signal });
        if (!current()) return false;
        const active = snapshot.bulletins.filter(
          (entry) => entry.status === 'active',
        );
        const outlinesFailed = await resolveAll(active, request.signal);
        if (!current()) return false;
        _zones = active.map(zoneOf);
        _outlinesFailed = outlinesFailed;
        _linksMissing = snapshot.linksMissing === true;
        // Rebuild the polygons before a selection change republishes labels.
        render();
        if (_selectedId && !selected()) select(null);
        _stale = snapshot.stale === true;
        _lastUpdate = now();
        _lastError = null;
        return true;
      } catch (e) {
        if (!current()) return false;
        console.warn('[Data:EASA CZIB] Fetch error:', e);
        _lastError = e?.message || 'EASA bulletins unavailable';
        return false;
      } finally {
        if (_request === request) _request = null;
        notify();
      }
    },

    setParams(params = {}) {
      if (!_enabled) return;
      if (params.clear === true || params.bulletinId === null) {
        select(null);
        notify();
      } else if (
        typeof params.bulletinId === 'string' &&
        _zones.some(({ bulletin }) => bulletin.id === params.bulletinId)
      ) {
        select(params.bulletinId);
        notify();
      }
      const zone = selected();
      if (params.focus === true && zone?.anchor && _runNavigation) {
        const generation = ++_navigationGeneration;
        const { lon, lat } = zone.anchor;
        // Far enough out to frame the named countries.
        const height = Math.min(
          9_000_000,
          Math.max(1_200_000, Math.sqrt(zone.areaKm2) * 2_500),
        );
        _runNavigation(() => {
          if (
            !_enabled ||
            generation !== _navigationGeneration ||
            _selectedId !== zone.bulletin.id
          )
            return;
          return _viewer.camera.flyTo({
            destination: C.Cartesian3.fromDegrees(lon, lat, height),
            duration: matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
              ? 0
              : 1.4,
          });
        });
      }
      if (params.bulletin === true && zone)
        openExternal(zone.bulletin.url || CZIB_LIST_URL);
    },

    getRowControls() {
      const zone = selected();
      const count = (kind) =>
        _zones.filter((entry) => kindOf(entry) === kind).length;
      return {
        chips: zone
          ? [
              {
                id: 'bulletin',
                label: zone.bulletin.url ? 'EASA bulletin ↗' : 'EASA CZIBs ↗',
                title: zone.bulletin.url
                  ? `Open ${zone.bulletin.number || 'the bulletin'} on the EASA website in a new tab`
                  : 'Open the EASA conflict zone bulletin list in a new tab',
                params: { bulletin: true },
              },
            ]
          : [],
        legend: [
          {
            label: 'Whole country named',
            color: COLORS.whole,
            count: count('whole'),
            blurb: DISCLAIMER,
          },
          {
            label: 'Part of a country',
            color: COLORS.part,
            count: count('part'),
          },
        ],
        list: {
          ariaLabel:
            'Active EASA conflict zone bulletins, latest revision first',
          items: _zones.map(({ bulletin }, index) => ({
            id: bulletin.id,
            ordinal: index + 1,
            lead: bulletin.number.replace(/^CZIB-/, ''),
            text:
              bulletin.countries.length > 1
                ? `${bulletin.area} · ${bulletin.countries.length} countries`
                : bulletin.area,
            active: bulletin.id === _selectedId,
            params: { bulletinId: bulletin.id, focus: true },
          })),
        },
        // The row renders info as one wrapped paragraph.
        info: (zone ? detailLines(zone) : summaryLines()).join(' · '),
        infoTitle: `Select a shaded country on the map, or choose a bulletin in the list to select it and move the camera. Click empty map space to clear the selection. Dashed outlines mark bulletins that cover only part of a country. ${DISCLAIMER}`,
      };
    },

    setRowControlsListener(value) {
      _listener = typeof value === 'function' ? value : null;
    },

    getStats() {
      return {
        count: _zones.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
        partial:
          _linksMissing ||
          _outlinesFailed ||
          _zones.some((zone) => zone.unresolved.length > 0),
      };
    },

    getDiagnostics() {
      return {
        enabled: _enabled,
        requestPending: Boolean(_request),
        selectionActive: _clickHandler !== null,
        selectedId: _selectedId,
        zones: _drawn.size,
        entities: _entityZones.size,
        labels: [..._labelIds],
      };
    },

    destroy(viewer = _viewer) {
      layer.disable();
      _zones = [];
      _signature = null;
      _entityZones.clear();
      _drawn.clear();
      _countries.clear();
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _listener = null;
      _runNavigation = null;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
      _linksMissing = false;
      _outlinesFailed = false;
    },
  };
  return layer;
}
