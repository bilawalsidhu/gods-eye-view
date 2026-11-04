/**
 * Solunar panel: the next 7 local days at one spot. Plain DOM, text through
 * textContent only. Everything the panel shows comes from solunarDay.js
 * (astronomy math in the browser; no outside data); this file only lays it
 * out. A moon event that does not happen on a local day shows "none"; it is
 * never filled from the next day (solunarDay.js owns that rule).
 */
import { formatDate, getLocale, t } from '../i18n/index.js';
import { solunarWeek } from './solunarDay.js';
import { zoneAt } from './zone.js';
import {
  BAND_HALF_MS,
  CLOSE_SYZYGY_DAYS,
  MAX_STARS,
  NEAR_SYZYGY_DAYS,
} from './rating.js';

export const HOUR12_STORAGE_KEY = 'gev:solunar:hour12:v1';
export const WEEK_DAYS = 7;

const PHASE_LABEL = {
  'New Moon': () => t('New Moon'),
  'Waxing Crescent': () => t('Waxing Crescent'),
  'First Quarter': () => t('First Quarter'),
  'Waxing Gibbous': () => t('Waxing Gibbous'),
  'Full Moon': () => t('Full Moon'),
  'Waning Gibbous': () => t('Waning Gibbous'),
  'Last Quarter': () => t('Last Quarter'),
  'Waning Crescent': () => t('Waning Crescent'),
};

const WINDOW_SOURCE_LABEL = {
  upper: () => t('Moon overhead'),
  lower: () => t('Moon underfoot'),
  rise: () => t('Moonrise'),
  set: () => t('Moonset'),
};

function el(doc, tag, parent, { text, cls, attrs } = {}) {
  const node = doc.createElement(tag);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  for (const [k, v] of Object.entries(attrs ?? {})) node.setAttribute(k, v);
  parent?.append(node);
  return node;
}

/** Clock time in the spot's zone, rounded to the minute like an almanac. */
export function formatClock(ms, zone, hour12) {
  const rounded = Math.round(ms / 60_000) * 60_000;
  return formatDate(rounded, {
    timeZone: zone,
    hour: 'numeric',
    minute: '2-digit',
    // hour12:false alone gives "24:05" for 00:05 in some locales
    ...(hour12 ? { hour12: true } : { hourCycle: 'h23' }),
  });
}

export function formatList(list, zone, hour12) {
  return list.length
    ? list.map((ms) => formatClock(ms, zone, hour12)).join(' · ')
    : t('none');
}

export const formatLatLon = (latDeg, lonDeg) =>
  `${Math.abs(latDeg).toFixed(3)}°${latDeg >= 0 ? 'N' : 'S'} ${Math.abs(lonDeg).toFixed(3)}°${lonDeg >= 0 ? 'E' : 'W'}`;

export const starsText = (n) =>
  '★'.repeat(n) + '☆'.repeat(Math.max(0, MAX_STARS - n));

/** The locale's own clock style until the user picks one. */
export function defaultHour12() {
  try {
    return (
      new Intl.DateTimeFormat(getLocale(), {
        hour: 'numeric',
      }).resolvedOptions().hour12 === true
    );
  } catch {
    return true;
  }
}

function readHour12(storage) {
  try {
    const v = storage?.getItem(HOUR12_STORAGE_KEY);
    if (v === '12') return true;
    if (v === '24') return false;
  } catch {
    /* private mode: use the default */
  }
  return defaultHour12();
}

/**
 * @param {{container: object, doc?: object, now?: () => number,
 *   storage?: object, onUseCenter?: () => void}} options
 */
