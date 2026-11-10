/**
 * The Live Signals rows in the orbital view. Orbit feeds no Contacts
 * snapshot, so the rows are built here, the way the aircraft rows are built
 * from one (src/ui/cockpitSignals.js): the TRACK ACQUIRED row, the nearest
 * mapped sites in reach (a row focuses its site, or releases the one held),
 * a RETURN row to the satellite ridden before, and the nearest satellites (a
 * row rides it). With Mapped Installations off a status row says why no
 * site is listed. Five rows at most, with stable keys, rebuilt on their own
 * clock. Bound to the Cockpit controller.
 */
import { formatNumber, t } from '../i18n/index.js';
import { ORBITAL_REACH_REFRESH_MS } from '../cockpitOrbitalFocus.js';
import { bearingBetweenCoordinates, relativeBearing } from '../cockpitMath.js';
import {
  installationClassLabel,
  installationTitle,
} from '../layers/installations/classLabel.js';
import { formatCockpitDistance } from './cockpitPresentation.js';
import { orbitalSitesInReach } from './cockpitOrbitalFocus.js';
import {
  orbitalNearbySatellites,
  previousOrbitalSatellite,
} from './cockpitOrbitalSatellites.js';

/** The most rows Live Signals shows, as for aircraft. */
const SIGNAL_ROWS = 5;

/** Site rows when there are satellites to list too. */
const SITE_ROWS = 2;

const SITES_LAYER_ID = 'military-installations';

function inOrbit(controller) {
  return (
    controller.active &&
    !controller.destroyed &&
    controller.subjectKind === 'satellite' &&
    Boolean(controller.orbital)
  );
}

function sitesLayerOn(controller) {
  const isLayerEnabled = controller.services?.isLayerEnabled;
  return typeof isLayerEnabled === 'function'
    ? isLayerEnabled(SITES_LAYER_ID) !== false
    : false;
}

/** Where another satellite is, from the top of the frame, worded. */
function bearingWords(info, satellite) {
  const bearing = bearingBetweenCoordinates(
    info.latitude,
    info.longitude,
    satellite.latitude,
    satellite.longitude,
  );
  // Relative to the top of the frame: the ground track, or north.
  const relative = relativeBearing(
    bearing,
    Number.isFinite(info.groundTrackDeg) ? info.groundTrackDeg : 0,
  );
  if (relative === null) return t('BRG —');
  if (Math.abs(relative) < 8) return t('AHEAD');
  return t('{side} {angle}', {
    side: relative < 0 ? t('L') : t('R'),
    angle: `${String(Math.round(Math.abs(relative))).padStart(3, '0')}°`,
  });
}

/** The ids the rows of one layer show now, in their order. */
function shownIds(controller, layerId, keyPrefix) {
  return controller.signalItems
    .filter((item) => item.key.startsWith(keyPrefix))
    .filter((item) => item.target?.layerId === layerId)
    .map((item) => String(item.target.id));
}

/**
 * Order rows so those already shown keep their places while they still
 * qualify; new ones fill after them, nearest first. Sites pass under a low
 * orbit in seconds: re-sorting by angle every beat would move a row away
 * from the pointer reaching for it.
 * @param {Array<object>} entries Nearest first.
 * @param {(entry: object) => string} keyOf
 * @param {Array<string>} shown Ids shown now, in order.
 * @param {string|null} [first] An id that goes first (the focused site).
 */
function stickyOrder(entries, keyOf, shown, first = null) {
  const byKey = new Map(entries.map((entry) => [keyOf(entry), entry]));
  const ordered = [];
  const take = (key) => {
    const entry = byKey.get(key);
    if (!entry) return;
    ordered.push(entry);
    byKey.delete(key);
  };
  if (first !== null) take(first);
  for (const key of shown) take(key);
  for (const entry of entries) take(keyOf(entry));
  return ordered;
}

