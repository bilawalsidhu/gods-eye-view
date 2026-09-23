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

  const notify = () => rowControlsListener?.();
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
        width: Math.max(2, Math.min(6, 2 + Math.sqrt(flow.share))),
        material: new cesium.PolylineArrowMaterialProperty(
          (cesium.Color.GOLD || cesium.Color.YELLOW).withAlpha(0.8),
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
    for (const observation of entities) {
      if (
        !Number.isFinite(observation.latitude) ||
        !Number.isFinite(observation.longitude) ||
        observation.geographicPrecision !== 'country'
      )
        continue;
      const id = `cyber:${observation.id}`;
      current.add(id);
      let entity = dataSource.entities.getById(id);
      if (!entity) entity = dataSource.entities.add({ id });
      const origin = observation.category.endsWith('-origin');
      const color = origin ? cesium.Color.ORANGERED : cesium.Color.DEEPSKYBLUE;
      const detail = escapeText(observation.detail);
      const title = escapeText(observation.locationName);
      const windowText =
        observation.windowStart && observation.windowEnd
          ? `${escapeText(observation.windowStart)} – ${escapeText(observation.windowEnd)} UTC`
          : '24-hour aggregate window';
      entity.name = `Cloudflare Radar · ${origin ? 'origin' : 'target'} · ${observation.locationName}`;
      entity.position = cesium.Cartesian3.fromDegrees(
        observation.longitude,
        observation.latitude,
      );
      entity.point = {
        pixelSize: Math.max(
          7,
          Math.min(18, 7 + Math.sqrt(observation.share || 0) * 2),
        ),
        color: color.withAlpha(0.86),
        outlineColor: cesium.Color.WHITE.withAlpha(0.9),
        outlineWidth: 1.5,
        heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: 0,
      };
      entity.description =
        `<h3>${title} · ${origin ? 'Origin aggregate' : 'Target aggregate'}</h3>` +
        `<p>${formatShare(observation.share)} of Cloudflare's mitigated HTTP requests, ranked ${observation.rank ?? '—'}.</p>` +
        `<p>${detail}</p>` +
        `<p>Country-level location anchor: ${observation.latitude.toFixed(1)}, ${observation.longitude.toFixed(1)}. Not a device location.</p>` +
        `<p>Window: ${windowText}</p>` +
        `<p>Source: Cloudflare Radar</p>`;
      entity.properties = {
        provider: 'Cloudflare Radar',
        category: observation.category,
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
    for (const entity of [...dataSource.entities.values])
      if (
        (String(entity.id).startsWith('cyber:') ||
          String(entity.id).startsWith('cyber-flow:')) &&
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
      const id = entityId.slice('cyber:'.length);
      const observation = radar?.observations?.find((item) => item.id === id);
      return observation ? { type: 'location', ...observation } : null;
    }
    return null;
  }

  function notifyThreatIntel() {
    threatIntelListener?.(layer.getThreatIntelState());
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
        if (!enabled || !radarEnabled) return;
        let picked = null;
        try {
          picked = viewer.scene.pick(event.position);
        } catch {
          picked = null;
        }
        const rawId = picked?.id;
        const entityId = typeof rawId === 'string' ? rawId : rawId?.id || null;
        selectedRadar = findRadarSelection(entityId);
        notifyThreatIntel();
      }, cesium.ScreenSpaceEventType.LEFT_CLICK);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      loading = false;
      radar = null;
      dshield = null;
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
              : `cyber:${selectedRadar.id}`,
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
          'Orange-red points are origin-country aggregates; blue points are target-country aggregates. Gold arrows use Cloudflare-reported origin-target country pairs and are not physical network routes. DShield IP observations have no defensible coordinates and appear in Cyber Threat Intel. DShield entries may include false positives and are not a blocklist.',
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
      const hasProviderData = Boolean(
        (radarEnabled && radar) || (dshieldEnabled && dshield),
      );
      const radarNeedsKey =
        radarEnabled && radarError?.includes('needs a token') === true;
      return {
        count: dataSource?.entities.values.length || 0,
        countLabel: dataSource?.entities.values.length
          ? `${dataSource.entities.values.length} country aggregates`
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