export function createSolunarPanel({
  container,
  doc = container?.ownerDocument ?? globalThis.document,
  now = () => Date.now(),
  storage = globalThis.localStorage,
  onUseCenter = () => {},
} = {}) {
  if (!container) throw new TypeError('createSolunarPanel needs a container');
  let spot = null;
  let hour12 = readHour12(storage);
  let destroyed = false;

  const render = () => {
    if (destroyed) return;
    container.replaceChildren();
    const head = el(doc, 'div', container, { cls: 'gev-sl-head' });
    if (!spot) {
      el(doc, 'p', head, {
        cls: 'gev-sl-hint',
        text: t('Click the map to choose a spot'),
      });
      return;
    }
    const zone = spot.zone || zoneAt(spot.latDeg, spot.lonDeg);
    const week = solunarWeek({ ...spot, zone }, now(), WEEK_DAYS);
    el(doc, 'div', head, {
      cls: 'gev-sl-spot',
      text: `${formatLatLon(spot.latDeg, spot.lonDeg)} · ${zone}`,
    });
    el(doc, 'p', head, {
      cls: 'gev-sl-hint',
      text: t('Click the map to choose a spot'),
    });
    const controls = el(doc, 'div', head, { cls: 'gev-sl-controls' });
    const center = el(doc, 'button', controls, {
      cls: 'data-toggle-chip gev-sl-center',
      text: t('Use map centre'),
      attrs: { type: 'button' },
    });
    center.addEventListener('click', () => onUseCenter());
    for (const [value, label] of [
      [true, t('12 h')],
      [false, t('24 h')],
    ]) {
      const chip = el(doc, 'button', controls, {
        cls: `data-toggle-chip gev-sl-clock${hour12 === value ? ' active' : ''}`,
        text: label,
        attrs: {
          type: 'button',
          'aria-pressed': String(hour12 === value),
          'data-hour12': String(value),
        },
      });
      chip.addEventListener('click', () => {
        hour12 = value;
        try {
          storage?.setItem(HOUR12_STORAGE_KEY, value ? '12' : '24');
        } catch {
          /* not persisted */
        }
        render();
      });
    }
    el(doc, 'div', head, {
      cls: 'gev-sl-zone',
      text: t('Times are local to the spot ({zone})', { zone }),
    });
    for (const day of week) renderDay(container, day, zone);
    renderRule(container);
  };

  const row = (parent, label, value, cls = '') => {
    const r = el(doc, 'div', parent, { cls: `gev-sl-row ${cls}`.trim() });
    el(doc, 'span', r, { cls: 'gev-sl-label', text: label });
    el(doc, 'span', r, {
      cls: `gev-sl-value${value === t('none') ? ' gev-sl-none' : ''}`,
      text: value,
    });
    return r;
  };

  function renderDay(parent, day, zone) {
    const card = el(doc, 'section', parent, {
      cls: 'gev-sl-day',
      attrs: { 'data-date': day.date },
    });
    const title = formatDate(day.startMs + (day.endMs - day.startMs) / 2, {
      timeZone: zone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    const h = el(doc, 'div', card, { cls: 'gev-sl-day-head' });
    el(doc, 'strong', h, { text: title });
    el(doc, 'span', h, {
      cls: 'gev-sl-phase',
      text: `${PHASE_LABEL[day.phase]()} · ${t('{percent}% lit', { percent: Math.round(day.illumination * 100) })}`,
    });
    const stars = el(doc, 'div', card, { cls: 'gev-sl-stars' });
    for (const [key, label, n] of [
      ['hunting', t('Hunting'), day.huntingStars],
      ['fishing', t('Fishing'), day.fishingStars],
    ]) {
      const s = el(doc, 'span', stars, {
        cls: `gev-sl-rate gev-sl-${key}`,
        attrs: {
          'data-stars': String(n),
          'aria-label': t('{label}: {stars} of {max} stars', {
            label,
            stars: n,
            max: MAX_STARS,
          }),
        },
      });
      el(doc, 'span', s, { text: label });
      el(doc, 'span', s, { cls: 'gev-sl-star-glyphs', text: starsText(n) });
    }
    const wins = el(doc, 'div', card, { cls: 'gev-sl-windows' });
    for (const [kind, label] of [
      ['major', t('Major window')],
      ['minor', t('Minor window')],
    ]) {
      const list = day.windows.filter((w) => w.kind === kind);
      const text = list.length
        ? list
            .map(
              (w) =>
                `${formatClock(w.startMs, zone, hour12)} – ${formatClock(w.endMs, zone, hour12)} (${WINDOW_SOURCE_LABEL[w.source]()})`,
            )
            .join('\n')
        : t('none');
      row(wins, label, text, `gev-sl-${kind}`);
    }
    const times = el(doc, 'div', card, { cls: 'gev-sl-times' });
    row(
      times,
      t('Sunrise'),
      formatList(day.sunrise, zone, hour12),
      'gev-sl-sunrise',
    );
    row(
      times,
      t('Sunset'),
      formatList(day.sunset, zone, hour12),
      'gev-sl-sunset',
    );
    row(
      times,
      t('Moonrise'),
      formatList(day.moonrise, zone, hour12),
      'gev-sl-moonrise',
    );
    row(
      times,
      t('Moonset'),
      formatList(day.moonset, zone, hour12),
      'gev-sl-moonset',
    );
    row(
      times,
      t('Moon overhead'),
      formatList(day.moonUpper, zone, hour12),
      'gev-sl-upper',
    );
    row(
      times,
      t('Moon underfoot'),
      formatList(day.moonLower, zone, hour12),
      'gev-sl-lower',
    );
  }

  function renderRule(parent) {
    // open: the rule is part of what the card shows, not hidden behind a click
    const details = el(doc, 'details', parent, {
      cls: 'gev-sl-rule',
      attrs: { open: '' },
    });
    el(doc, 'summary', details, { text: t('How the stars are rated') });
    const list = el(doc, 'ul', details);
    const bandHours = BAND_HALF_MS / 3_600_000;
    for (const line of [
      t(
        'Moon: new or full moon within {near} day = 2 points, within {close} days = 1 point.',
        { near: NEAR_SYZYGY_DAYS, close: CLOSE_SYZYGY_DAYS },
      ),
      t('Dawn and dusk: {hours} h either side of sunrise and of sunset.', {
        hours: bandHours,
      }),
      t(
        'Fishing: +1 for dawn and +1 for dusk when a major window (moon overhead or underfoot, about 2 h) overlaps it.',
      ),
      t(
        'Hunting: +1 for dawn and +1 for dusk when any window (major, or minor at moonrise or moonset, about 1 h) overlaps it.',
      ),
      t('Stars = points, at least 1 and at most 4.'),
      t(
        'Computed in your browser from the Sun and Moon positions. No outside data is used.',
      ),
    ])
      el(doc, 'li', list, { text: line });
  }

  render();
  return {
    /** Show the week for a spot. */
    setSpot(latDeg, lonDeg, source = 'click') {
      if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return false;
      spot = {
        latDeg,
        lonDeg,
        source,
        zone: zoneAt(latDeg, lonDeg),
      };
      render();
      return true;
    },
    getSpot: () => (spot ? { ...spot } : null),
    getHour12: () => hour12,
    refresh: render,
    destroy() {
      destroyed = true;
      container.replaceChildren();
    },
  };
}
