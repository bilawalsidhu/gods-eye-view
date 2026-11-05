import { t, formatNumber } from '../../i18n/index.js';
import { formatQuantity } from '../../ui/unitLabels.js';
import { utcClock } from '../../ui/rail/utcClock.js';
import {
  RADIOSONDE_COLOR,
  RADIOSONDE_LABEL_CANDIDATE_CAP,
  RADIOSONDE_LAUNCH_PERIOD_MS,
  RADIOSONDE_LAUNCH_WINDOW_MS,
} from './policy.js';
import {
  flightPhase,
  isSondeAloft,
  isSondeLanded,
  SONDE_SERIAL_RE,
} from './records.js';

export const RADIOSONDES_OVERLAY_SOURCE_ID = 'radiosondes';
export const RADIOSONDES_SELECTED_SOURCE_ID = 'radiosondes-selected';
export const RADIOSONDES_OVERLAY_OPTIONS = Object.freeze({
  cohortLimit: RADIOSONDE_LABEL_CANDIDATE_CAP,
  collisionCapacity: RADIOSONDE_LABEL_CANDIDATE_CAP,
  moving: true,
  // Projected anchors can collide during a camera frame before moveEnd fires.
  solveIntervalMs: 0,
});
export const RADIOSONDES_SELECTED_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: true,
});
export const RADIOSONDES_LABEL_STYLE = Object.freeze({
  variant: 'label',
  accent: RADIOSONDE_COLOR,
  interactive: false,
  horizonCull: true,
  edgeFade: 'keyhole',
  collisionGroup: 'ambient-label',
  paintLane: 'ambient-label',
  gapPx: 12,
  // Camera movement must recheck placement without incumbent overlaps or fades.
  stateless: true,
});
/** Link a validated SondeHub serial to its focused tracker. */
export function sondeTrackerUrl(serial) {
  return typeof serial === 'string' &&
    serial === serial.trim() &&
    SONDE_SERIAL_RE.test(serial)
    ? `https://sondehub.org/${encodeURIComponent(serial)}`
    : null;
}
/** Format elapsed time in compact, localized units. */
export function formatAge(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return null;
  if (deltaMs < 60_000) return t('<1m', { context: 'age' });
  const hours = Math.floor(deltaMs / 3600000);
  if (hours < 1)
    return t('{count}m', {
      context: 'age',
      count: Math.floor(deltaMs / 60_000),
    });
  if (hours < 24) return t('{count}h', { context: 'age', count: hours });
  return t('{count}d', { context: 'age', count: Math.floor(hours / 24) });
}
const quantity = (value, unit, digits = 0) =>
  formatQuantity(value, unit, { maximumFractionDigits: digits });
