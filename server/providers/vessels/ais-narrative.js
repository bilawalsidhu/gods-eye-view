import {
  decodeDestination,
  destinationLabel,
  shortCountry,
} from './ais-locode.js';
import { inferCargo } from './ais-cargo.js';
import { inferOrigin } from './ais-origin.js';

/**
 * Plain-language account of what a vessel is, what it is doing, and why.
 *
 * Every clause is derived from broadcast data or from this app's own voyage
 * history — nothing is fetched and nothing is guessed. Where the evidence only
 * supports a likelihood, the wording says so ("appears to be loading") rather
 * than asserting a fact. AIS never carries cargo, so the strongest honest
 * claim about purpose comes from how deep the hull sits and where it sits.
 */

/** AIS ship-type decades → what that class of vessel is for. */
const TYPE_PURPOSE = Object.freeze({
  2: 'wing-in-ground craft',
  3: 'special-purpose vessel',
  4: 'high-speed craft',
  5: 'special craft',
  6: 'passenger ship',
  7: 'cargo ship',
  8: 'tanker',
  9: 'other vessel',
});

/** Specific AIS type codes worth naming precisely. */
const TYPE_SPECIALS = Object.freeze({
  30: 'fishing vessel',
  31: 'towing vessel',
  32: 'towing vessel',
  33: 'dredger',
  34: 'diving support vessel',
  35: 'military vessel',
  36: 'sailing yacht',
  37: 'pleasure craft',
  50: 'pilot boat',
  51: 'search and rescue vessel',
  52: 'tug',
  53: 'port tender',
  54: 'anti-pollution vessel',
  55: 'patrol vessel',
  58: 'medical transport',
});

/** Rough size class from overall length. */
function sizeClass(lengthM) {
  const length = Number(lengthM);
  if (!Number.isFinite(length) || length <= 0) return '';
  if (length < 25) return 'small';
  if (length < 100) return 'coastal';
  if (length < 180) return 'mid-size';
  if (length < 250) return 'large';
  if (length < 300) return 'very large';
  return 'ultra-large';
}

