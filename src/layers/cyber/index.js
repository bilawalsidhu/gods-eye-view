import * as Cesium from 'cesium';

const RADAR_SOURCE = 'cloudflare-radar';
const DSHIELD_SOURCE = 'dshield';

function escapeText(value) {
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

function formatShare(value) {
  return Number.isFinite(value) ? `${value.toFixed(value < 1 ? 2 : 1)}%` : '—';
}

function arcPositions(origin, target, cesium) {
  let deltaLongitude = target.longitude - origin.longitude;
  if (deltaLongitude > 180) deltaLongitude -= 360;
  if (deltaLongitude < -180) deltaLongitude += 360;
  const samples = 32;
  return Array.from({ length: samples + 1 }, (_, index) => {
    const fraction = index / samples;
    const longitude = origin.longitude + deltaLongitude * fraction;
    const latitude =
      origin.latitude + (target.latitude - origin.latitude) * fraction;
    const height =
      fraction === 0 || fraction === 1
        ? 0
        : Math.sin(Math.PI * fraction) * 1_250_000;
    return cesium.Cartesian3.fromDegrees(longitude, latitude, height);
  });
}

/** One provider-neutral Cyber layer with country aggregates and non-geographic DShield observations. */
export function createCyberLayer({
  source,
  cesium = Cesium,
  updateInterval = 15 * 60_000,
} = {}) {
  if (
    typeof source?.getRadarSnapshot !== 'function' ||
    typeof source?.getDshieldSnapshot !== 'function'
  )
    throw new TypeError('Cyber requires Radar and DShield provider sources');

  let viewer = null;
  let dataSource = null;
  let enabled = false;
  let radarEnabled = true;
  let dshieldEnabled = true;
  let loading = false;
  let request = null;
  let radar = null;
  let dshield = null;
  let radarError = null;
  let dshieldError = null;
  let rowControlsListener = null;
  let threatIntelListener = null;
  let selectionHandler = null;
  let selectedRadar = null;
  let selectedShodan = null;
  const enrichmentResults = new Map();
  const enrichmentPending = new Set();
  const enrichmentRequests = new Set();
  let enrichmentGeneration = 0;
  let shodanSearch = null;
  let shodanAreaSearch = null;
  let enrichmentMessage = '';

  const notify = () => rowControlsListener?.();
  function cacheEnrichmentResult(key, value) {
    enrichmentResults.delete(key);
    enrichmentResults.set(key, value);
    while (enrichmentResults.size > 50)
      enrichmentResults.delete(enrichmentResults.keys().next().value);
  }
  const records = () => [
    ...(radarEnabled ? radar?.observations || [] : []),
    ...(dshieldEnabled ? dshield?.observations || [] : []),
  ];

  function renderRadar() {
    if (!dataSource) return;
    const entities = radarEnabled ? radar?.observations || [] : [];
    const flows = radarEnabled ? radar?.flows || [] : [];
    const current = new Set();
    for (const flow of flows) {
      const id = `cyber-flow:${flow.id}`;
      current.add(id);
      let entity = dataSource.entities.getById(id);
      if (!entity) entity = dataSource.entities.add({ id });
      entity.name = `Cloudflare Radar · ${flow.origin.name} to ${flow.target.name}`;
      entity.polyline = {
        positions: arcPositions(flow.origin, flow.target, cesium),
        // Wider strokes improve visibility and line picking; the arrowhead
        // from PolylineArrow scales with the stroke width.
        width: Math.max(7, Math.min(10, 7 + Math.sqrt(flow.share) * 0.4)),
        material: new cesium.PolylineArrowMaterialProperty(
          cesium.Color.ORANGERED.withAlpha(0.95),
        ),
        arcType: cesium.ArcType.NONE,
        clampToGround: false,
      };
      entity.properties = {
        provider: 'Cloudflare Radar',
        category: 'layer7-origin-target-pair',
        origin: flow.origin.name,
        target: flow.target.name,
        share: flow.share,
        rank: flow.rank,
        geographicPrecision: 'Country-level aggregate anchors',
        geographicMethod: flow.geographicMethod,
        geographicProvenance: flow.geographicProvenance,
        windowStart: flow.windowStart,
        windowEnd: flow.windowEnd,
        attribution: 'Cloudflare Radar',
      };
    }
    const observationsByCountry = new Map();
    for (const observation of entities) {
      if (
        !Number.isFinite(observation.latitude) ||
        !Number.isFinite(observation.longitude) ||
        observation.geographicPrecision !== 'country'
      )
        continue;
      const country = observationsByCountry.get(observation.locationCode) || [];
      country.push(observation);
      observationsByCountry.set(observation.locationCode, country);
    }
    for (const [countryCode, roles] of observationsByCountry) {
      const observation =
        roles.find((row) => row.category.endsWith('-origin')) || roles[0];
      const originObservation = roles.find((row) =>
        row.category.endsWith('-origin'),
      );
      const targetObservation = roles.find((row) =>
        row.category.endsWith('-target'),
      );
      const origin = Boolean(originObservation);
      const target = Boolean(targetObservation);
      const dualRole = origin && target;
      const roleLabel = dualRole
        ? 'origin and target'
        : origin
          ? 'origin'
          : 'target';
      const id = `cyber:location:${countryCode}`;
      current.add(id);
      let entity = dataSource.entities.getById(id);
      if (!entity) entity = dataSource.entities.add({ id });
      const color = dualRole
        ? cesium.Color.MEDIUMPURPLE
        : origin
          ? cesium.Color.ORANGERED
          : cesium.Color.DEEPSKYBLUE;
      const detail = roles.map((row) => escapeText(row.detail)).join(' ');
      const title = escapeText(observation.locationName);
      const windowText =
        observation.windowStart && observation.windowEnd
          ? `${escapeText(observation.windowStart)} – ${escapeText(observation.windowEnd)} UTC`
          : '24-hour aggregate window';
      entity.name = `Cloudflare Radar · ${roleLabel} · ${observation.locationName}`;
      entity.position = cesium.Cartesian3.fromDegrees(
        observation.longitude,
        observation.latitude,
      );
      entity.point = {
        pixelSize: Math.max(
          7,
          Math.min(
            20,
            10 +
              Math.sqrt(
                Math.max(
                  originObservation?.share || 0,
                  targetObservation?.share || 0,
                ),
              ) *
                2,
          ),
        ),
        color: color.withAlpha(0.86),
        outlineColor: cesium.Color.WHITE.withAlpha(0.9),
        outlineWidth: 1.5,
        heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: 0,
      };
      entity.description =
        `<h3>${title} · ${roleLabel} aggregate${dualRole ? 's' : ''}</h3>` +
        (originObservation
          ? `<p>Origin: ${formatShare(originObservation.share)}, rank ${originObservation.rank ?? '—'}.</p>`
          : '') +
        (targetObservation
          ? `<p>Target: ${formatShare(targetObservation.share)}, rank ${targetObservation.rank ?? '—'}.</p>`
          : '') +
        `<p>${detail}</p>` +
        `<p>Country-level location anchor: ${observation.latitude.toFixed(1)}, ${observation.longitude.toFixed(1)}. Not a device location.</p>` +
        `<p>Window: ${windowText}</p>` +
        `<p>Source: Cloudflare Radar</p>`;
      entity.properties = {
        provider: 'Cloudflare Radar',
        category: dualRole
          ? 'layer7-attack-origin-target'
          : observation.category,
        roles: roles.map((row) => ({
          role: row.category.endsWith('-origin') ? 'origin' : 'target',
          share: row.share,
          rank: row.rank,
          detail: row.detail,
        })),
        location: observation.locationName,
        locationCode: observation.locationCode,
        share: observation.share,
        rank: observation.rank,
        geographicPrecision: 'Country-level aggregate anchor',
        geographicMethod: observation.geographicMethod,
        geographicProvenance: observation.geographicProvenance,
        windowStart: observation.windowStart,
        windowEnd: observation.windowEnd,
        attribution: 'Cloudflare Radar',
        detail: observation.detail,
      };
    }
    for (const match of shodanAreaSearch?.matches || []) {
      if (!Number.isFinite(match.latitude) || !Number.isFinite(match.longitude))
        continue;
      const id = `cyber-shodan:${match.ip}`;
      current.add(id);
      let entity = dataSource.entities.getById(id);
      if (!entity) entity = dataSource.entities.add({ id });
      entity.name = `Shodan asset · ${match.ip}`;
      entity.position = cesium.Cartesian3.fromDegrees(
        match.longitude,
        match.latitude,
      );
      entity.point = {
        pixelSize: 10,
        color: cesium.Color.GOLD.withAlpha(0.96),
        outlineColor: cesium.Color.WHITE.withAlpha(0.95),
        outlineWidth: 1.5,
        heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: 0,
      };
      entity.properties = {
        provider: 'Shodan',
        ip: match.ip,
        geographicPrecision: match.geographicPrecision,
        geographicMethod: match.geographicMethod,
        geographicProvenance: match.geographicProvenance,
        attribution: match.attribution,
      };
    }
    for (const entity of [...dataSource.entities.values])
      if (
        (String(entity.id).startsWith('cyber:') ||
          String(entity.id).startsWith('cyber-flow:') ||
          String(entity.id).startsWith('cyber-shodan:')) &&
        !current.has(entity.id)
      )
        dataSource.entities.remove(entity);
    dataSource.show = enabled;
  }

  function findRadarSelection(entityId) {
    if (!radarEnabled || typeof entityId !== 'string') return null;
    if (entityId.startsWith('cyber-flow:')) {
      const id = entityId.slice('cyber-flow:'.length);
      const flow = radar?.flows?.find((item) => item.id === id);
      return flow ? { type: 'flow', ...flow } : null;
    }
    if (entityId.startsWith('cyber:')) {
      const code = entityId.slice('cyber:location:'.length);
      const observations =
        radar?.observations?.filter((item) => item.locationCode === code) || [];
      if (!observations.length) return null;
      return {
        type: 'location',
        entityId: `cyber:location:${code}`,
        roles: observations.map((item) => ({
          role: item.category.endsWith('-origin') ? 'origin' : 'target',
          share: item.share,
          rank: item.rank,
        })),
        ...observations[0],
      };
    }
    return null;
  }

  function findShodanSelection(entityId) {
    if (!entityId?.startsWith?.('cyber-shodan:')) return null;
    const ip = entityId.slice('cyber-shodan:'.length);
    return shodanAreaSearch?.matches?.find((match) => match.ip === ip) || null;
  }

  function viewportArea() {
    const rectangle = viewer?.camera?.computeViewRectangle?.(
      viewer.scene?.globe?.ellipsoid || cesium.Ellipsoid?.WGS84,
    );
    if (!rectangle || !cesium.Rectangle?.center) return null;
    const center = cesium.Rectangle.center(rectangle);
    if (
      !center ||
      !Number.isFinite(center.latitude) ||
      !Number.isFinite(center.longitude)
    )
      return null;
    const radius = (lat, lon) => {
      const dLat = lat - center.latitude;
      let dLon = lon - center.longitude;
      if (dLon > Math.PI) dLon -= Math.PI * 2;
      if (dLon < -Math.PI) dLon += Math.PI * 2;
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(center.latitude) * Math.cos(lat) * Math.sin(dLon / 2) ** 2;
      return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    };
    const corners = [
      [rectangle.south, rectangle.west],
      [rectangle.south, rectangle.east],
      [rectangle.north, rectangle.west],
      [rectangle.north, rectangle.east],
    ];
    const radiusKm = Math.ceil(
      Math.max(...corners.map(([lat, lon]) => radius(lat, lon))),
    );
    return {
      latitude: (center.latitude * 180) / Math.PI,
      longitude: (center.longitude * 180) / Math.PI,
      radiusKm,
    };
  }

  function notifyThreatIntel() {
    threatIntelListener?.(layer.getThreatIntelState());
  }

  async function enrichIp(provider, ip) {
    if (!enabled || !['shodan', 'greynoise'].includes(provider)) return;
    const key = `${provider}:${ip}`;
    if (enrichmentPending.has(key)) return;
    const operation =
      provider === 'shodan' ? source.lookupShodanHost : source.lookupGreyNoise;
    if (typeof operation !== 'function') {
      enrichmentMessage =
        'This provider is unavailable in the current session.';
      notifyThreatIntel();
      return;
    }
    enrichmentPending.add(key);
    const generation = enrichmentGeneration;
    const controller = new AbortController();
    enrichmentRequests.add(controller);
    enrichmentMessage = '';
    notifyThreatIntel();
    try {
      const result = await operation(ip, { signal: controller.signal });
      if (enabled && generation === enrichmentGeneration)
        cacheEnrichmentResult(key, result);
    } catch (error) {
      if (enabled && generation === enrichmentGeneration)
        cacheEnrichmentResult(key, {
          error: error?.message || 'Provider request failed.',
        });
    } finally {
      enrichmentRequests.delete(controller);
      if (generation === enrichmentGeneration) {
        enrichmentPending.delete(key);
        notifyThreatIntel();
      }
    }
  }

  async function runShodanSearch(query, page = 1) {
    if (!enabled || typeof source.searchShodan !== 'function') return;
    const generation = enrichmentGeneration;
    const controller = new AbortController();
    enrichmentRequests.add(controller);
    enrichmentMessage = '';
    shodanSearch = { query, page, loading: true };
    notifyThreatIntel();
    try {
      const result = await source.searchShodan(query, page, {
        signal: controller.signal,
      });
      if (enabled && generation === enrichmentGeneration) shodanSearch = result;
    } catch (error) {
      if (enabled && generation === enrichmentGeneration)
        shodanSearch = {
          query,
          page,
          error: error?.message || 'Shodan search failed.',
        };
    } finally {
      enrichmentRequests.delete(controller);
    }
    if (enabled && generation === enrichmentGeneration) notifyThreatIntel();
  }

  async function runShodanAreaSearch() {
    if (!enabled || typeof source.searchShodanArea !== 'function') return;
    const area = viewportArea();
    if (!area || area.radiusKm < 1 || area.radiusKm > 1000) {
      shodanAreaSearch = {
        error:
          'Zoom in to an area with a radius of 1,000 km or less to search Shodan.',
      };
      selectedShodan = null;
      selectedRadar = null;
      renderRadar();
      notifyThreatIntel();
      return;
    }
    const generation = enrichmentGeneration;
    const controller = new AbortController();
    enrichmentRequests.add(controller);
    enrichmentMessage = '';
    selectedShodan = null;
    selectedRadar = null;
    shodanAreaSearch = { ...area, loading: true };
    renderRadar();
    notifyThreatIntel();
    try {
      const result = await source.searchShodanArea(area, {
        signal: controller.signal,
      });
      if (enabled && generation === enrichmentGeneration)
        shodanAreaSearch = { ...result, ...area };
    } catch (error) {
      if (enabled && generation === enrichmentGeneration)
        shodanAreaSearch = {
          ...area,
          error: error?.message || 'Shodan area search failed.',
        };
    } finally {
      enrichmentRequests.delete(controller);
    }
    if (enabled && generation === enrichmentGeneration) {
      renderRadar();
      notifyThreatIntel();
    }
  }

  function setParams(params = {}) {
    let changed = false;
    if (
      typeof params.radarEnabled === 'boolean' &&
      params.radarEnabled !== radarEnabled
    ) {
      radarEnabled = params.radarEnabled;
      changed = true;
      if (!radarEnabled) {
        radar = null;
        radarError = null;
        selectedRadar = null;
      }
    }
    if (
      typeof params.dshieldEnabled === 'boolean' &&
      params.dshieldEnabled !== dshieldEnabled
    ) {
      dshieldEnabled = params.dshieldEnabled;
      changed = true;
      if (!dshieldEnabled) {
        dshield = null;
        dshieldError = null;
      }
    }
    if (!changed) return;
    request?.abort();
    request = null;
    loading = false;
    renderRadar();
    notify();
    notifyThreatIntel();
    if (enabled) queueMicrotask(() => void layer.update(viewer));
  }

  function sourceStatus(name, snapshot, error) {
    if (!snapshot) return error || (loading ? 'loading' : 'waiting for data');
    return `${snapshot.stale ? 'cached / stale' : 'updated'} ${snapshot.fetchedAt}`;
  }

  const layer = {
    id: 'cyber',
    name: 'Cyber Activity',
    icon: '⬡',
    source: 'Cloudflare Radar · SANS ISC / DShield',
    requiresKeyId: 'cloudflare-radar',
    updateInterval,

    init(mapViewer) {
      if (viewer) throw new Error('Cyber layer is already initialized');
      viewer = mapViewer;
      dataSource = new cesium.CustomDataSource('cyber-activity');
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      selectionHandler = new cesium.ScreenSpaceEventHandler(
        viewer.scene.canvas,
      );
      selectionHandler.setInputAction((event) => {
        if (!enabled) return;
        let picked = null;
        try {
          picked = viewer.scene.pick(event.position);
        } catch {
          picked = null;
        }
        const rawId = picked?.id;
        const entityId = typeof rawId === 'string' ? rawId : rawId?.id || null;
        selectedShodan = findShodanSelection(entityId);
        selectedRadar = selectedShodan ? null : findRadarSelection(entityId);
        notifyThreatIntel();
      }, cesium.ScreenSpaceEventType.LEFT_CLICK);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
    },

    disable() {
      enrichmentGeneration++;
      for (const controller of enrichmentRequests) controller.abort();
      enrichmentRequests.clear();
      request?.abort();
      request = null;
      enabled = false;
      loading = false;
      radar = null;
      dshield = null;
      enrichmentResults.clear();
      enrichmentPending.clear();
      shodanSearch = null;
      shodanAreaSearch = null;
      selectedShodan = null;
      radarError = null;
      dshieldError = null;
      dataSource?.entities.removeAll();
      if (dataSource) dataSource.show = false;
      selectedRadar = null;
      notify();
      notifyThreatIntel();
    },

    async update() {
      if (!enabled) return false;
      request?.abort();
      const controller = new AbortController();
      request = controller;
      loading = true;
      notify();
      const tasks = [];
      if (radarEnabled)
        tasks.push(
          source.getRadarSnapshot({ signal: controller.signal }).then(
            (value) => ({ provider: RADAR_SOURCE, value }),
            (error) => ({ provider: RADAR_SOURCE, error }),
          ),
        );
      if (dshieldEnabled)
        tasks.push(
          source.getDshieldSnapshot({ signal: controller.signal }).then(
            (value) => ({ provider: DSHIELD_SOURCE, value }),
            (error) => ({ provider: DSHIELD_SOURCE, error }),
          ),
        );
      try {
        const outcomes = await Promise.all(tasks);
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        let succeeded = false;
        for (const outcome of outcomes) {
          if (outcome.error) {
            if (outcome.provider === RADAR_SOURCE)
              radarError = outcome.error.message;
            else dshieldError = outcome.error.message;
            continue;
          }
          succeeded = true;
          if (outcome.provider === RADAR_SOURCE) {
            radar = outcome.value;
            radarError = null;
          } else {
            dshield = outcome.value;
            dshieldError = null;
          }
        }
        renderRadar();
        if (selectedRadar) {
          selectedRadar = findRadarSelection(
            selectedRadar.type === 'flow'
              ? `cyber-flow:${selectedRadar.id}`
              : selectedRadar.entityId,
          );
        }
        notifyThreatIntel();
        return succeeded;
      } finally {
        if (request === controller) {
          request = null;
          loading = false;
          notify();
        }
      }
    },

    setParams,
    getParams() {
      return { radarEnabled, dshieldEnabled };
    },
    getRowControls() {
      const chips = [
        {
          id: 'cyber-radar',
          label: 'Cloudflare Radar',
          active: radarEnabled,
          params: { radarEnabled: !radarEnabled },
          title: radarEnabled
            ? 'Hide Radar aggregates'
            : 'Show Radar aggregates',
        },
        {
          id: 'cyber-dshield',
          label: 'DShield',
          active: dshieldEnabled,
          params: { dshieldEnabled: !dshieldEnabled },
          title: dshieldEnabled
            ? 'Hide DShield observations'
            : 'Show DShield observations',
        },
      ];
      const items = [];
      if (radarEnabled && radar) {
        for (const observation of radar.observations) {
          items.push({
            id: observation.id,
            lead: `Radar ${observation.category.endsWith('-origin') ? 'origin' : 'target'} · ${observation.rank}`,
            text: `${observation.locationName} · ${formatShare(observation.share)} · country aggregate`,
            disabled: true,
          });
        }
      }
      if (dshieldEnabled && dshield) {
        for (const observation of dshield.observations) {
          items.push({
            id: observation.id,
            lead: `DShield IP · ${observation.rank}`,
            text: `${observation.indicator?.value || 'Unavailable'}${observation.hostname ? ` · ${observation.hostname}` : ''} · no geographic data`,
            disabled: true,
          });
        }
        for (const port of dshield.ports) {
          items.push({
            id: `dshield-port-${port.port}`,
            lead: `DShield port · ${port.rank}`,
            text: `${port.port}/${port.protocol} · ${port.label}`,
            disabled: true,
          });
        }
      }
      const infos = [];
      if (radarEnabled) {
        infos.push(
          `Cloudflare Radar · ${sourceStatus(RADAR_SOURCE, radar, radarError)}${radar?.stale ? ' · cached data' : ''}`,
        );
      }
      if (dshieldEnabled) {
        infos.push(
          `SANS ISC / DShield · ${sourceStatus(DSHIELD_SOURCE, dshield, dshieldError)}${dshield?.stale ? ' · cached data' : ''}`,
        );
        if (dshield) infos.push(dshield.notice);
      }
      return {
        chips,
        list: {
          ariaLabel: 'Cyber provider observations',
          items: items.slice(0, 40),
        },
        info: infos.join('\n'),
        infoTitle:
          'Orange-red points are origin countries; blue points are target countries; purple points represent countries in both lists. Red arrows show only Cloudflare-reported top origin-target country pairs (up to 10); an unconnected dot has no pair in that displayed set. Gold points are optional Shodan devices from an operator-triggered area search and show approximate IP network positions. Arrows are aggregate associations, not physical routes. DShield observations appear in Cyber Threat Intel and may include false positives.',
      };
    },
    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },
    setThreatIntelListener(listener) {
      threatIntelListener = typeof listener === 'function' ? listener : null;
      notifyThreatIntel();
    },
    getThreatIntelState() {
      return {
        enabled,
        selectedRadar: selectedRadar ? { ...selectedRadar } : null,
        enrichmentResults: Object.fromEntries(enrichmentResults),
        enrichmentPending: [...enrichmentPending],
        shodanSearch,
        enrichmentMessage,
        onEnrichIp: enrichIp,
        onShodanSearch: runShodanSearch,
        shodanAreaSearch,
        selectedShodan,
        onShodanAreaSearch: runShodanAreaSearch,
        nonGeographicProviders: dshieldEnabled
          ? [
              {
                id: DSHIELD_SOURCE,
                label: 'SANS ISC / DShield',
                status: sourceStatus(DSHIELD_SOURCE, dshield, dshieldError),
                fetchedAt: dshield?.fetchedAt || null,
                stale: dshield?.stale === true,
                attribution:
                  dshield?.attribution ||
                  'SANS Internet Storm Center / DShield',
                notice:
                  dshield?.notice ||
                  'Reported source data; it may include false positives and is not a blocklist.',
                observations: dshield?.observations || [],
                ports: dshield?.ports || [],
                enrichmentResults: Object.fromEntries(enrichmentResults),
                enrichmentPending: [...enrichmentPending],
                shodanSearch,
                onEnrichIp: enrichIp,
                onShodanSearch: runShodanSearch,
                shodanAreaSearch,
                selectedShodan,
                onShodanAreaSearch: runShodanAreaSearch,
                error: dshieldError,
              },
            ]
          : [],
      };
    },
    getAnalystRecords(maxCount = 100) {
      const limit = Number.isInteger(maxCount)
        ? Math.max(1, Math.min(maxCount, 100))
        : 100;
      return records()
        .slice(0, limit)
        .map((record) => ({ ...record }));
    },
    getStats() {
      const issues = [radarError, dshieldError].filter(Boolean);
      const mapEntities = dataSource?.entities.values || [];
      const countryCount = mapEntities.filter((entity) =>
        String(entity.id).startsWith('cyber:location:'),
      ).length;
      const flowCount = mapEntities.filter((entity) =>
        String(entity.id).startsWith('cyber-flow:'),
      ).length;
      const shodanCount = mapEntities.filter((entity) =>
        String(entity.id).startsWith('cyber-shodan:'),
      ).length;
      const hasProviderData = Boolean(
        (radarEnabled && radar) || (dshieldEnabled && dshield),
      );
      const radarNeedsKey =
        radarEnabled && radarError?.includes('needs a token') === true;
      return {
        count: dataSource?.entities.values.length || 0,
        countLabel: mapEntities.length
          ? `${countryCount} countries · ${flowCount} flows · ${shodanCount} Shodan`
          : 'Provider observations',
        loading,
        keyRequired: radarNeedsKey && !hasProviderData,
        stale: Boolean(radar?.stale || dshield?.stale),
        error: issues.length && !hasProviderData ? issues.join(' · ') : null,
        radarCount: radarEnabled ? radar?.observations.length || 0 : 0,
        dshieldCount: dshieldEnabled ? dshield?.observations.length || 0 : 0,
        source: 'Cloudflare Radar · SANS ISC / DShield',
      };
    },
    destroy(destroyViewer = viewer) {
      layer.disable();
      enrichmentResults.clear();
      enrichmentPending.clear();
      shodanSearch = null;
      shodanAreaSearch = null;
      selectionHandler?.destroy();
      selectionHandler = null;
      rowControlsListener = null;
      threatIntelListener = null;
      if (dataSource) destroyViewer?.dataSources?.remove(dataSource, true);
      dataSource = null;
      viewer = null;
    },
  };
  return layer;
}