const altitude = (altM) =>
  formatQuantity(altM / 1000, 'km', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
/** Describe the current or next hour preceding a 00/12 UTC launch. */
export function launchWindowText(nowMs) {
  const endMs =
    (Math.floor(nowMs / RADIOSONDE_LAUNCH_PERIOD_MS) + 1) *
    RADIOSONDE_LAUNCH_PERIOD_MS;
  const startMs = endMs - RADIOSONDE_LAUNCH_WINDOW_MS;
  const end = utcClock(new Date(endMs).toISOString());
  if (nowMs >= startMs)
    return `${t('Launch window now')} · ${t('until {end}', { end })}`;
  const start = utcClock(new Date(startMs).toISOString()).replace(/ UTC$/, '');
  return `${t('Next launch window {start}–{end}', { start, end })} · ${t('in {age}', { age: formatAge(startMs - nowMs) })}`;
}
/** Build an ambient serial/altitude label using the classified flight phase. */
export function buildSondeLabel(frame, phase = flightPhase([], frame).phase) {
  const metric = isSondeLanded(phase)
    ? t('landed', { context: 'radiosonde-label' })
    : phase === 'signal-lost'
      ? t('lost', { context: 'radiosonde-label' })
      : `${phase === 'descending' ? '↓ ' : phase === 'ascending' ? '↑ ' : ''}${altitude(frame.altM)}`;
  return {
    ...RADIOSONDES_LABEL_STYLE,
    id: frame.stableId,
    title: `${frame.serial} ${metric}`,
  };
}
/** Group available telemetry and source attribution for the selected balloon. */
export function buildSelectedSondeCard(
  frame,
  track,
  nowMs,
  phase = flightPhase(track, frame, nowMs).phase,
) {
  const phaseText =
    phase === 'landed'
      ? t('Landed')
      : phase === 'landed-inferred'
        ? t('Landed (inferred)')
        : phase === 'signal-lost'
          ? t('Signal lost')
          : phase === 'descending'
            ? t('Descending')
            : phase === 'ascending'
              ? t('Ascending')
              : t('Direction unknown');
  const historical = !isSondeAloft(phase);
  const speeds = [];
  if (Number.isFinite(frame.vVelMps))
    speeds.push(
      t('Vertical {speed}', {
        speed: formatQuantity(frame.vVelMps, 'm/s', {
          maximumFractionDigits: 1,
          signDisplay: 'exceptZero',
        }),
      }),
    );
  if (Number.isFinite(frame.hVelMps))
    speeds.push(
      t('Horizontal {speed}', { speed: quantity(frame.hVelMps, 'm/s', 1) }),
    );
  const bearing = (degrees) =>
    formatNumber(Math.round(((degrees % 360) + 360) % 360) % 360, {
      maximumFractionDigits: 0,
      minimumIntegerDigits: 3,
      useGrouping: false,
    });
  const heading = Number.isFinite(frame.headingDeg)
    ? t('Heading {heading}°', { heading: bearing(frame.headingDeg) })
    : null;
  // A balloon's aloft horizontal drift estimates wind; meteorological wind
  // direction is where it comes from, opposite the telemetry heading.
  const wind =
    !isSondeLanded(phase) && Number.isFinite(frame.hVelMps)
      ? Number.isFinite(frame.headingDeg)
        ? t('Wind (drift) {speed} from {dir}°', {
            speed: quantity(frame.hVelMps, 'm/s', 1),
            dir: bearing(frame.headingDeg + 180),
          })
        : t('Wind (drift) {speed}', {
            speed: quantity(frame.hVelMps, 'm/s', 1),
          })
      : null;
  const { burstIndex } = flightPhase(track, frame);
  const burst =
    burstIndex !== null
      ? t('max {alt} at burst', { alt: altitude(track[burstIndex].altM) })
      : null;
  const measurements = [];
  if (Number.isFinite(frame.tempC))
    measurements.push(quantity(frame.tempC, '°C', 1));
  if (Number.isFinite(frame.humidityPct))
    measurements.push(
      t('{value} RH', { value: quantity(frame.humidityPct, '%') }),
    );
  if (Number.isFinite(frame.pressureHpa))
    measurements.push(quantity(frame.pressureHpa, 'hPa'));
  const equipment = [...new Set([frame.type, frame.subtype].filter(Boolean))];
  if (Number.isFinite(frame.frequencyMhz))
    equipment.push(quantity(frame.frequencyMhz, 'MHz', 3));
  const ages = [];
  const lastFix = formatAge(Math.max(0, nowMs - frame.timeMs));
  const heard = formatAge(Math.max(0, nowMs - frame.receivedMs));
  // Receipts within a minute add no useful precision to a historical fix age.
  if (
    heard &&
    (!historical || Math.abs(frame.receivedMs - frame.timeMs) >= 60_000)
  )
    ages.push(t('heard {age} ago', { age: heard }));
  const launched = track.length
    ? formatAge(Math.max(0, nowMs - track[0].timeMs))
    : null;
  if (launched) ages.push(t('launched {age} ago', { age: launched }));
  return {
    id: `radiosondes-card:${frame.stableId}`,
    variant: 'selected',
    title: `${t('BALLOON')} · ${frame.serial}`,
    details: [
      [
        phaseText,
        historical
          ? lastFix && t('last fix {age} ago', { age: lastFix })
          : altitude(frame.altM),
      ]
        .filter(Boolean)
        .join(' · '),
      historical ? altitude(frame.altM) : null,
      speeds.join(' · '),
      heading,
      measurements.join(' · '),
      wind,
      burst,
      equipment.join(' · '),
      ages.filter(Boolean).join(' · '),
      `${t('SondeHub tracker')} ↗ · ${t('CC BY-SA 2.0')}`,
    ].filter(Boolean),
    accent: RADIOSONDE_COLOR,
    interactive: false,
    selected: true,
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
    horizonCull: true,
  };
}