/** The site rows: the focused site first, then those shown, then the nearest. */
function siteRows(info, { settled = true } = {}) {
  if (!sitesLayerOn(this)) {
    // Also forgets the sites last listed, so none is focused from a row.
    orbitalSitesInReach.call(this, info);
    return [
      {
        key: 'site-status',
        tone: 'warning',
        title: t('SITES STANDBY'),
        detail: t('ENABLE MAPPED INSTALLATIONS FOR SITE PINGS'),
        target: null,
      },
    ];
  }
  if (!settled) return [];
  const { entries } = orbitalSitesInReach.call(this, info);
  const focused = entries.find((entry) => entry.focused);
  return stickyOrder(
    entries,
    (entry) => String(entry.site.id),
    shownIds(this, SITES_LAYER_ID, 'site:'),
    focused ? String(focused.site.id) : null,
  ).map(({ site, offNadirDeg, focused }) => {
    const title = installationTitle(site.name) || t('Unnamed site');
    const angle = t('OFF-NADIR {angle}°', {
      angle: formatNumber(offNadirDeg, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
    });
    const words = [installationClassLabel(site.class), angle];
    if (focused) words.unshift(t('FOCUS'));
    return {
      key: `site:${site.id}`,
      // The held site reads as the subject does.
      tone: focused ? 'track' : 'nearby',
      title,
      detail: words.join(' · '),
      target: {
        layerId: SITES_LAYER_ID,
        id: String(site.id),
        label: focused
          ? t('Release the camera from {name}', { name: title })
          : t('Keep the camera on {name}', { name: title }),
      },
    };
  });
}

/** The satellite rows: RETURN to the one before, then the nearest. */
function satelliteRows(info) {
  const state = this.orbital;
  state.satelliteNames ??= new Map();
  state.satelliteNames.set(String(info.noradId), info.name);
  const rows = [];
  const back = previousOrbitalSatellite.call(this);
  if (back !== null) {
    const name = state.satelliteNames.get(String(back)) ?? String(back);
    rows.push({
      key: `satellite-return:${back}`,
      tone: 'nearby',
      title: t('RETURN · {name}', { name }),
      detail: t('PREVIOUS SATELLITE'),
      target: {
        layerId: 'satellites',
        id: String(back),
        label: t('Return to {name}', { name }),
      },
    });
  }
  // Measured only once the camera is on the ridden satellite.
  const measured = !state.hop && !state.awaitingFrame;
  const nearby = measured
    ? stickyOrder(
        orbitalNearbySatellites.call(this),
        (satellite) => String(satellite.id),
        shownIds(this, 'satellites', 'satellite:'),
      )
    : [];
  for (const satellite of nearby) {
    if (back !== null && String(satellite.id) === String(back)) continue;
    const name = String(satellite.label ?? satellite.id);
    state.satelliteNames.set(String(satellite.id), name);
    rows.push({
      key: `satellite:${satellite.id}`,
      tone: 'nearby',
      title: name,
      detail: [
        t('SATELLITE'),
        bearingWords(info, satellite),
        formatCockpitDistance(satellite.distanceM),
      ].join(' · '),
      target: {
        layerId: 'satellites',
        id: String(satellite.id),
        label: t('Ride {name}', { name }),
      },
    });
  }
  return rows;
}

/**
 * Rebuild the orbital Live Signals rows now: after a focus change, a
 * satellite switch, or on their clock. TRACK ACQUIRED stays first; sites
 * take two rows when satellites fill the rest, more when they do not.
 */
export function refreshOrbitalSignals() {
  if (!inOrbit(this)) return;
  const info = this.lastSubjectInfo;
  if (info?.kind !== 'satellite') return;
  this.orbital.signalsMs = performance.now();
  const previous = new Map(this.signalItems.map((item) => [item.key, item]));
  const rows = [];
  const track = this.signalItems.find((item) => item.key === 'track');
  if (track) rows.push(track);
  // While the camera hops to a new satellite its frame is not the
  // satellite's yet: the site rows wait for it (the status row does not).
  const settled = !this.orbital.hop && !this.orbital.awaitingFrame;
  const sites = siteRows.call(this, info, { settled });
  const satellites = satelliteRows.call(this, info);
  const free = SIGNAL_ROWS - rows.length;
  rows.push(...sites.slice(0, Math.max(SITE_ROWS, free - satellites.length)));
  rows.push(...satellites.slice(0, SIGNAL_ROWS - rows.length));
  const now = Date.now();
  this.signalItems = rows.map((row) => ({
    ...row,
    timestamp: previous.get(row.key)?.timestamp ?? row.timestamp ?? now,
  }));
  this.signalSignatures.clear();
  this.publishCockpitSignals();
}

/**
 * The rows' clock: rebuild once every ORBITAL_REACH_REFRESH_MS.
 * @param {number} nowMs
 */
export function updateOrbitalSignals(nowMs) {
  const state = this.orbital;
  if (!state) return;
  if (nowMs - (state.signalsMs ?? -Infinity) < ORBITAL_REACH_REFRESH_MS) return;
  refreshOrbitalSignals.call(this);
}

/**
 * A click on an orbital row: a site row focuses its site or releases it, a
 * satellite row rides that satellite (RETURN goes back).
 * @param {string} layerId
 * @param {string} id
 * @returns {boolean} True in orbit, where the row is this module's.
 */
export function handleOrbitalSignalClick(layerId, id) {
  if (!inOrbit(this)) return false;
  if (layerId === SITES_LAYER_ID) this.toggleOrbitalFocus(id);
  else if (layerId === 'satellites') this.rideOrbitalSatellite(id);
  return true;
}
