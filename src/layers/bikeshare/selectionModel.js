import { t } from '../../i18n/index.js';
import {
  BIKESHARE_SELECTED_OVERLAY_SOURCE_ID,
  BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS,
} from './policy.js';

function buildBikeshareSelectionLabel(record) {
  const stationName = String(record?.stationName || '').trim();
  const stationLabel =
    stationName ||
    (record?.stationId
      ? t('Station {id}', { id: record.stationId })
      : t('Station'));
  const bikes = Number.isFinite(record?.bikesAvailable)
    ? record.bikesAvailable
    : '?';
  const docks = Number.isFinite(record?.docksAvailable)
    ? record.docksAvailable
    : '?';
  const capacity = Number.isFinite(record?.capacity) ? record.capacity : '?';

  const lines = [
    stationLabel,
    t('🚲 {bikes} avail · {docks} docks · {capacity} cap', {
      bikes,
      docks,
      capacity,
    }),
  ];

  // Append warnings for stations that are offline or partially non-operational
  const abnormal = [];
  if (record?.isInstalled === false) abnormal.push(t('⚠️ Not installed'));
  if (record?.isRenting === false) abnormal.push(t('⚠️ Not renting'));
  if (record?.isReturning === false) abnormal.push(t('⚠️ Not returning'));
  if (abnormal.length > 0) {
    lines.push(abnormal.join(' · '));
  }

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
