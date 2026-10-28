import {
  BIKESHARE_SELECTED_OVERLAY_SOURCE_ID,
  BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS,
} from './policy.js';

export function buildBikeshareSelectionLabel(record) {
  const stationName = String(record?.stationName || '').trim();
  const stationLabel =
    stationName ||
    (record?.stationId ? `Station ${record.stationId}` : 'Station');
  const bikes = Number.isFinite(record?.bikesAvailable)
    ? record.bikesAvailable
    : '?';
  const docks = Number.isFinite(record?.docksAvailable)
    ? record.docksAvailable
    : '?';
  const capacity = Number.isFinite(record?.capacity) ? record.capacity : '?';
  const lines = [
    stationLabel,
    `🚲 ${bikes} avail · ${docks} docks · ${capacity} cap`,
  ];
  const abnormal = [];
  if (record?.isInstalled === false) abnormal.push('⚠️ Not installed');
  if (record?.isRenting === false) abnormal.push('⚠️ Not renting');
  if (record?.isReturning === false) abnormal.push('⚠️ Not returning');
  if (abnormal.length) lines.push(abnormal.join(' · '));
  return lines.join('\n');
}

export function createBikeshareSelectedOverlayEntry(key, record) {
  const position = record?.point?.position;
  if (!key || !position) return null;
  const [title, ...details] = buildBikeshareSelectionLabel(record).split('\n');
  return {
    id: String(key),
    position,
    variant: 'selected',
    selected: true,
    protected: true,
    paintLane: 'selected',
    collisionGroup: 'ambient-card',
    priority: Number.MAX_SAFE_INTEGER,
    title,
    details,
    accent: '#00ffff',
    interactive: false,
    anchorRadiusPx: 9,
    minAnchorGapPx: 11,
    verticalOnly: true,
    placement: 'above',
    edgeFade: 'keyhole',
    horizonCull: false,
    terrainOcclusion: false,
  };
}

export {
  BIKESHARE_SELECTED_OVERLAY_SOURCE_ID,
  BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS,
};
