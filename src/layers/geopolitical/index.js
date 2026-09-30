import * as Cesium from 'cesium';
import countryAnchorPack from '../cyber/countryAnchors.json' with { type: 'json' };
import { normalizeRadioCountryInput } from '../../data/radioCountry.js';
import {
  GEOPOLITICAL_MARKERS,
  createGeopoliticalMarkerImage,
} from '../../data/geopoliticalMarkers.js';
const COUNTRY_ANCHORS = countryAnchorPack.anchors || {};
const COUNTRY_ANCHORS_BY_NAME = new Map(
  Object.entries(COUNTRY_ANCHORS).map(([code, anchor]) => [
    anchor.name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase(),
    { code, ...anchor },
  ]),
);
const UPDATE_INTERVAL = 15 * 60_000;

function safe(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char],
  );
}

function formatDate(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : 'Unknown';
}

export function createGeopoliticalLayer({
  source,
  updateInterval = UPDATE_INTERVAL,
}) {
  let viewer = null;
  let dataSource = null;
  let enabled = false;
  let loading = false;
  let request = null;
  let snapshot = null;
  let error = null;
  let selected = null;
  let gdeltVisible = true;
  let ucdpVisible = true;
  let ucdpCandidateVisible = true;
  let hapiVisible = true;
  let gdeltConflictFocus = false;
  let gdeltSearch = null;
  let gdeltSearchRequest = null;
  let ucdpSearch = null;
  let ucdpSearchRequest = null;

  function mapEvents() {
    let events = snapshot?.events || [];
    if (gdeltConflictFocus) {
      events = events.filter(
        (item) => item.provider !== 'gdelt' || isGdeltConflictSignal(item),
      );
    }
    for (const [provider, visible, search] of [
      ['gdelt', gdeltVisible, gdeltSearch],
      ['ucdp', ucdpVisible, ucdpSearch],
      ['ucdp-candidate', ucdpCandidateVisible, null],
      ['hapi-conflict', hapiVisible, null],
    ]) {
      if (!visible) {
        events = events.filter((item) => item.provider !== provider);
      } else if (search && !search.loading && !search.error) {
        events = [
          ...events.filter((item) => item.provider !== provider),
          ...search.events,
        ];
      }
    }
    return events;
  }

  function isGdeltConflictSignal(item) {
    const code = Number(item.eventType?.match(/^CAMEO (\d+)/)?.[1]);
    const root = Number(item.eventType?.match(/^CAMEO (\d{2})/)?.[1]);
    // Keep the clearly military CAMEO fight sub-events and mass-violence
    // category; omit generic assaults and fights that commonly include
    // criminal or police-response reporting.
    return (code >= 190 && code < 200) || root === 20;
  }

  function mapEntities() {
    const events = mapEvents();
    const reportsByCountry = new Map();
    const hapiCountryMarkers = [];
    for (const item of events) {
      if (item.provider === 'hapi-conflict') {
        const scope = item.countryScopes?.[0];
        const countryName = scope?.name || item.country || item.location || '';
        const normalized = normalizeRadioCountryInput(
          String(countryName)
            .replace(/\s*\([^)]*\)\s*/g, ' ')
            .trim(),
        );
        const nameKey = String(countryName)
          .normalize('NFKD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase();
        const anchor =
          (normalized.valid && COUNTRY_ANCHORS[normalized.code]) ||
          COUNTRY_ANCHORS_BY_NAME.get(nameKey);
        // HAPI is country/admin-region aggregated. Only map to a documented
        // country reference point when country-name matching is unambiguous.
        if (anchor)
          hapiCountryMarkers.push({
            ...item,
            countryAggregate: true,
            hapiCountryAggregate: true,
            countryCode: scope?.code || null,
            countryName: anchor.name,
            latitude: anchor.latitude,
            longitude: anchor.longitude,
          });
        continue;
      }
      if (item.provider !== 'reliefweb') continue;
      for (const scope of item.countryScopes || []) {
        if (
          !Number.isFinite(scope.latitude) ||
          !Number.isFinite(scope.longitude)
        )
          continue;
        const key =
          scope.code ||
          scope.name
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-');
        if (!key) continue;
        let group = reportsByCountry.get(key);
        if (!group) {
          group = {
            id: `reliefweb-country:${key}`,
            provider: 'reliefweb',
            countryAggregate: true,
            countryCode: scope.code,
            countryName: scope.name,
            latitude: scope.latitude,
            longitude: scope.longitude,
            events: new Map(),
          };
          reportsByCountry.set(key, group);
        }
        group.events.set(item.id, item);
      }
    }
    const countryMarkers = [...reportsByCountry.values()].map((group) => ({
      ...group,
      events: [...group.events.values()].sort((a, b) =>
        b.eventAt.localeCompare(a.eventAt),
      ),
    }));
    return [
      ...events.filter(
        (item) => !['reliefweb', 'hapi-conflict'].includes(item.provider),
      ),
      ...hapiCountryMarkers,
      ...countryMarkers,
    ];
  }
  const listeners = new Set();

  function notify() {
    for (const listener of listeners) listener(getPanelState());
  }

  function popupPosition(position) {
    const rect = viewer?.scene?.canvas?.getBoundingClientRect?.();
    if (!rect || !position) return null;
    return {
      x: Math.round(rect.left + position.x + 14),
      y: Math.round(rect.top + position.y + 14),
    };
  }

  function popupMarkup(item) {
    const style =
      GEOPOLITICAL_MARKERS[item.provider] || GEOPOLITICAL_MARKERS.gdelt;
    if (item.hapiCountryAggregate) {
      return `<section class="geopolitical-popup-card"><header><span class="geopolitical-provider-tag" style="--geo-provider-color:${style.color}">HDX HAPI / ACLED · Country aggregate</span><button type="button" class="geopolitical-popup-close" data-geopolitical-close aria-label="Close conflict summary">×</button></header><h3>${safe(item.countryName)}</h3><p>${safe(item.summary || 'No monthly aggregate details are available.')}</p><p>Country reference point only; these monthly aggregates do not identify incident locations. Event categories overlap and must not be added together.</p><p class="geopolitical-provenance">Source: HDX HAPI / ACLED public aggregate · updated weekly · <a href="${safe(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">Dataset details ↗</a></p></section>`;
    }
    if (item.countryAggregate) {
      const reportLimit = 20;
      const reports = item.events
        .slice(0, reportLimit)
        .map(
          (report) =>
            `<li><a href="${safe(report.sourceUrl)}" target="_blank" rel="noopener noreferrer">${safe(report.title)}</a><small>${safe(formatDate(report.eventAt))}</small></li>`,
        )
        .join('');
      return `<section class="geopolitical-popup-card"><header><span class="geopolitical-provider-tag" style="--geo-provider-color:${style.color}">ReliefWeb · Country</span><button type="button" class="geopolitical-popup-close" data-geopolitical-close aria-label="Close country reports">×</button></header><h3>${safe(item.countryName)}</h3><p>${item.events.length} ReliefWeb report${item.events.length === 1 ? '' : 's'} reference this country in the current results.</p><p>Country reference point only; reports may describe a country-wide scope and do not establish incident locations.</p><ul class="geopolitical-country-report-list">${reports}</ul>${item.events.length > reportLimit ? `<p>Showing the latest ${reportLimit} reports.</p>` : ''}<p class="geopolitical-provenance">Source: ReliefWeb / OCHA</p></section>`;
    }
    return `<section class="geopolitical-popup-card"><header><span class="geopolitical-provider-tag" style="--geo-provider-color:${style.color}">${style.label}</span><button type="button" class="geopolitical-popup-close" data-geopolitical-close aria-label="Close event details">×</button></header><h3>${safe(item.title)}</h3><p>${safe(item.summary || item.semantics || 'No additional description provided.')}</p><dl><div><dt>Category</dt><dd>${safe(item.category)}</dd></div><div><dt>Event date</dt><dd>${safe(formatDate(item.eventAt))}</dd></div>${item.provider === 'gdelt' && item.reportedAt ? `<div><dt>Indexed by GDELT</dt><dd>${safe(formatDate(item.reportedAt))}</dd></div>` : ''}${item.location ? `<div><dt>Reported location</dt><dd>${safe(item.location)}</dd></div>` : ''}<div><dt>Location precision</dt><dd>${safe(item.locationPrecision)}</dd></div>${item.actors.length ? `<div><dt>Actors</dt><dd>${item.actors.map(safe).join(', ')}</dd></div>` : ''}${item.fatalities !== null ? `<div><dt>Reported fatalities</dt><dd>${item.fatalities}</dd></div>` : ''}<div><dt>Source</dt><dd>${safe(item.sourceName || item.attribution)}</dd></div></dl><p class="geopolitical-provenance">${safe(item.semantics || item.confidence || '')}</p><a href="${safe(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">Open source ↗</a></section>`;
  }

  function choose(item, position = null) {
    selected = item ? { item, position } : null;
    notify();
  }

  function render() {
    if (!dataSource) return;
    dataSource.entities.removeAll();
    for (const item of mapEntities()) {
      if (!Number.isFinite(item.latitude) || !Number.isFinite(item.longitude))
        continue;
      const style =
        GEOPOLITICAL_MARKERS[item.provider] || GEOPOLITICAL_MARKERS.gdelt;
      const aggregateCount = Array.isArray(item.events)
        ? item.events.length
        : 0;
      const markerSize = item.countryAggregate
        ? Math.min(34, 28 + Math.log2(aggregateCount + 1))
        : 30;
      const entity = dataSource.entities.add({
        id: `geopolitical:${item.id}`,
        position: Cesium.Cartesian3.fromDegrees(item.longitude, item.latitude),
        billboard: {
          image: createGeopoliticalMarkerImage(item.provider),
          width: markerSize,
          height: markerSize,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          // Keep markers occluded by the globe when their country or event is
          // on the far side of the camera. An infinite disable distance makes
          // every marker visible through the Earth.
          disableDepthTestDistance: 0,
        },
      });
      entity.geopoliticalEventId = item.id;
      entity.geopoliticalCountryAggregate = item.countryAggregate === true;
    }
    dataSource.show = enabled;
  }

  function findEvent(entityId) {
    const prefix = 'geopolitical:';
    if (!String(entityId || '').startsWith(prefix)) return null;
    const eventId = String(entityId).slice(prefix.length);
    return mapEntities().find((item) => item.id === eventId) || null;
  }

  function viewportArea() {
    const rectangle = viewer?.camera?.computeViewRectangle?.(
      viewer.scene?.globe?.ellipsoid || Cesium.Ellipsoid?.WGS84,
    );
    if (!rectangle) return null;
    const center = Cesium.Rectangle.center(rectangle);
    if (!center) return null;
    const distanceKm = (latitude, longitude) => {
      const deltaLatitude = latitude - center.latitude;
      let deltaLongitude = longitude - center.longitude;
      if (deltaLongitude > Math.PI) deltaLongitude -= Math.PI * 2;
      if (deltaLongitude < -Math.PI) deltaLongitude += Math.PI * 2;
      const a =
        Math.sin(deltaLatitude / 2) ** 2 +
        Math.cos(center.latitude) *
          Math.cos(latitude) *
          Math.sin(deltaLongitude / 2) ** 2;
      return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    };
    const corners = [
      [rectangle.south, rectangle.west],
      [rectangle.south, rectangle.east],
      [rectangle.north, rectangle.west],
      [rectangle.north, rectangle.east],
    ];
    const radiusKm = Math.ceil(
      Math.max(
        ...corners.map(([latitude, longitude]) =>
          distanceKm(latitude, longitude),
        ),
      ),
    );
    return {
      latitude: Cesium.Math.toDegrees(center.latitude),
      longitude: Cesium.Math.toDegrees(center.longitude),
      radiusKm,
    };
  }

  async function searchGdeltArea(category) {
    if (
      !enabled ||
      !gdeltVisible ||
      typeof source?.searchGdeltArea !== 'function'
    )
      return;
    const area = viewportArea();
    if (!area || area.radiusKm < 1 || area.radiusKm > 20_050) {
      gdeltSearch = {
        category,
        error: 'The current map view cannot be searched.',
      };
      notify();
      return;
    }
    gdeltSearchRequest?.abort();
    const controller = new AbortController();
    gdeltSearchRequest = controller;
    gdeltSearch = { ...area, category, events: [], loading: true };
    notify();
    try {
      const result = await source.searchGdeltArea(
        { ...area, category },
        { signal: controller.signal },
      );
      if (controller.signal.aborted || !enabled) return;
      gdeltSearch = {
        ...area,
        category,
        events: result.events,
        totalMatches: result.search?.totalMatches ?? result.events.length,
      };
      render();
    } catch (caught) {
      if (controller.signal.aborted || !enabled) return;
      gdeltSearch = {
        ...area,
        category,
        error: caught?.message || 'GDELT area search failed.',
      };
    } finally {
      if (gdeltSearchRequest === controller) {
        gdeltSearchRequest = null;
        notify();
      }
    }
  }

  function clearGdeltSearch() {
    gdeltSearchRequest?.abort();
    gdeltSearchRequest = null;
    gdeltSearch = null;
    render();
    notify();
  }

  async function searchUcdpArea() {
    if (
      !enabled ||
      !ucdpVisible ||
      typeof source?.searchUcdpArea !== 'function'
    )
      return;
    const area = viewportArea();
    if (!area || area.radiusKm < 1 || area.radiusKm > 20_050) {
      ucdpSearch = { error: 'The current map view cannot be searched.' };
      notify();
      return;
    }
    ucdpSearchRequest?.abort();
    const controller = new AbortController();
    ucdpSearchRequest = controller;
    ucdpSearch = { ...area, events: [], loading: true };
    notify();
    try {
      const result = await source.searchUcdpArea(area, {
        signal: controller.signal,
      });
      if (controller.signal.aborted || !enabled) return;
      ucdpSearch = {
        ...area,
        events: result.events,
        mode: result.search?.mode || 'area',
        totalMatches: result.search?.totalMatches ?? result.events.length,
        partial: result.search?.partial === true,
        dateThrough: result.search?.dateThrough || null,
      };
      render();
    } catch (caught) {
      if (controller.signal.aborted || !enabled) return;
      ucdpSearch = {
        ...area,
        error: caught?.message || 'UCDP area search failed.',
      };
    } finally {
      if (ucdpSearchRequest === controller) {
        ucdpSearchRequest = null;
        notify();
      }
    }
  }

  function clearUcdpSearch() {
    ucdpSearchRequest?.abort();
    ucdpSearchRequest = null;
    ucdpSearch = null;
    render();
    notify();
  }

  function setGdeltVisible(visible) {
    gdeltVisible = visible === true;
    if (!gdeltVisible) {
      if (selected?.item.provider === 'gdelt') selected = null;
      if (gdeltSearch?.loading) {
        gdeltSearchRequest?.abort();
        gdeltSearchRequest = null;
        gdeltSearch = null;
      }
    }
    render();
    notify();
  }

  function setUcdpVisible(visible) {
    ucdpVisible = visible === true;
    if (!ucdpVisible) {
      if (selected?.item.provider === 'ucdp') selected = null;
      if (ucdpSearch?.loading) clearUcdpSearch();
    }
    render();
    notify();
  }

  function setUcdpCandidateVisible(visible) {
    ucdpCandidateVisible = visible === true;
    if (!ucdpCandidateVisible && selected?.item.provider === 'ucdp-candidate')
      selected = null;
    render();
    notify();
  }

  function setHapiVisible(visible) {
    hapiVisible = visible === true;
    if (!hapiVisible && selected?.item.provider === 'hapi-conflict')
      selected = null;
    render();
    notify();
  }

  function setGdeltConflictFocus(enabled) {
    gdeltConflictFocus = enabled === true;
    if (
      gdeltConflictFocus &&
      selected?.item.provider === 'gdelt' &&
      !isGdeltConflictSignal(selected.item)
    )
      selected = null;
    render();
    notify();
  }

  function getPanelState() {
    const events = mapEvents();
    return {
      enabled,
      loading,
      error,
      fetchedAt: snapshot?.fetchedAt || null,
      stale: snapshot?.stale === true,
      providers: snapshot?.providers || [],
      events,
      gdeltVisible,
      ucdpVisible,
      ucdpCandidateVisible,
      hapiVisible,
      gdeltConflictFocus,
      onToggleGdelt: setGdeltVisible,
      onToggleUcdp: setUcdpVisible,
      onToggleUcdpCandidate: setUcdpCandidateVisible,
      onToggleHapi: setHapiVisible,
      onToggleGdeltConflictFocus: setGdeltConflictFocus,
      gdeltSearch: gdeltSearch
        ? {
            ...gdeltSearch,
            count: gdeltSearch.events?.length || 0,
          }
        : null,
      onSearchGdeltArea: searchGdeltArea,
      onClearGdeltSearch: clearGdeltSearch,
      ucdpSearch: ucdpSearch
        ? {
            ...ucdpSearch,
            count: ucdpSearch.events?.length || 0,
          }
        : null,
      onSearchUcdpArea: searchUcdpArea,
      onClearUcdpSearch: clearUcdpSearch,
      selected: selected
        ? { ...selected.item, popupPosition: selected.position }
        : null,
      mappedCount: mapEntities().filter(
        (item) =>
          Number.isFinite(item.latitude) && Number.isFinite(item.longitude),
      ).length,
      onSelectEvent: (id) => {
        const item = events.find((entry) => entry.id === id);
        if (!item) return;
        if (Number.isFinite(item.latitude) && Number.isFinite(item.longitude)) {
          viewer?.camera?.flyTo?.({
            destination: Cesium.Cartesian3.fromDegrees(
              item.longitude,
              item.latitude,
              1_000_000,
            ),
            duration: 1.2,
          });
          choose(item, null);
        } else choose(item, null);
      },
      onCloseSelection: () => choose(null),
    };
  }

  async function update() {
    if (!enabled || !source?.getSnapshot) return false;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    loading = true;
    error = null;
    notify();
    try {
      const value = await source.getSnapshot({ signal: controller.signal });
      if (controller.signal.aborted || request !== controller || !enabled)
        return false;
      snapshot = value;
      error = null;
      render();
      if (selected) {
        const item = mapEntities().find(
          (entry) => entry.id === selected.item.id,
        );
        selected = item ? { ...selected, item } : null;
      }
      return true;
    } catch (caught) {
      if (controller.signal.aborted) return false;
      error = caught?.message || 'Geo-Political data unavailable.';
      return false;
    } finally {
      if (request === controller) {
        request = null;
        loading = false;
        notify();
      }
    }
  }

  return {
    id: 'geopolitical',
    name: 'Geo-Political',
    icon: '◎',
    source: 'GDELT · ACLED · UCDP · HDX HAPI · ReliefWeb',
    updateInterval,
    init(mapViewer) {
      if (viewer) throw new Error('Geo-Political layer is already initialized');
      viewer = mapViewer;
      dataSource = new Cesium.CustomDataSource('geopolitical-events');
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      handler.setInputAction((event) => {
        if (!enabled) return;
        let picked = null;
        try {
          picked = viewer.scene.pick(event.position);
        } catch {
          picked = null;
        }
        const entityId =
          typeof picked?.id === 'string' ? picked.id : picked?.id?.id;
        const item = findEvent(entityId);
        if (item) choose(item, popupPosition(event.position));
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      this._handler = handler;
    },
    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
    },
    disable() {
      enabled = false;
      request?.abort();
      request = null;
      selected = null;
      clearGdeltSearch();
      clearUcdpSearch();
      if (dataSource) dataSource.show = false;
      notify();
    },
    destroy() {
      this.disable();
      this._handler?.destroy();
      if (dataSource && viewer?.dataSources)
        void viewer.dataSources.remove(dataSource, true);
      dataSource = null;
      viewer = null;
      listeners.clear();
    },
    update,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getPanelState,
    getPopupMarkup() {
      return selected ? popupMarkup(selected.item) : '';
    },
    getStats() {
      const events = mapEntities();
      return {
        eventCount: events.length,
        mappedCount: events.filter(
          (item) =>
            Number.isFinite(item.latitude) && Number.isFinite(item.longitude),
        ).length,
        loading,
        stale: snapshot?.stale === true,
        error,
      };
    },
    getParams() {
      return {};
    },
    setParams() {},
  };
}
