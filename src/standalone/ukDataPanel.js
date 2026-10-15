import * as Cesium from 'cesium';
import {
  UK_FEEDS,
  UK_ACCESS_SOURCES,
  UK_VIEWS,
} from '../regional/ukCatalog.js';
import {
  inUkBounds,
  readingAge,
  safeLink,
  text,
} from '../regional/ukDataModel.js';
import './ukDataPanel.css';
import { readUkFeed } from '../regional/ukFeedClient.js';
import { createUkMapLayers } from '../regional/ukMapLayers.js';
import { createUkMapRenderer, UK_MAP_COLORS } from './ukMapRenderer.js';

export function installUkDataPanel({ viewer, dataManager, signal }) {
  const root = document.createElement('div');
  root.className = 'uk-data-root';
  const make = (tag, content, parent = root) => {
    const node = document.createElement(tag);
    if (content) node.textContent = content;
    parent.append(node);
    return node;
  };
  const launch = make('button', 'UK DATA');
  launch.className = 'uk-data-launch';
  launch.type = 'button';
  launch.setAttribute('aria-expanded', 'false');
  const badge = make('button');
  badge.className = 'uk-map-badge';
  badge.type = 'button';
  badge.hidden = true;
  badge.title = 'Open UK source controls and the colour legend';
  const panel = make('section');
  panel.hidden = true;
  panel.className = 'uk-data-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'UK public data');
  const head = make('header', null, panel);
  make('h2', 'UK PUBLIC DATA', head);
  const close = make('button', 'Close', head);
  close.type = 'button';
  make(
    'p',
    'Public observations and published updates. Zoom in to separate nearby points; select a point for its source record. Coverage varies by provider.',
    panel,
  );
  const mapActions = make('div', null, panel);
  mapActions.className = 'uk-data-actions';
  const showAll = make('button', 'Show UK feeds on map', mapActions);
  showAll.type = 'button';
  const hideAll = make('button', 'Hide UK feeds', mapActions);
  hideAll.type = 'button';
  const mapSummary = make('p', 'Map layers are off.', panel);
  mapSummary.className = 'uk-map-summary';
  mapSummary.setAttribute('aria-live', 'polite');
  const switches = make('details', null, panel);
  switches.className = 'uk-map-switches';
  make('summary', 'Choose map layers and see feed status', switches);
  make(
    'p',
    'Saved map layers stay visible when this panel closes. Records without coordinates remain in the list. Nearby places load only when selected.',
    switches,
  );
  const mapOptions = new Map();
  for (const info of UK_FEEDS) {
    const label = make('label', null, switches);
    const checkbox = make('input', null, label);
    checkbox.type = 'checkbox';
    checkbox.setAttribute('aria-label', `Map layer: ${info.name}`);
    const swatch = make('span', null, label);
    swatch.className = 'uk-map-swatch';
    swatch.style.backgroundColor = UK_MAP_COLORS[info.id];
    make('span', info.name, label);
    const detail = make('small', 'Off', label);
    mapOptions.set(info.id, { checkbox, detail });
    checkbox.onchange = () => mapLayers.setEnabled(info.id, checkbox.checked);
  }
  const regions = make('div', null, panel);
  regions.className = 'uk-data-regions';
  const fly = (lat, lon, height = 18000) => {
    if (inUkBounds(lat, lon)) {
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        duration: 1,
      });
      viewer.scene.requestRender();
    }
  };
  for (const [name, lat, lon, height] of UK_VIEWS) {
    const button = make('button', name, regions);
    button.type = 'button';
    button.onclick = () => {
      fly(lat, lon, height);
      if (rows.length) render();
    };
  }
  const toolbar = make('div', null, panel);
  toolbar.className = 'uk-data-toolbar';
  const label = make('label', 'Data source', toolbar);
  const select = make('select', null, label);
  select.setAttribute('aria-label', 'UK data source');
  for (const f of UK_FEEDS) {
    const option = make('option', f.name, select);
    option.value = f.id;
  }
  const access = make('option', 'Sources requiring official access', select);
  access.value = 'access';
  const search = make('input', null, toolbar);
  search.type = 'search';
  search.placeholder = 'Search places or updates';
  search.setAttribute('aria-label', 'Search UK records');
  const refresh = make('button', 'Refresh', toolbar);
  refresh.type = 'button';
  const credit = make('p', null, panel);
  credit.className = 'uk-data-credit';
  const status = make(
    'p',
    'Select a source to load its public records.',
    panel,
  );
  status.setAttribute('role', 'status');
  const list = make('div', null, panel);
  list.className = 'uk-data-results';
  const footer = make('p', null, panel);
  make('span', 'See each provider’s terms. Public-sector sources: ', footer);
  const licence = make('a', 'Open Government Licence', footer);
  licence.href =
    'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/';
  licence.target = '_blank';
  licence.rel = 'noopener noreferrer';
  document.body.append(root);
  const loading = document.getElementById('loading-screen');
  let revealObserver;
  if (loading && !loading.classList.contains('hidden')) {
    root.hidden = true;
    revealObserver = new MutationObserver(() => {
      if (loading.classList.contains('hidden')) {
        root.hidden = false;
        revealObserver.disconnect();
      }
    });
    revealObserver.observe(loading, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }
  let destroyed = false,
    rows = [],
    payload = null,
    request = null,
    epoch = 0,
    timer = null;
  let mapLayers;
  function cancel() {
    epoch++;
    request?.abort();
    request = null;
    clearTimeout(timer);
    timer = null;
  }
  function anchor() {
    const c = viewer.camera.positionCartographic;
    return {
      lat: Cesium.Math.toDegrees(c.latitude),
      lon: Cesium.Math.toDegrees(c.longitude),
    };
  }
  function link(parent, label, url) {
    url = safeLink(url);
    if (!url) return;
    const a = make('a', label, parent);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  function note(parent, value) {
    return make('p', value, parent);
  }
  function render() {
    list.replaceChildren();
    const info = UK_FEEDS.find((f) => f.id === select.value);
    if (select.value === 'access') {
      credit.textContent =
        'These sources are not connected. Obtain access directly from the provider; no credentials are bundled.';
      status.textContent = 'Available official access routes';
      for (const source of UK_ACCESS_SOURCES) {
        const article = make('article', null, list);
        make('h3', source.name, article);
        note(article, source.status);
        link(article, 'Official access information', source.url);
      }
      return;
    }
    credit.textContent = `${info?.coverage || ''} · ${info?.credit || ''}`;
    if (!payload) return;
    const needle = search.value.trim().toLowerCase(),
      centre = anchor();
    const matches = rows
      .filter((r) => `${r.name} ${r.details}`.toLowerCase().includes(needle))
      .sort((a, b) => {
        const distance = (r) =>
          inUkBounds(r.lat, r.lon)
            ? Math.hypot(
                r.lat - centre.lat,
                (r.lon - centre.lon) * Math.cos((centre.lat * Math.PI) / 180),
              )
            : Infinity;
        return distance(a) - distance(b);
      });
    const retrieved = payload.retrievedAt
      ? new Date(payload.retrievedAt).toLocaleString('en-GB')
      : 'not retrieved';
    const retrievalStatus =
      payload.status === 'stale'
        ? 'PREVIOUS RETRIEVAL · '
        : payload.status === 'unavailable'
          ? 'UNAVAILABLE · '
          : '';
    const savedLayer = mapLayers?.isEnabled(select.value);
    const mapCount = savedLayer
      ? mapLayers.states().find((s) => s.id === select.value)?.mappedCount || 0
      : 0;
    const mapLabel = savedLayer ? 'saved map layer' : 'map layer off';
    status.textContent = `${retrievalStatus}${matches.length} matching records · showing ${Math.min(matches.length, 120)} closest/listed records · ${mapLabel}: ${mapCount} points · retrieved ${retrieved}${payload.message ? ' · ' + payload.message : ''}`;
    if (!matches.length)
      note(
        list,
        payload.status === 'unavailable'
          ? payload.message
          : 'No matching records in this source. This is not proof of complete coverage or an all-clear.',
      );
    for (const row of matches.slice(0, 120)) {
      const article = make('article', null, list);
      make('h3', row.name, article);
      note(article, row.details);
      const time = note(
        article,
        row.time
          ? `${new Date(row.time).toLocaleString('en-GB')} · ${readingAge(row.time, Date.now(), select.value.includes('road') || select.value.includes('incidents') ? 86400000 : 3600000)}`
          : 'Observation/update time not supplied',
      );
      time.className = 'uk-data-time';
      const actions = make('div', null, article);
      actions.className = 'uk-data-actions';
      if (inUkBounds(row.lat, row.lon)) {
        const map = make('button', 'Show on map', actions);
        map.type = 'button';
        map.onclick = () => {
          mapLayers.setEnabled(select.value, true);
          fly(row.lat, row.lon);
        };
      }
      if (row.camera) {
        const camera = make('button', 'View camera', actions);
        camera.type = 'button';
        camera.onclick = async () => {
          const current = epoch;
          camera.disabled = true;
          try {
            await dataManager.setEnabled('cctv', true, { origin: 'user' });
            if (destroyed || current !== epoch) return;
            await dataManager.setLayerParams(
              'cctv',
              { selectedCameraId: row.id, focusSelected: true },
              { origin: 'user' },
            );
            if (destroyed || current !== epoch) return;
            setOpen(false);
          } catch {
            if (!destroyed && current === epoch)
              note(
                article,
                'Camera could not be opened; try the main CCTV panel.',
              );
          } finally {
            camera.disabled = false;
          }
        };
      }
      if (row.series?.length) {
        const last = make('button', 'Last observation', actions);
        last.type = 'button';
        last.onclick = async () => {
          const current = epoch;
          last.disabled = true;
          try {
            const r = await fetch(`/api/uk-data/air/${row.series[0]}`, {
              signal: request?.signal,
            });
            if (!r.ok) throw new Error();
            const value = await r.json();
            if (destroyed || current !== epoch) return;
            note(
              article,
              `${value.value === null ? 'Reading unavailable' : value.value + ' ' + text(value.unit)} · ${value.time ? new Date(value.time).toLocaleString('en-GB') : 'time not supplied'} · ${readingAge(value.time)}`,
            );
          } catch {
            if (!destroyed && current === epoch)
              note(article, 'Last observation unavailable.');
          } finally {
            last.disabled = false;
          }
        };
      }
      link(actions, 'Official source', row.url || info.page);
    }
  }
  async function places(abortSignal) {
    const { lat, lon } = anchor();
    if (!inUkBounds(lat, lon))
      throw new Error('Move the map to the UK, then refresh nearby places.');
    const centre = `around:10000,${lat.toFixed(4)},${lon.toFixed(4)}`;
    const query = `[out:json][timeout:20];(nwr[amenity~"^(hospital|charging_station|fire_station|police|bus_station)$"](${centre});nwr[railway=station](${centre});nwr[aeroway=aerodrome](${centre});nwr[harbour=yes](${centre}););out center 1000;`;
    const response = await fetch('/api/overpass', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ data: query }),
      signal: abortSignal,
    });
    if (!response.ok) throw new Error('Nearby mapped places are unavailable.');
    const data = await response.json();
    return {
      status: 'available',
      retrievedAt: new Date().toISOString(),
      rows: (data.elements || []).flatMap((e) => {
        const lat = e.lat ?? e.center?.lat,
          lon = e.lon ?? e.center?.lon;
        if (!inUkBounds(lat, lon)) return [];
        return [
          {
            id: `${e.type}-${e.id}`,
            name: text(
              e.tags?.name ||
                e.tags?.amenity ||
                e.tags?.railway ||
                'Mapped place',
            ),
            details: `${text(e.tags?.amenity || e.tags?.railway || e.tags?.aeroway || 'Harbour')} · mapped location; operation, capacity and availability unverified`,
            lat,
            lon,
            url: `https://www.openstreetmap.org/${e.type}/${e.id}`,
          },
        ];
      }),
    };
  }
  async function load() {
    cancel();
    const current = epoch;
    rows = [];
    payload = null;
    list.replaceChildren();
    refresh.disabled = false;
    if (select.value === 'access') {
      render();
      return;
    }
    const info = UK_FEEDS.find((f) => f.id === select.value);
    credit.textContent = `${info.coverage} · ${info.credit}`;
    status.textContent = 'Loading public data…';
    request = new AbortController();
    refresh.disabled = true;
    try {
      let next;
      next = await fetchFeed(select.value, request.signal);
      if (destroyed || current !== epoch || panel.hidden) return;
      payload = next;
      rows = next.rows || [];
      render();
    } catch (error) {
      if (destroyed || current !== epoch || error.name === 'AbortError') return;
      status.textContent =
        error.message || 'Public data unavailable. This is not an all-clear.';
    } finally {
      if (current === epoch && !destroyed) {
        refresh.disabled = false;
        if (!panel.hidden && !document.hidden && select.value !== 'places')
          timer = setTimeout(load, info.interval);
      }
    }
  }
  function setOpen(open) {
    cancel();
    panel.hidden = !open;
    launch.setAttribute('aria-expanded', String(open));
    if (open) {
      select.focus();
      void load();
    } else {
      launch.focus();
    }
  }
  launch.onclick = () => setOpen(panel.hidden);
  badge.onclick = () => setOpen(panel.hidden);
  close.onclick = () => setOpen(false);
  refresh.onclick = () => void load();
  select.onchange = () => void load();
  search.oninput = render;
  panel.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };
  async function fetchFeed(id, abortSignal) {
    return id === 'places' ? places(abortSignal) : readUkFeed(id, abortSignal);
  }
  function updateMapStatus(states) {
    const enabled = states.filter((s) => s.enabled);
    const count = enabled.reduce((sum, s) => sum + s.mappedCount, 0);
    const loadingCount = enabled.filter(
      (s) => s.status === 'loading' || s.status === 'queued',
    ).length;
    const unavailableCount = enabled.filter(
      (s) => s.status === 'unavailable',
    ).length;
    const staleCount = enabled.filter((s) => s.status === 'stale').length;
    const unmapped = enabled.reduce(
      (sum, s) => sum + s.count - s.coordinateCount,
      0,
    );
    const limited = enabled.reduce(
      (sum, s) => sum + s.coordinateCount - s.mappedCount,
      0,
    );
    const line = `${enabled.length} feeds on · ${count.toLocaleString('en-GB')} map points · ${loadingCount} loading · ${unavailableCount} unavailable · ${staleCount} previous retrievals`;
    mapSummary.textContent = `${line}. ${unmapped} records have no coordinates.${limited ? ` ${limited} duplicate or excess location records are not drawn.` : ''}`;
    badge.textContent = `UK MAP · ${count.toLocaleString('en-GB')} points`;
    badge.hidden = !enabled.length;
    for (const s of states) {
      const option = mapOptions.get(s.id);
      option.checkbox.checked = s.enabled;
      const retrieved = s.retrievedAt
        ? new Date(s.retrievedAt).toLocaleString('en-GB')
        : 'not retrieved';
      option.detail.textContent = s.enabled
        ? `${s.status.toUpperCase()} · ${s.mappedCount} points / ${s.count} records · ${retrieved}${s.message ? ' · ' + s.message : ''}`
        : 'Off';
    }
    if (!panel.hidden && payload) render();
  }
  const mapRenderer = createUkMapRenderer({
    viewer,
    onPick(id, row) {
      select.value = id;
      search.value = row.name;
      setOpen(true);
    },
  });
  mapLayers = createUkMapLayers({
    fetchFeed,
    replace: mapRenderer.replace,
    remove: mapRenderer.remove,
    onChange: updateMapStatus,
  });
  updateMapStatus(mapLayers.states());
  mapLayers.setSuspended(document.hidden);
  showAll.onclick = () => {
    search.value = '';
    mapLayers.enableAll();
    const [, lat, lon, height] = UK_VIEWS[0];
    fly(lat, lon, height);
  };
  hideAll.onclick = () => mapLayers.disableAll();
  const visibility = () => {
    mapLayers.setSuspended(document.hidden);
    if (document.hidden) cancel();
    else if (!panel.hidden) void load();
  };
  document.addEventListener('visibilitychange', visibility);
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    revealObserver?.disconnect();
    cancel();
    mapLayers.destroy();
    mapRenderer.destroy();
    document.removeEventListener('visibilitychange', visibility);
    signal?.removeEventListener('abort', destroy);
    root.remove();
  }
  signal?.addEventListener('abort', destroy, { once: true });
  return { destroy };
}
