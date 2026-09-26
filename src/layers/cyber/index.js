import * as Cesium from 'cesium';
import { createCyberMarkerImage } from './markers.js';

const RADAR_SOURCE = 'cloudflare-radar';
const DSHIELD_SOURCE = 'dshield';
const KEV_SOURCE = 'cisa-kev';
const IODA_SOURCE = 'ioda';

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

function radarFlowColor(cesium, fraction) {
  const start = cesium.Color.ORANGERED;
  const end = cesium.Color.DEEPSKYBLUE;
  if (
    typeof cesium.Color === 'function' &&
    Number.isFinite(start.red) &&
    Number.isFinite(end.red)
  ) {
    return new cesium.Color(
      start.red + (end.red - start.red) * fraction,
      start.green + (end.green - start.green) * fraction,
      start.blue + (end.blue - start.blue) * fraction,
      1,
    );
  }
  // Lightweight Cesium test doubles may expose named colors without channels.
  return fraction < 1 ? start : end;
}

function shodanDisplayLayout(matches, viewer) {
  const groups = new Map();
  for (const match of matches) {
    if (!Number.isFinite(match.latitude) || !Number.isFinite(match.longitude))
      continue;
    const key = `${match.latitude.toFixed(5)}:${match.longitude.toFixed(5)}`;
    const group = groups.get(key) || [];
    group.push(match);
    groups.set(key, group);
  }
  const canvas = viewer?.scene?.canvas;
  const canvasHeight = canvas?.clientHeight || canvas?.height || 800;
  const cameraHeight = viewer?.camera?.positionCartographic?.height;
  const fovy = viewer?.camera?.frustum?.fovy;
  const metersPerPixel =
    Number.isFinite(cameraHeight) &&
    cameraHeight > 0 &&
    Number.isFinite(fovy) &&
    fovy > 0 &&
    canvasHeight > 0
      ? (2 * cameraHeight * Math.tan(fovy / 2)) / canvasHeight
      : 1;
  const layout = new Map();
  for (const group of groups.values()) {
    group.sort((left, right) => left.ip.localeCompare(right.ip));
    if (group.length === 1) {
      layout.set(group[0].ip, {
        latitude: group[0].latitude,
        longitude: group[0].longitude,
        visualOffsetMeters: 0,
      });
      continue;
    }
    const radiusMeters = Math.max(
      10,
      Math.min(
        250,
        (metersPerPixel * 18) / (2 * Math.sin(Math.PI / group.length)),
      ),
    );
    const anchorLatitude = group[0].latitude;
    const anchorLongitude = group[0].longitude;
    const longitudeScale = Math.max(
      0.05,
      Math.cos((anchorLatitude * Math.PI) / 180),
    );
    group.forEach((match, index) => {
      const angle = (2 * Math.PI * index) / group.length - Math.PI / 2;
      const northMeters = Math.cos(angle) * radiusMeters;
      const eastMeters = Math.sin(angle) * radiusMeters;
      layout.set(match.ip, {
        latitude: anchorLatitude + northMeters / 111_320,
        longitude: anchorLongitude + eastMeters / (111_320 * longitudeScale),
        visualOffsetMeters: radiusMeters,
        anchorLatitude,
        anchorLongitude,
      });
    });
  }
  return layout;
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

/** Provider-neutral Cyber layer with country aggregates and threat context. */
export function createCyberLayer({
  source,
  cesium = Cesium,
  updateInterval = 15 * 60_000,
} = {}) {
  if (
    typeof source?.getRadarSnapshot !== 'function' ||
    typeof source?.getDshieldSnapshot !== 'function' ||
    typeof source?.getKevSnapshot !== 'function' ||
    typeof source?.getIodaSnapshot !== 'function'
  )
    throw new TypeError(
      'Cyber requires Radar, DShield, CISA KEV, and IODA sources',
    );

  let viewer = null;
  let dataSource = null;
  let shodanDataSource = null;
  let iodaDataSource = null;
  let enabled = false;
  let radarEnabled = true;
  let dshieldEnabled = true;
  let iodaEnabled = true;
  let loading = false;
  let request = null;
  let radar = null;
  let dshield = null;
  let kev = null;
  let iodaSnapshot = null;
  let radarError = null;
  let dshieldError = null;
  let kevError = null;
  let iodaError = null;
  const kevByCve = new Map();
  let rowControlsListener = null;
  let threatIntelListener = null;
  let selectionHandler = null;
  let selectedRadar = null;
  let selectedIoda = null;
  let selectedShodan = null;
  const shodanVisualOffsets = new Map();
  const enrichmentResults = new Map();
  const enrichmentPending = new Set();
  const otxResults = new Map();
  const otxPending = new Set();
  const enrichmentRequests = new Set();
  let enrichmentGeneration = 0;
  let shodanSearch = null;
  let shodanAreaSearch = null;
  let selectedOtxKey = null;
  let enrichmentMessage = '';

  function getPopupPosition(position) {
    const rect = viewer?.scene?.canvas?.getBoundingClientRect?.();
    return Number.isFinite(position?.x) && Number.isFinite(position?.y)
      ? {
          x: (rect?.left || 0) + position.x,
          y: (rect?.top || 0) + position.y,
        }
      : null;
  }

  function cacheOtxResult(key, result) {
    otxResults.delete(key);
    otxResults.set(key, result);
    while (otxResults.size > 20)
      otxResults.delete(otxResults.keys().next().value);
  }

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
      const positions = arcPositions(flow.origin, flow.target, cesium);
      const segmentCount = positions.length - 1;
      const intervalCount = positions.length - 1;
      const lineWidth = 4;
      const properties = {
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
      for (let index = 0; index < segmentCount; index++) {
        const startIndex = Math.floor((index * intervalCount) / segmentCount);
        const endIndex = Math.floor(
          ((index + 1) * intervalCount) / segmentCount,
        );
        const segmentId = index === 0 ? id : `${id}:gradient:${index}`;
        current.add(segmentId);
        let entity = dataSource.entities.getById(segmentId);
        if (!entity) entity = dataSource.entities.add({ id: segmentId });
        const isTargetSegment = index === segmentCount - 1;
        const color = radarFlowColor(
          cesium,
          index / (segmentCount - 1),
        ).withAlpha(0.98);
        entity.name = `Cloudflare Radar · ${flow.origin.name} to ${flow.target.name}`;
        entity.polyline = {
          positions: positions.slice(startIndex, endIndex + 1),
          // Keep every shaft segment equally thin; blue color marks the target.
          width: lineWidth,
          material: isTargetSegment
            ? new cesium.PolylineArrowMaterialProperty(
                cesium.Color.DEEPSKYBLUE.withAlpha(1),
              )
            : color,
          arcType: cesium.ArcType.NONE,
          clampToGround: false,
        };
        entity.properties = properties;
      }
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
    const flowRolesByCountry = new Map();
    for (const flow of flows) {
      for (const [role, endpoint] of [
        ['origin', flow.origin],
        ['target', flow.target],
      ]) {
        const countryFlows = flowRolesByCountry.get(endpoint.code) || [];
        countryFlows.push({ role, endpoint, flow });
        flowRolesByCountry.set(endpoint.code, countryFlows);
      }
    }
    const countryCodes = new Set([
      ...observationsByCountry.keys(),
      ...flowRolesByCountry.keys(),
    ]);
    for (const countryCode of countryCodes) {
      const roles = observationsByCountry.get(countryCode) || [];
      const flowRoles = flowRolesByCountry.get(countryCode) || [];
      const observation =
        roles.find((row) => row.category.endsWith('-origin')) ||
        roles[0] ||
        flowRoles[0]?.endpoint;
      const originObservation = roles.find((row) =>
        row.category.endsWith('-origin'),
      );
      const targetObservation = roles.find((row) =>
        row.category.endsWith('-target'),
      );
      const hasFlowOrigin = flowRoles.some((row) => row.role === 'origin');
      const hasFlowTarget = flowRoles.some((row) => row.role === 'target');
      const origin = Boolean(originObservation || hasFlowOrigin);
      const target = Boolean(targetObservation || hasFlowTarget);
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
      const detail = roles.map((row) => escapeText(row.detail)).join(' ');
      const locationName = observation.locationName || observation.name;
      const title = escapeText(locationName);
      const windowText =
        observation.windowStart && observation.windowEnd
          ? `${escapeText(observation.windowStart)} – ${escapeText(observation.windowEnd)} UTC`
          : flowRoles[0]?.flow.windowStart && flowRoles[0]?.flow.windowEnd
            ? `${escapeText(flowRoles[0].flow.windowStart)} – ${escapeText(flowRoles[0].flow.windowEnd)} UTC`
            : '24-hour aggregate window';
      entity.name = `Cloudflare Radar · ${roleLabel} · ${locationName}`;
      entity.position = cesium.Cartesian3.fromDegrees(
        observation.longitude,
        observation.latitude,
      );
      const markerKind = dualRole ? 'both' : origin ? 'origin' : 'target';
      const markerColor = dualRole ? '#9370db' : origin ? '#ff4500' : '#00bfff';
      const markerSize = Math.max(
        24,
        Math.min(
          34,
          24 +
            Math.sqrt(
              Math.max(
                originObservation?.share || 0,
                targetObservation?.share || 0,
              ),
            ) *
              1.2,
        ),
      );
      entity.point = undefined;
      entity.billboard = {
        image: createCyberMarkerImage(markerKind, markerColor),
        width: markerSize,
        height: markerSize,
        heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: 0,
      };
      entity.description =
        `<h3>${title} · ${roleLabel} country role${dualRole ? 's' : ''}</h3>` +
        (originObservation
          ? `<p>Origin: ${formatShare(originObservation.share)}, rank ${originObservation.rank ?? '—'}.</p>`
          : '') +
        (targetObservation
          ? `<p>Target: ${formatShare(targetObservation.share)}, rank ${targetObservation.rank ?? '—'}.</p>`
          : '') +
        (detail ? `<p>${detail}</p>` : '') +
        (!originObservation && hasFlowOrigin
          ? '<p>Origin role: included in the displayed country-pair flow list; no separate top-origin country share is available.</p>'
          : '') +
        (!targetObservation && hasFlowTarget
          ? '<p>Target role: included in the displayed country-pair flow list; no separate top-target country share is available.</p>'
          : '') +
        `<p>Country-level location anchor: ${observation.latitude.toFixed(1)}, ${observation.longitude.toFixed(1)}. Not a device location.</p>` +
        `<p>Window: ${windowText}</p>` +
        `<p>Source: Cloudflare Radar</p>`;
      entity.properties = {
        provider: 'Cloudflare Radar',
        category: dualRole
          ? 'layer7-attack-origin-target'
          : origin
            ? 'layer7-attack-origin'
            : 'layer7-attack-target',
        roles: roles.map((row) => ({
          role: row.category.endsWith('-origin') ? 'origin' : 'target',
          share: row.share,
          rank: row.rank,
          detail: row.detail,
        })),
        flowRoles: flowRoles.map(({ role, flow }) => ({
          role,
          flowId: flow.id,
          flowName: `${flow.origin.name} → ${flow.target.name}`,
          share: flow.share,
          rank: flow.rank,
        })),
        location: locationName,
        locationCode: countryCode,
        share: observation.share ?? null,
        rank: observation.rank ?? null,
        geographicPrecision: 'Country-level aggregate anchor',
        geographicMethod:
          observation.geographicMethod ||
          'Cloudflare Radar country reference coordinates',
        geographicProvenance:
          observation.geographicProvenance ||
          'Cloudflare Radar country-level origin/target pair; country reference anchor.',
        windowStart: observation.windowStart || flowRoles[0]?.flow.windowStart,
        windowEnd: observation.windowEnd || flowRoles[0]?.flow.windowEnd,
        attribution: 'Cloudflare Radar',
        detail: observation.detail || detail,
      };
    }
    const shodanEntities = shodanDataSource?.entities;
    const currentShodan = new Set();
    const shodanMatches = shodanAreaSearch?.matches || [];
    const displayLayout = shodanDisplayLayout(shodanMatches, viewer);
    shodanVisualOffsets.clear();
    for (const match of shodanMatches) {
      if (!Number.isFinite(match.latitude) || !Number.isFinite(match.longitude))
        continue;
      const id = `cyber-shodan:${match.ip}`;
      currentShodan.add(id);
      const display = displayLayout.get(match.ip);
      shodanVisualOffsets.set(match.ip, display?.visualOffsetMeters || 0);
      let entity = shodanEntities?.getById(id);
      if (!entity) entity = shodanEntities?.add({ id });
      if (!entity) continue;
      entity.name = `Shodan asset · ${match.ip}`;
      entity.position = cesium.Cartesian3.fromDegrees(
        display?.longitude ?? match.longitude,
        display?.latitude ?? match.latitude,
      );
      entity.point = undefined;
      entity.billboard = {
        image: createCyberMarkerImage('shodan', '#ffd34e'),
        width: 27,
        height: 27,
        heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: 0,
      };
      entity.properties = {
        provider: 'Shodan',
        ip: match.ip,
        geographicPrecision: match.geographicPrecision,
        geographicMethod: match.geographicMethod,
        geographicProvenance: match.geographicProvenance,
        visualOffsetMeters: display?.visualOffsetMeters || 0,
        attribution: match.attribution,
        kevMatches: (match.services || [])
          .flatMap((service) => service.vulnerabilities || [])
          .filter((cve) => kevByCve.has(cve.toUpperCase())).length,
      };
      if (display?.visualOffsetMeters && display.anchorLatitude != null) {
        const linkId = `cyber-shodan-link:${match.ip}`;
        currentShodan.add(linkId);
        let link = shodanEntities.getById(linkId);
        if (!link) link = shodanEntities.add({ id: linkId });
        if (link)
          link.polyline = {
            positions: [
              cesium.Cartesian3.fromDegrees(
                display.anchorLongitude,
                display.anchorLatitude,
              ),
              cesium.Cartesian3.fromDegrees(
                display.longitude,
                display.latitude,
              ),
            ],
            width: 1.5,
            material: cesium.Color.GOLD.withAlpha(0.65),
            // GroundPolylineGeometry accepts only GEODESIC or RHUMB arcs.
            arcType: cesium.ArcType.GEODESIC,
            clampToGround: true,
          };
      }
    }
    for (const entity of [...(shodanEntities?.values || [])])
      if (
        (String(entity.id).startsWith('cyber-shodan:') ||
          String(entity.id).startsWith('cyber-shodan-link:')) &&
        !currentShodan.has(entity.id)
      )
        shodanEntities.remove(entity);
    for (const entity of [...dataSource.entities.values])
      if (
        (String(entity.id).startsWith('cyber:') ||
          String(entity.id).startsWith('cyber-flow:')) &&
        !current.has(entity.id)
      )
        dataSource.entities.remove(entity);
    dataSource.show = enabled;
    renderIoda();
  }

  function renderIoda() {
    if (!iodaDataSource) return;
    const current = new Set();
    for (const country of iodaEnabled ? iodaSnapshot?.countries || [] : []) {
      const id = `cyber-ioda:${country.countryCode}`;
      current.add(id);
      let entity = iodaDataSource.entities.getById(id);
      if (!entity) entity = iodaDataSource.entities.add({ id });
      entity.name = `IODA connectivity event · ${country.countryName}`;
      entity.position = cesium.Cartesian3.fromDegrees(
        country.longitude,
        country.latitude,
      );
      entity.point = undefined;
      const markerSize = Math.max(27, Math.min(36, 27 + country.eventCount));
      entity.billboard = {
        image: createCyberMarkerImage('ioda', '#00d9e8'),
        width: markerSize,
        height: markerSize,
        heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: 0,
      };
      entity.properties = {
        provider: 'IODA',
        category: 'country-connectivity-events',
        countryCode: country.countryCode,
        countryName: country.countryName,
        eventCount: country.eventCount,
        latestEventAt: country.latestEventAt,
        geographicPrecision: country.geographicPrecision,
        geographicMethod: country.geographicMethod,
        geographicProvenance: country.geographicProvenance,
        attribution: iodaSnapshot?.attribution,
      };
      entity.description =
        `<h3>IODA connectivity events · ${escapeText(country.countryName)}</h3>` +
        `<p>${country.eventCount} event${country.eventCount === 1 ? '' : 's'} reported in the last 24 hours.</p>` +
        `<p>Country reference point only. This is not the outage location, and the event does not establish its cause.</p>` +
        `<p>Latest event: ${escapeText(country.latestEventAt)}</p>` +
        `<p>Sources: ${escapeText(country.datasources.join(', '))}</p>` +
        `<p>Source: ${escapeText(iodaSnapshot?.attribution || 'IODA')}</p>`;
    }
    for (const entity of [...iodaDataSource.entities.values])
      if (!current.has(entity.id)) iodaDataSource.entities.remove(entity);
    iodaDataSource.show = enabled && iodaEnabled;
  }

  function findRadarSelection(entityId) {
    if (!radarEnabled || typeof entityId !== 'string') return null;
    if (entityId.startsWith('cyber-flow:')) {
      const id = entityId
        .slice('cyber-flow:'.length)
        .replace(/:gradient:\d+$/, '');
      const flow = radar?.flows?.find((item) => item.id === id);
      return flow ? { type: 'flow', ...flow } : null;
    }
    if (entityId.startsWith('cyber:')) {
      const code = entityId.slice('cyber:location:'.length);
      const observations =
        radar?.observations?.filter((item) => item.locationCode === code) || [];
      const flows =
        radar?.flows?.filter(
          (flow) => flow.origin.code === code || flow.target.code === code,
        ) || [];
      if (!observations.length && !flows.length) return null;
      const roles = new Map();
      for (const item of observations) {
        const role = item.category.endsWith('-origin') ? 'origin' : 'target';
        roles.set(role, {
          role,
          share: item.share,
          rank: item.rank,
          source: 'country aggregate',
          flowCount: 0,
        });
      }
      const flowRoles = [];
      for (const flow of flows) {
        for (const [role, endpoint] of [
          ['origin', flow.origin],
          ['target', flow.target],
        ]) {
          if (endpoint.code !== code) continue;
          flowRoles.push({
            role,
            flowId: flow.id,
            flowName: `${flow.origin.name} → ${flow.target.name}`,
            share: flow.share,
            rank: flow.rank,
          });
          const existing = roles.get(role);
          if (existing) existing.flowCount += 1;
          else
            roles.set(role, {
              role,
              share: null,
              rank: null,
              source: 'country-pair flow',
              flowCount: 1,
            });
        }
      }
      const anchor =
        observations[0] ||
        (flows[0]?.origin.code === code ? flows[0].origin : flows[0]?.target);
      const roleList = [...roles.values()];
      return {
        type: 'location',
        entityId: `cyber:location:${code}`,
        ...(observations[0] || {}),
        provider: 'cloudflare-radar',
        category:
          roleList.length > 1
            ? 'layer7-attack-origin-target'
            : roleList[0]?.role === 'origin'
              ? 'layer7-attack-origin'
              : 'layer7-attack-target',
        locationName: observations[0]?.locationName || anchor.name,
        locationCode: code,
        latitude: observations[0]?.latitude ?? anchor.latitude,
        longitude: observations[0]?.longitude ?? anchor.longitude,
        geographicPrecision: 'country',
        geographicMethod:
          observations[0]?.geographicMethod ||
          'Cloudflare Radar country reference coordinates',
        geographicProvenance:
          observations[0]?.geographicProvenance ||
          'Cloudflare Radar country-level origin/target pair; country reference anchor.',
        windowStart: observations[0]?.windowStart || flows[0]?.windowStart,
        windowEnd: observations[0]?.windowEnd || flows[0]?.windowEnd,
        attribution: 'Cloudflare Radar',
        roles: roleList,
        flowRoles,
      };
    }
    return null;
  }

  function findShodanSelection(entityId) {
    if (!entityId?.startsWith?.('cyber-shodan:')) return null;
    const ip = entityId.slice('cyber-shodan:'.length);
    const match =
      shodanAreaSearch?.matches?.find((item) => item.ip === ip) || null;
    if (!match) return null;
    const reportedCves = new Set(
      (match.services || [])
        .flatMap((service) => service.vulnerabilities || [])
        .filter((cve) => /^CVE-\d{4}-\d{4,}$/i.test(cve)),
    );
    return {
      ...match,
      kevCatalogAvailable: Boolean(kev),
      reportedCves: [...reportedCves],
      kevMatches: [...reportedCves]
        .map((cve) => kevByCve.get(cve.toUpperCase()))
        .filter(Boolean),
    };
  }

  function findIodaSelection(entityId) {
    if (!iodaEnabled || !entityId?.startsWith?.('cyber-ioda:')) return null;
    const countryCode = entityId.slice('cyber-ioda:'.length);
    const country = iodaSnapshot?.countries?.find(
      (row) => row.countryCode === countryCode,
    );
    if (!country) return null;
    return {
      type: 'ioda-country',
      ...country,
      events: iodaSnapshot.events.filter(
        (event) => event.countryCode === countryCode,
      ),
      attribution: iodaSnapshot.attribution,
      fetchedAt: iodaSnapshot.fetchedAt,
    };
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

  async function lookupOtxIndicator(indicator, type = 'auto') {
    const value = String(indicator || '').trim();
    if (!enabled || !value || typeof source.lookupOtxIndicator !== 'function')
      return;
    const key = `${type}:${value.toLowerCase()}`;
    selectedOtxKey = key;
    if (
      (otxResults.has(key) && !otxResults.get(key)?.error) ||
      otxPending.has(key)
    ) {
      notifyThreatIntel();
      return;
    }
    otxResults.delete(key);
    otxPending.add(key);
    const generation = enrichmentGeneration;
    const controller = new AbortController();
    enrichmentRequests.add(controller);
    notifyThreatIntel();
    try {
      const result = await source.lookupOtxIndicator(value, type, {
        signal: controller.signal,
      });
      if (enabled && generation === enrichmentGeneration)
        cacheOtxResult(key, result);
    } catch (error) {
      if (enabled && generation === enrichmentGeneration)
        cacheOtxResult(key, {
          indicator: value,
          type,
          error: error?.message || 'AlienVault OTX lookup failed.',
        });
    } finally {
      enrichmentRequests.delete(controller);
      if (generation === enrichmentGeneration) {
        otxPending.delete(key);
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

  async function runShodanAreaSearch(query = '') {
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
    shodanAreaSearch = { ...area, userQuery: query, loading: true };
    renderRadar();
    notifyThreatIntel();
    try {
      const result = await source.searchShodanArea(area, {
        signal: controller.signal,
        query,
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
    if (
      typeof params.iodaEnabled === 'boolean' &&
      params.iodaEnabled !== iodaEnabled
    ) {
      iodaEnabled = params.iodaEnabled;
      changed = true;
      if (!iodaEnabled) {
        iodaSnapshot = null;
        iodaError = null;
        selectedIoda = null;
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
      shodanDataSource = new cesium.CustomDataSource('shodan-devices');
      shodanDataSource.show = false;
      viewer.dataSources.add(shodanDataSource);
      iodaDataSource = new cesium.CustomDataSource('ioda-connectivity-events');
      iodaDataSource.show = false;
      viewer.dataSources.add(iodaDataSource);
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
        if (selectedShodan)
          selectedShodan = {
            ...selectedShodan,
            visualOffsetMeters: shodanVisualOffsets.get(selectedShodan.ip) || 0,
            popupPosition: getPopupPosition(event.position),
          };
        selectedRadar = selectedShodan ? null : findRadarSelection(entityId);
        if (selectedRadar)
          selectedRadar = {
            ...selectedRadar,
            popupPosition: getPopupPosition(event.position),
          };
        selectedIoda =
          selectedShodan || selectedRadar ? null : findIodaSelection(entityId);
        if (selectedIoda)
          selectedIoda = {
            ...selectedIoda,
            popupPosition: getPopupPosition(event.position),
          };
        notifyThreatIntel();
      }, cesium.ScreenSpaceEventType.LEFT_CLICK);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      if (shodanDataSource) shodanDataSource.show = true;
      if (iodaDataSource) iodaDataSource.show = iodaEnabled;
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
      kev = null;
      iodaSnapshot = null;
      kevByCve.clear();
      enrichmentResults.clear();
      enrichmentPending.clear();
      otxResults.clear();
      otxPending.clear();
      selectedOtxKey = null;
      shodanSearch = null;
      shodanAreaSearch = null;
      selectedShodan = null;
      radarError = null;
      dshieldError = null;
      kevError = null;
      iodaError = null;
      dataSource?.entities.removeAll();
      if (dataSource) dataSource.show = false;
      shodanDataSource?.entities.removeAll();
      if (shodanDataSource) shodanDataSource.show = false;
      iodaDataSource?.entities.removeAll();
      if (iodaDataSource) iodaDataSource.show = false;
      selectedRadar = null;
      selectedIoda = null;
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
      if (iodaEnabled)
        tasks.push(
          source.getIodaSnapshot({ signal: controller.signal }).then(
            (value) => ({ provider: IODA_SOURCE, value }),
            (error) => ({ provider: IODA_SOURCE, error }),
          ),
        );
      tasks.push(
        source.getKevSnapshot({ signal: controller.signal }).then(
          (value) => ({ provider: KEV_SOURCE, value }),
          (error) => ({ provider: KEV_SOURCE, error }),
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
            else if (outcome.provider === DSHIELD_SOURCE)
              dshieldError = outcome.error.message;
            else if (outcome.provider === IODA_SOURCE)
              iodaError = outcome.error.message;
            else kevError = outcome.error.message;
            continue;
          }
          succeeded = true;
          if (outcome.provider === RADAR_SOURCE) {
            radar = outcome.value;
            radarError = null;
          } else if (outcome.provider === DSHIELD_SOURCE) {
            dshield = outcome.value;
            dshieldError = null;
          } else if (outcome.provider === IODA_SOURCE) {
            iodaSnapshot = outcome.value;
            iodaError = null;
          } else {
            kev = outcome.value;
            kevError = null;
            kevByCve.clear();
            for (const vulnerability of kev.vulnerabilities || [])
              kevByCve.set(vulnerability.cveId, vulnerability);
          }
        }
        renderRadar();
        if (selectedRadar) {
          const popupPosition = selectedRadar.popupPosition;
          const refreshed = findRadarSelection(
            selectedRadar.type === 'flow'
              ? `cyber-flow:${selectedRadar.id}`
              : selectedRadar.entityId,
          );
          selectedRadar = refreshed ? { ...refreshed, popupPosition } : null;
        }
        if (selectedIoda) {
          const popupPosition = selectedIoda.popupPosition;
          const refreshed = findIodaSelection(
            `cyber-ioda:${selectedIoda.countryCode}`,
          );
          selectedIoda = refreshed ? { ...refreshed, popupPosition } : null;
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
      return { radarEnabled, dshieldEnabled, iodaEnabled };
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
        {
          id: 'cyber-ioda',
          label: 'IODA Connectivity',
          active: iodaEnabled,
          params: { iodaEnabled: !iodaEnabled },
          title: iodaEnabled ? 'Hide IODA events' : 'Show IODA events',
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
      if (iodaEnabled && iodaSnapshot)
        for (const country of iodaSnapshot.countries)
          items.push({
            id: country.id,
            lead: `IODA country event · ${country.eventCount}`,
            text: `${country.countryName} · country reference point`,
            disabled: true,
          });
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
      if (iodaEnabled)
        infos.push(
          `IODA · ${sourceStatus(IODA_SOURCE, iodaSnapshot, iodaError)}${iodaSnapshot?.stale ? ' · cached data' : ''}`,
        );
      return {
        chips,
        list: {
          ariaLabel: 'Cyber provider observations',
          items: items.slice(0, 40),
        },
        info: infos.join('\n'),
        infoTitle:
          'Orange-red person symbols mark origin countries; blue crosshairs mark target countries; purple sword-and-shield symbols mark countries in both roles. Red-to-blue arrows show only Cloudflare-reported top origin-target country pairs (up to 10), with red at the origin and blue at the target; an unconnected marker has no pair in that displayed set. Cyan outage-globe symbols mark IODA country-level events at reference points, not precise outage sites. Gold server symbols mark optional Shodan devices from an operator-triggered area search and show approximate IP network positions. When devices share one location, their symbols are individually offset for visibility and connected to their common anchor; offsets are not measured locations. Arrows are aggregate associations, not physical routes. DShield observations appear in Cyber Threat Intel and may include false positives.',
      };
    },
    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },
    setThreatIntelListener(listener) {
      threatIntelListener = typeof listener === 'function' ? listener : null;
      notifyThreatIntel();
    },
    clearShodanSelection() {
      selectedShodan = null;
      notifyThreatIntel();
    },
    clearMapSelection() {
      selectedShodan = null;
      selectedRadar = null;
      selectedIoda = null;
      notifyThreatIntel();
    },
    getThreatIntelState() {
      return {
        enabled,
        selectedRadar: selectedRadar ? { ...selectedRadar } : null,
        selectedIoda: selectedIoda ? { ...selectedIoda } : null,
        kevSnapshot: kev,
        kevError,
        kevLoading: loading,
        enrichmentResults: Object.fromEntries(enrichmentResults),
        enrichmentPending: [...enrichmentPending],
        shodanSearch,
        enrichmentMessage,
        otxResults: Object.fromEntries(otxResults),
        otxPending: [...otxPending],
        selectedOtxKey,
        onOtxLookup: lookupOtxIndicator,
        onEnrichIp: enrichIp,
        onShodanSearch: runShodanSearch,
        shodanAreaSearch,
        selectedShodan,
        onClearShodanSelection: () => layer.clearShodanSelection(),
        onClearMapSelection: () => layer.clearMapSelection(),
        onShodanAreaSearch: runShodanAreaSearch,
        nonGeographicProviders: [
          ...(dshieldEnabled
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
                  otxResults: Object.fromEntries(otxResults),
                  otxPending: [...otxPending],
                  selectedOtxKey,
                  onOtxLookup: lookupOtxIndicator,
                  shodanSearch,
                  onEnrichIp: enrichIp,
                  onShodanSearch: runShodanSearch,
                  shodanAreaSearch,
                  selectedShodan,
                  onShodanAreaSearch: runShodanAreaSearch,
                  error: dshieldError,
                  kevSnapshot: kev,
                },
              ]
            : []),
          ...(iodaEnabled
            ? [
                {
                  id: IODA_SOURCE,
                  label: 'IODA Internet Disruptions',
                  status: sourceStatus(IODA_SOURCE, iodaSnapshot, iodaError),
                  fetchedAt: iodaSnapshot?.fetchedAt || null,
                  stale: iodaSnapshot?.stale === true,
                  attribution:
                    iodaSnapshot?.attribution ||
                    'IODA · Georgia Tech Internet Intelligence Lab',
                  error: iodaError,
                  events: iodaSnapshot?.events || [],
                  countries: iodaSnapshot?.countries || [],
                },
              ]
            : []),
        ],
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
      const issues = [radarError, dshieldError, kevError, iodaError].filter(
        Boolean,
      );
      const mapEntities = dataSource?.entities.values || [];
      const iodaEntities = iodaDataSource?.entities.values || [];
      const countryCount = mapEntities.filter((entity) =>
        String(entity.id).startsWith('cyber:location:'),
      ).length;
      const flowCount = mapEntities.filter(
        (entity) =>
          String(entity.id).startsWith('cyber-flow:') &&
          !String(entity.id).includes(':gradient:'),
      ).length;
      const shodanCount = mapEntities.filter((entity) =>
        String(entity.id).startsWith('cyber-shodan:'),
      ).length;
      const hasProviderData = Boolean(
        (radarEnabled && radar) ||
        (dshieldEnabled && dshield) ||
        (iodaEnabled && iodaSnapshot),
      );
      const radarNeedsKey =
        radarEnabled && radarError?.includes('needs a token') === true;
      return {
        count: countryCount + flowCount + shodanCount + iodaEntities.length,
        countLabel:
          mapEntities.length || iodaEntities.length
            ? `${countryCount} Radar countries · ${flowCount} flows · ${shodanCount} Shodan · ${iodaEntities.length} IODA countries`
            : 'Provider observations',
        loading,
        keyRequired: radarNeedsKey && !hasProviderData,
        stale: Boolean(
          radar?.stale || dshield?.stale || kev?.stale || iodaSnapshot?.stale,
        ),
        error: issues.length && !hasProviderData ? issues.join(' · ') : null,
        radarCount: radarEnabled ? radar?.observations.length || 0 : 0,
        dshieldCount: dshieldEnabled ? dshield?.observations.length || 0 : 0,
        iodaEventCount: iodaEnabled ? iodaSnapshot?.events.length || 0 : 0,
        source: 'Cloudflare Radar · SANS ISC / DShield · IODA',
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
      if (shodanDataSource)
        destroyViewer?.dataSources?.remove(shodanDataSource, true);
      if (iodaDataSource)
        destroyViewer?.dataSources?.remove(iodaDataSource, true);
      dataSource = null;
      shodanDataSource = null;
      iodaDataSource = null;
      viewer = null;
    },
  };
  return layer;
}
