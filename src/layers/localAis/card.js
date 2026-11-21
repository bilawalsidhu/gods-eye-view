import { formatNumber, msg, t } from '../../i18n/index.js';

export const LOCAL_AIS_COLOR = '#28d8ec';
export const LOCAL_AIS_BEACON_COLOR = '#ff8a3d';

/** Beacon kinds the card names; an unknown kind is the generic beacon. */
const BEACON_TITLES = Object.freeze({
  sart: msg('AIS-SART beacon'),
  mob: msg('Man-overboard (MOB) beacon'),
  epirb: msg('EPIRB beacon'),
});
const BEACON_TITLE_FALLBACK = msg('AIS distress beacon');

/**
 * Click-card presentation for a distress or test beacon the receiver heard.
 * It never says an emergency is real: a beacon seen here is a transmission,
 * and test transmissions are common. Active or test status is shown as
 * unknown because the receiver's vessel list does not carry it.
 */
function beaconCardModel(record) {
  const mmsiLine = t('MMSI: {id}', { id: record.mmsi });
  return {
    title:
      record.name ||
      t(BEACON_TITLES[record.beaconType] || BEACON_TITLE_FALLBACK),
    details: [
      mmsiLine,
      t('Distress or test beacon heard by your receiver'),
      t('Test transmissions are common. This is not a verified emergency.'),
      t('Active or test status: unknown'),
      record.approx ? t('Position approximate (AIS type 27)') : null,
      record.validated === false
        ? t('Position not yet validated by the receiver')
        : null,
    ].filter(Boolean),
    accent: LOCAL_AIS_BEACON_COLOR,
  };
}

/**
 * Click-card presentation for one locally heard vessel. A value the receiver
 * did not give is omitted, never shown as zero.
 * @param {object} record Local AIS record.
 * @returns {{title:string, details:string[], accent:string}}
 */
export function localAisCardModel(record) {
  if (record.beaconType) return beaconCardModel(record);
  const { mmsi } = record;
  const mmsiLine = t('MMSI: {id}', { id: mmsi });
  return {
    title: record.name || mmsiLine,
    details: [
      mmsiLine,
      record.destination ? `${t('Destination')}: ${record.destination}` : null,
      Number.isFinite(record.speed)
        ? `${t('Speed')}: ${t('{speed} kn', { speed: formatNumber(record.speed) })}`
        : null,
      Number.isFinite(record.course)
        ? `${t('Course')}: ${formatNumber(record.course)}°`
        : null,
      record.approx ? t('Position approximate (AIS type 27)') : null,
      record.validated === false
        ? t('Position not yet validated by the receiver')
        : null,
      t('Heard by your receiver'),
    ].filter(Boolean),
    accent: LOCAL_AIS_COLOR,
  };
}