/** What kind of ship this is, in words. */
export function describeVesselClass(record) {
  const code = Number(record?.type);
  const specific = TYPE_SPECIALS[code];
  const family = Number.isFinite(code)
    ? TYPE_PURPOSE[Math.floor(code / 10)]
    : '';
  const kind = specific || family || 'vessel';
  const size = sizeClass(record?.length);
  const flag = shortCountry(String(record?.flag || '').trim());
  const lengthText =
    Number.isFinite(Number(record?.length)) && Number(record.length) > 0
      ? `${Math.round(Number(record.length))}m `
      : '';
  const flagText = flag ? `${flag}-flagged ` : '';
  // "coastal other vessel" is noise; a size band only informs a named class.
  const vague = kind === 'other vessel' || kind === 'vessel';
  const sizeText = size && !specific && !vague ? `${size} ` : '';
  return `${flagText}${lengthText}${sizeText}${kind}`
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * What the vessel is doing right now, from navigational status and motion.
 * @returns {{activity:string, alongside:boolean, moving:boolean}}
 */
export function describeActivity(record) {
  const status = Number(record?.nav_status);
  const speed = Number(record?.speed);
  const moving = Number.isFinite(speed) && speed >= 0.5;
  if (status === 5)
    return { activity: 'alongside a berth', alongside: true, moving: false };
  if (status === 1)
    return { activity: 'waiting at anchor', alongside: false, moving: false };
  if (status === 6)
    return { activity: 'aground', alongside: false, moving: false };
  if (status === 7) return { activity: 'fishing', alongside: false, moving };
  if (status === 2)
    return { activity: 'not under command', alongside: false, moving };
  if (status === 3)
    return {
      activity: 'manoeuvring with restricted ability',
      alongside: false,
      moving,
    };
  if (moving) return { activity: 'under way', alongside: false, moving: true };
  return { activity: 'stopped', alongside: false, moving: false };
}

/**
 * Reads the draught record for evidence of cargo work.
 *
 * A hull that rose in the water was discharged; one that settled was loaded.
 * This is the only cargo signal AIS offers, and it only speaks when the same
 * vessel has been observed at more than one draught.
 *
 * @param {Array<Object>} voyages Newest-first voyage rows from the history DB.
 * @returns {{trend:'LOADING'|'DISCHARGING'|'STEADY'|'UNKNOWN', deltaM:number|null, hours:number|null}}
 */
export function readDraughtTrend(voyages) {
  const points = (Array.isArray(voyages) ? voyages : [])
    .filter((v) => Number.isFinite(Number(v?.draught)) && Number(v.draught) > 0)
    .map((v) => ({ draught: Number(v.draught), observed: Number(v.observed) }))
    .sort((a, b) => a.observed - b.observed);
  if (points.length < 2) return { trend: 'UNKNOWN', deltaM: null, hours: null };
  const first = points[0];
  const last = points[points.length - 1];
  const deltaM = Math.round((last.draught - first.draught) * 10) / 10;
  const hours = Math.round(((last.observed - first.observed) / 3600) * 10) / 10;
  // Half a metre is comfortably outside the rounding the field is reported at.
  if (deltaM >= 0.5) return { trend: 'LOADING', deltaM, hours };
  if (deltaM <= -0.5) return { trend: 'DISCHARGING', deltaM, hours };
  return { trend: 'STEADY', deltaM, hours };
}

/** Formats an AIS "MM-DD HH:MM" ETA for prose. */
function etaPhrase(eta) {
  const text = String(eta || '').trim();
  if (!/^\d{2}-\d{2} \d{2}:\d{2}$/.test(text)) return '';
  const [date, time] = text.split(' ');
  const [month, day] = date.split('-');
  const months = [
    '',
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const name = months[Number(month)] || '';
  if (!name) return '';
  return `${Number(day)} ${name} ${time}`;
}

/**
 * Builds the narrative.
 *
 * @param {Object} record Current vessel row.
 * @param {Array<Object>} voyages Voyage history rows (newest first).
 * @returns {{headline:string, what:string, doing:string, heading:string, why:string, caveats:Array<string>}}
 */
export function buildVesselNarrative(record, voyages = [], track = []) {
  const what = describeVesselClass(record);
  const { activity, alongside, moving } = describeActivity(record);
  const decoded = decodeDestination(record?.destination);
  const place = destinationLabel(decoded);
  const trend = readDraughtTrend(voyages);
  const loadState = String(record?.load_state || '').trim();
  const draught = Number(record?.draught);
  const caveats = [];

  // --- what it is doing ---
  let doing = activity;
  if (alongside && trend.trend === 'LOADING')
    doing = 'alongside, taking on cargo';
  else if (alongside && trend.trend === 'DISCHARGING')
    doing = 'alongside, discharging';
  else if (alongside) doing = 'alongside a berth';

  // --- where it is going ---
  let heading = '';
  if (place && moving) heading = `Under way to ${place}`;
  else if (place) heading = `Next destination ${place}`;
  const eta = etaPhrase(record?.eta);
  if (heading && eta) heading += `, ETA ${eta}`;
  if (!place && moving) heading = 'Under way, no destination broadcast';
  if (!place && !moving) heading = 'No destination broadcast';

  // --- why ---
  let why = '';
  if (trend.trend === 'LOADING' && trend.deltaM !== null) {
    why = `Settled ${Math.abs(trend.deltaM)}m deeper over ${trend.hours}h, so it has been loading.`;
  } else if (trend.trend === 'DISCHARGING' && trend.deltaM !== null) {
    why = `Rose ${Math.abs(trend.deltaM)}m over ${trend.hours}h, so it has been discharging.`;
  } else if (loadState === 'LADEN' && moving && place) {
    why = `Riding at its deepest observed draught, so it is carrying cargo to ${place}.`;
  } else if (loadState === 'BALLAST' && moving && place) {
    why = `Riding high and empty, so it is most likely going to ${place} to load.`;
  } else if (loadState === 'BALLAST' && !moving) {
    why = 'Riding high and empty, waiting rather than working cargo.';
  } else if (Number.isFinite(draught) && draught > 0) {
    why = `Draught ${draught}m, but this hull has not yet been seen both loaded and empty, so its loading state is unknown.`;
    caveats.push('load state needs more observations');
  } else {
    why =
      'Broadcasts no draught, so nothing can be said about what it is carrying.';
    caveats.push('no draught broadcast');
  }

  if (decoded.confidence === 'COUNTRY') {
    caveats.push(`destination "${decoded.text}" resolved only to a country`);
  } else if (decoded.confidence === 'RAW' && decoded.text) {
    caveats.push(`destination "${decoded.text}" is free text, not a port code`);
  }
  if (record?.estimated) {
    caveats.push('position is dead-reckoned, not an observation');
  }
  if (record?.sanctioned) {
    caveats.push(
      `sanctions match (${record.sanction_confidence}): ${record.sanction_programs}`,
    );
  }

  // Cargo is deliberately its own field rather than folded into `why`: it
  // carries its own confidence, and a BROADCAST hazard declaration must never
  // be confused with a guess from geography.
  const cargo = inferCargo(record, trend);
  // Where it came from. AIS never says, so this reads the app's own track and
  // voyage record — and reports plainly when it saw nothing.
  const origin = inferOrigin(track, voyages, {
    lat: record?.lat,
    lon: record?.lon,
  });
  if (cargo.confidence === 'LIKELY') {
    caveats.push('cargo inferred from the terminal, not a manifest');
  } else if (cargo.confidence === 'CLASS') {
    caveats.push('AIS carries no manifest, only the hull class');
  }

  const name =
    String(record?.name || '').trim() || `MMSI ${record?.mmsi || '?'}`;
  const headline = `${name} — ${what}, ${doing}.`;

  return {
    headline,
    what,
    doing,
    heading,
    why,
    cargo: cargo.statement,
    cargoConfidence: cargo.confidence,
    cargoBasis: cargo.basis,
    origin: origin.statement,
    originConfidence: origin.confidence,
    caveats,
  };
}

/** One-paragraph rendering for a text panel. */
export function narrativeText(narrative) {
  if (!narrative) return '';
  const parts = [
    narrative.headline,
    narrative.origin,
    narrative.heading,
    narrative.cargo,
    narrative.why,
  ].filter(Boolean);
  const body = parts.join(' ');
  if (!narrative.caveats?.length) return body;
  return `${body} (${narrative.caveats.join('; ')})`;
}
