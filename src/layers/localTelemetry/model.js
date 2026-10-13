import {
  TELEMETRY_OVERLAY_SOURCE_ID,
  TELEMETRY_STATUS_COLORS,
  TELEMETRY_TYPE_ICONS,
  TELEMETRY_TYPE_LABELS,
} from './policy.js';

export function statusColor(status) {
  const key = String(status || '').toLowerCase();
  return TELEMETRY_STATUS_COLORS[key] || TELEMETRY_STATUS_COLORS.offline;
}

export function typeIcon(type) {
  const key = String(type || '').toLowerCase();
  return TELEMETRY_TYPE_ICONS[key] || TELEMETRY_TYPE_ICONS.default;
}

export function typeLabel(type) {
  const key = String(type || '').toLowerCase();
  return TELEMETRY_TYPE_LABELS[key] || TELEMETRY_TYPE_LABELS.default;
}

/**
 * Build analyst card metadata for a selected industrial telemetry device.
 */
export function mapAnalystRecord(device) {
  if (!device) return null;

  const color = statusColor(device.status);
  const icon = typeIcon(device.type);
  const label = typeLabel(device.type);
  const statusStr = String(device.status || 'nominal').toUpperCase();

  const metricsLines = [];
  if (device.battery != null) {
    metricsLines.push(`Battery: ${device.battery}%`);
  }
  if (device.speed != null && device.speed > 0) {
    metricsLines.push(`Speed: ${device.speed.toFixed(1)} m/s`);
  }
  if (device.heading != null) {
    metricsLines.push(`Heading: ${device.heading}°`);
  }
  if (device.metrics && typeof device.metrics === 'object') {
    for (const [k, v] of Object.entries(device.metrics)) {
      if (v != null) {
        metricsLines.push(`${k.replace(/_/g, ' ')}: ${v}`);
      }
    }
  }

  return {
    id: `local-telemetry:${device.id}`,
    entityId: `local-telemetry:${device.id}`,
    layerId: 'local-telemetry',
    title: `${icon} ${device.name || device.id}`,
    subtitle: `${device.facility ? `${device.facility} · ` : ''}${label}`,
    badge: {
      text: statusStr,
      color,
    },
    location: {
      lat: device.lat,
      lon: device.lon,
      alt: device.alt || 0,
    },
    sections: [
      {
        title: 'Telemetry Status',
        content: `Status: ${statusStr} | Lat: ${device.lat.toFixed(4)}, Lon: ${device.lon.toFixed(4)}`,
      },
      ...(metricsLines.length > 0
        ? [
            {
              title: 'Telemetry & SCADA Diagnostics',
              content: metricsLines.join('\n'),
            },
          ]
        : []),
    ],
    raw: device,
  };
}

/**
 * Create a lightweight HUD overlay badge for screen projection.
 */
export function createTelemetryOverlayEntry(device, position = null) {
  if (!device || !Number.isFinite(device.lat) || !Number.isFinite(device.lon)) {
    return null;
  }

  const icon = typeIcon(device.type);
  const color = statusColor(device.status);
  const statusStr = String(device.status || 'nominal').toUpperCase();
  const batteryStr = device.battery != null ? ` [${device.battery}%]` : '';
  const isFault = device.status === 'fault';
  const isWarning = device.status === 'warning';

  const cartesianPosition =
    position &&
    Number.isFinite(position.x) &&
    Number.isFinite(position.y) &&
    Number.isFinite(position.z)
      ? position
      : { x: device.lon, y: device.lat, z: device.alt || 0 };

  return {
    sourceId: TELEMETRY_OVERLAY_SOURCE_ID,
    id: `overlay:telemetry:${device.id}`,
    entityId: `local-telemetry:${device.id}`,
    position: cartesianPosition,
    variant: 'label',
    title: `${icon} ${device.name || device.id}${batteryStr}`,
    subtitle: `${statusStr}${device.facility ? ` · ${device.facility}` : ''}`,
    accent: color,
    lat: device.lat,
    lon: device.lon,
    altitude: device.alt || 0,
    primaryText: `${icon} ${device.name || device.id}${batteryStr}`,
    secondaryText: `${statusStr}${device.facility ? ` · ${device.facility}` : ''}`,
    badgeColor: color,
    priority: isFault ? 100 : isWarning ? 80 : 50,
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 12,
    verticalOnly: true,
    placement: 'above',
  };
}

/**
 * Prioritize devices for HUD overlay rendering (faults and warnings first).
 */
export function selectTelemetryOverlayCohort(devices, limit = 24) {
  if (!Array.isArray(devices)) return [];
  return [...devices]
    .sort((a, b) => {
      const p = (d) =>
        d.status === 'fault' ? 3 : d.status === 'warning' ? 2 : 1;
      return p(b) - p(a);
    })
    .slice(0, limit);
}
