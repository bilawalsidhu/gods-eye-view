import { applicationServices } from './services/application.js';
/**
 * @module hud
 * @description Intelligence HUD Overlay — NRO/NGA Satellite Aesthetic.
 *
 * Renders reconnaissance-styled telemetry over the Cesium canvas. The
 * MGRS/lat-lon coordinates (the point below the camera), altitude and
 * off-nadir angle come from the live camera, and the clocks show the current
 * UTC time. Sun elevation is an approximate estimate from that position and
 * time. The classification banner, mission and orbit identifiers, the
 * BAND/BITS/LVL strip and the REC blink are styling, and the GSD/NIIRS
 * figures are scaled from camera altitude; none of them comes from imagery
 * metadata, and COLL is the current time, not a capture time. Readouts update
 * on independent fixed cadences.
 *
 * The HUD auto-activates when a military-style shader (NVG, FLIR, CRT) is
 * selected and supports the layout variants: tactical, minimal, cyber.
 *
 * Color theming is driven by the active shader mode via CSS custom properties.
 */

import * as Cesium from 'cesium';
import { greatCircleKm } from './geoDistance.js';
import { forward as toMGRS } from 'mgrs';
import { CITY_POIS } from './cityPois.js';
import { worldTimeFor } from './time/worldClock.js';

// The HUD stamps its readouts with the world time; its sun is the sky's.
const hudTime = worldTimeFor('hud');
const skyTime = worldTimeFor('sky');
import { composeLocalityTag } from './hudLocality.js';
import { hudQuantity, LOCALIZED_LOCALITY } from './hudLocalityFormat.js';
import {
  ellipsoidalToMslDisplayM,
  ensureGeoidReady,
  geoidHeight,
} from './data/geoid.js';
import { getBasemapLabelContext } from './voice/gevActions.js';
import {
  hasWord,
  hudSummaryHasEnglish,
  hudSummaryIsLatin,
  hudSummaryLayerContext,
  hudTelemetryProvenance,
  isHudSummaryUnconfigured,
} from './hudSummaryResponse.js';
import {
  hudSummaryMatchesProvenance,
  provenanceLine,
  provenanceTag,
} from './data/layerSnapshot.js';
import {
  applyHudUiTheme,
  DEFAULT_HUD_LAYOUT,
  normalizeHudLayout,
} from './hudLayouts.js';
import {
  formatNumber,
  getLocale,
  msg,
  onLocaleChange,
  t,
} from './i18n/index.js';
import { isRtlLocale } from './i18n/locale.js';
import { localizeLayerName } from './ui/layerPanel.js';
import { isEmbeddedInline } from './app/embed.js';
import { subscribeSelectedVessel } from './hudReadouts.js';

/** Color palettes keyed by shader mode; applied as CSS custom properties. */
const HUD_COLORS = {
  surveillance: {
    main: 'rgba(51, 255, 51, 0.8)',
    glow: 'rgba(51, 255, 51, 0.5)',
    border: 'rgba(51, 255, 51, 0.2)',
  },
  thermal: {
    main: 'rgba(255, 255, 255, 0.7)',
    glow: 'rgba(255, 255, 255, 0.4)',
    border: 'rgba(255, 255, 255, 0.15)',
  },
  retro: {
    main: 'rgba(255, 170, 0, 0.8)',
    glow: 'rgba(255, 170, 0, 0.5)',
    border: 'rgba(255, 170, 0, 0.2)',
  },
  _default: {
    main: 'rgba(0, 255, 255, 0.6)',
    glow: 'rgba(0, 255, 255, 0.4)',
    border: 'rgba(0, 255, 255, 0.15)',
  },
};

/**
 * Mode names per style: the same English as STYLE_STATUS_LABELS
 * (ui/visualPresets.js), so both translate alike.
 */
const MODE_LABELS = Object.freeze({
  normal: msg('NORMAL'),
  retro: msg('CRT'),
  surveillance: msg('NVG'),
  thermal: msg('FLIR'),
  anime: msg('ANIME'),
  noir: msg('NOIR'),
});

/** Region ids from _regionLabel() and the name shown for each. */
const REGION_LABELS = Object.freeze({
  ARCTIC: msg('ARCTIC'),
  ANTARCTIC: msg('ANTARCTIC'),
  'NORTH AMERICA': msg('NORTH AMERICA'),
  'SOUTH AMERICA': msg('SOUTH AMERICA'),
  EUROPE: msg('EUROPE'),
  AFRICA: msg('AFRICA'),
  ASIA: msg('ASIA'),
  OCEANIA: msg('OCEANIA'),
  'NORTHERN OCEANIC GRID': msg('NORTHERN OCEANIC GRID'),
  'SOUTHERN OCEANIC GRID': msg('SOUTHERN OCEANIC GRID'),
});

/** Feed-state ids from hudTelemetryProvenance() and the word shown for each. */
const FEED_STATE_LABELS = Object.freeze({
  loading: msg('LOADING'),
  degraded: msg('DEGRADED'),
  stale: msg('STALE'),
  partial: msg('PARTIAL'),
  fallback: msg('FALLBACK'),
  unavailable: msg('UNAVAILABLE'),
});

/** A summary line with its warning in the active language. */
function withProvenance(text, provenance) {
  return provenanceLine(
    text,
    provenance,
    (state) =>
      FEED_STATE_LABELS[state]
        ? t(FEED_STATE_LABELS[state])
        : state.toUpperCase(),
    (name) => localizeLayerName(name).toUpperCase(),
  );
}

/**
 * The AI line. In an RTL locale a leading right-to-left mark keeps a reply
 * that opens with a Latin name (Times Square …) reading right to left.
 */
function aiSummaryLine(summary, warning) {
  const line = withProvenance(summary, warning);
  return isRtlLocale(getLocale()) ? `\u200f${line}` : line;
}

/**
 * What a summary outside English must not carry: feed-state ids, translated
 * layers' English names and ids, and with every feed healthy the
 * UNAVAILABLE word. A state word the locale keeps in English (de FALLBACK)
 * and words of a place label (Radio City, Loading Dock) are fine; so is a
 * one-word layer name in a Latin-script locale, where it may be a word of
 * the language (fr transit).
 */
function summaryForbiddenWords(context) {
  const places = [
    ...(context.placeLabels || []),
    ...(context.streetLabels || []),
    ...(context.nearbyPlaceLabels || []),
  ].join(' ');
  const latin = hudSummaryIsLatin(context.locale);
  const overall = context.feedProvenance?.overall;
  return [
    ...Object.keys(FEED_STATE_LABELS).filter(
      (state) =>
        t(FEED_STATE_LABELS[state]).toLowerCase() !== state &&
        !hasWord(places, state),
    ),
    ...(context.englishLayerWords || []).filter(
      (word) =>
        !hasWord(places, word) && (!latin || /[^\p{L}\p{N}]/u.test(word)),
    ),
    ...(!overall || overall === 'nominal'
      ? [t(FEED_STATE_LABELS.unavailable)]
      : []),
  ];
}

/** The name shown for a _viewBand() id. */
function viewBandLabel(band) {
  switch (band) {
    case 'STREET':
      return t('STREET', { context: 'view band' });
    case 'CITY':
      return t('CITY', { context: 'view band' });
    case 'METRO':
      return t('METRO', { context: 'view band' });
    case 'REGIONAL':
      return t('REGIONAL', { context: 'view band' });
    default:
      return t('GLOBAL', { context: 'view band' });
  }
}

/** Shader modes that automatically show the HUD overlay. */
const MILITARY_STYLES = new Set(['retro', 'surveillance', 'thermal']);

const HUD_SUMMARY_INTERVAL_MS = 15000;

/**
 * Cell size (degrees) for the ALT readout's geoid-undulation cache. N changes
 * by well under a metre across 0.01° (~1.1 km), so one lookup per cell keeps
 * the 4 Hz telemetry tick off the EGM96 grid without a visible step.
 */
const HUD_GEOID_CELL_DEG = 0.01;

/** Flattened list of all city POIs for nearest-point lookups. */
const NEARBY_POINTS = Object.values(CITY_POIS).flatMap((city) =>
  city.pois.map((poi) => ({
    city: city.name,
    poi: poi.name,
    lat: poi.lat,
    lon: poi.lon,
  })),
);

/**
 * Full-screen intelligence HUD overlay rendered on top of the Cesium canvas.
 *
 * Displays MGRS/lat-lon, altitude and off-nadir readouts from the live
 * camera, UTC clocks, an approximate sun elevation, the selected vessel and a
 * semantic summary line built from the view and its data feeds, alongside
 * styling that is not sensor metadata: the classification banner, generated
 * mission, sensor and orbit identifiers, the fixed sensor strip, the REC blink
 * and the altitude-scaled GSD/NIIRS figures. Readouts update on independent
 * fixed cadences.
 */
export class IntelHUD {
  /**
   * @param {Cesium.Viewer} viewer - The Cesium Viewer instance used for
   *   camera telemetry and coordinate derivation.
   */
  constructor(
    viewer,
    {
      placeSearch,
      summaryPolicy = {},
      basemapContext = {},
      summaryService = applicationServices.summary,
      publish = () => {},
    } = {},
  ) {
    this._publish = publish;
    this.summaryService = summaryService;
    this.summaryPolicy = summaryPolicy;
    this.basemapContext = basemapContext;
    this.placeSearch = placeSearch;
    this.viewer = viewer;
    this._visible = false;
    this._autoMode = true; // auto show/hide based on style
    this._currentStyle = 'normal';
    /** The presented HUD; see {@link IntelHUD#_initView}. */
    this._view = null;
    this._viewSignature = '';
    this._variant = DEFAULT_HUD_LAYOUT;
    this._recBlinkState = true;
    this._updateInterval = null;
    this._recBlinkInterval = null;
    this._timestampInterval = null;
    this._summaryInterval = null;
    this._summaryTypingInterval = null;
    this._latestMetrics = null;
    this._dataManager = null;
    this._dataManagerUnsubscribe = null;
    this._summaryDirty = true;
    this._summaryRequest = null;
    this._summaryUnconfigured = false;
    // The last place lookup and the view it answered for (see
    // getBasemapLabelContext), reused until the view changes enough.
    this._placeLabels = null;
    this._lastSummarySignature = '';
    /** The reply painted for `_lastSummarySignature`, when it was accepted. */
    this._lastSummaryReply = null;
    this._summaryRevision = 0;
    // One-shot guards so the very first summary lands immediately instead of
    // waiting for the 15s interval tick: B) swap the "Awaiting telemetry..."
    // placeholder for the deterministic line as soon as metrics exist, then
    // A) kick a real AI summary once the intro fly-to settles.
    this._firstMetricsShown = false;
    this._firstSummaryKicked = false;
    // ALT readout datum: the camera height Cesium reports is ELLIPSOIDAL, the
    // number a viewer reads is MSL. N comes from the same lazy ~2.7 MB EGM96
    // chunk the flight layers use — requested on the first telemetry tick of a
    // VISIBLE HUD, never at construction, so a hidden HUD costs nothing — and
    // cached per coarse cell. Until it resolves, or if it never does,
    // `ellipsoidalToMslDisplayM` passes the raw height straight through.
    this._geoidRequested = false;
    this._geoidReady = false;
    this._geoidCellKey = null;
    this._geoidN = null;
    // Whether the LAST painted tick actually had N. The grid resolves mid-
    // session, so this flips once — and both altitude readouts have to move
    // together when it does (see the repaint in _updateCameraData).
    this._geoidCorrectionApplied = false;
    // A summary built for one view must not land on the next: a request in
    // flight when the camera starts moving is aborted and nothing it ends
    // with paints (the revision moves), a reply still typing stops, and the
    // summary is marked dirty so the next periodic tick asks about the view
    // the camera has moved to.
    this._onCameraMoveStart = () => {
      this._markSummaryDirty();
      const typing = Boolean(this._summaryTypingInterval);
      if (this._summaryRequest || typing) {
        // Cancelled requests and partially typed replies are not reusable answers.
        this._lastSummarySignature = null;
      }
      this._summaryRequest?.abort();
      this._stopSummaryTyping();
      // A half-typed reply would stay until moveEnd, which a camera that
      // keeps moving may not send for a long time: show the plain line.
      if (typing && this._latestMetrics)
        this._setSummaryText(this._composeSummary(), false);
    };
    this._onCameraMoveEnd = () => {
      this._markSummaryDirty();
      // The 250 ms telemetry timer and 15 s semantic-summary timer must not
      // leave the prior city on-screen after a long CCTV focus flight.
      // Refresh deterministic camera context synchronously on settle; the AI
      // summary can still upgrade it on its normal cadence.
      if (this._visible) {
        this._updateCameraData();
        this._setSummaryText(this._composeSummary(), false);
      }
      // First settled view: request the AI summary now rather than waiting for
      // the periodic tick (saves up to ~15s of "Awaiting telemetry...").
      if (!this._firstSummaryKicked && this._visible && this._latestMetrics) {
        this._firstSummaryKicked = true;
        void this._updateSummary(true, true);
      }
    };

    // Session-consistent pseudorandom identifiers (generated once at construction)
    this._missionId = `KH11-${4000 + Math.floor(Math.random() * 200)}`;
    this._sensorId = `OPS-${4100 + Math.floor(Math.random() * 100)}`;
    this._orbitNum = 47000 + Math.floor(Math.random() * 1000);
    this._passNum = 100 + Math.floor(Math.random() * 200);

    this._initView();
    this._vesselUnsubscribe = subscribeSelectedVessel((readout) =>
      this._present({
        vessel: readout
          ? { active: true, text: readout.text }
          : { active: false, text: t('AIS: --') },
      }),
    );
    this.viewer.camera.moveStart.addEventListener(this._onCameraMoveStart);
    this.viewer.camera.moveEnd.addEventListener(this._onCameraMoveEnd);
    this._offLocale = onLocaleChange(() => this._relocalize());
    this._startTimers();
  }

  /** Show the HUD's words in the new locale; drop AI text in the old one. */
  _relocalize() {
    this._markSummaryDirty();
    this._lastSummarySignature = null;
    this._lastSummaryReply = null;
    this._summaryRequest?.abort();
    this._present({
      mode: MODE_LABELS[this._currentStyle]
        ? t(MODE_LABELS[this._currentStyle])
        : this._currentStyle.toUpperCase(),
      summaryLabel: t('SUMMARY'),
      rec: t('REC'),
      ...(this._view.vessel.active
        ? {}
        : { vessel: { active: false, text: t('AIS: --') } }),
    });
    if (this._visible && this._latestMetrics) this._updateCameraData();
    this._setSummaryText(this._composeSummary(), false);
  }

  /**
   * Present the HUD's first view: corner brackets, classification banners,
   * sensor readouts, edge metadata strips and the bottom summary bar, which
   * the Intel HUD view renders in `#intel-hud`.
   */
  _initView() {
    // i18n-ignore: sensor codes and a classification banner; the rest uses t()
    this._view = {
      active: false,
      variant: this._variant,
      colors: null,
      classification: 'TOP SECRET // SI-TK // NOFORN',
      system: `${this._missionId}  ${this._sensorId}`,
      mode: t(MODE_LABELS.normal),
      summaryLabel: t('SUMMARY'),
      summary: t('Awaiting telemetry...'),
      rec: t('REC'),
      recShown: null,
      timestamp: '2026-01-01 00:00:00Z',
      orbital: `ORB: ${this._orbitNum}  PASS: DESC-${this._passNum}`,
      mgrs: 'MGRS: ---',
      latlon: `--°--'--"N ---°--'--"W`,
      gsd: 'GSD: --m  NIIRS: --',
      alt: 'ALT: --m   SUN: --° EL',
      vessel: { active: false, text: t('AIS: --') },
      coll: 'COLL: --:--:--Z',
      ona: 'ONA: --°',
      sensor: ['BAND: PAN', 'BITS: 11', 'LVL: 1A'],
      bottom: 'LAT: --  LON: --  MGRS: ---',
    };
    this._present({});
  }

  /**
   * Merge `patch` into the view and publish it when anything changed.
   * @param {object} patch
   */
  _present(patch) {
    Object.assign(this._view, patch);
    const signature = JSON.stringify(this._view);
    if (signature === this._viewSignature) return;
    this._viewSignature = signature;
    this._publish(Object.freeze({ ...this._view }));
  }

  /**
   * Start all periodic update timers (timestamp, REC blink, camera
   * telemetry, semantic summary). Timers run independently at different
   * cadences and are cleaned up in {@link destroy}.
   */
  _startTimers() {
    // Timestamp — every second
    this._timestampInterval = setInterval(() => {
      this._present({ timestamp: this._formatUTC() });
    }, 1000);

    // REC blink — every 800ms
    this._recBlinkInterval = setInterval(() => {
      this._recBlinkState = !this._recBlinkState;
      this._present({ recShown: this._recBlinkState });
    }, 800);

    // Camera-derived data — 4 updates/second (250ms). Skipped in a hidden
    // page, except an inline panel, whose host may report it hidden while it
    // is on screen (see keepPanelRendering in app/embed.js).
    this._updateInterval = setInterval(() => {
      if (!this._visible || (document.hidden && !isEmbeddedInline())) return;
      this._updateCameraData();
    }, 250);

    // Semantic summary refresh cadence
    this._summaryInterval = setInterval(() => {
      if (!this._visible) return;
      void this._updateSummary(true);
    }, HUD_SUMMARY_INTERVAL_MS);
  }

  /**
   * Format the HUD's world time as a UTC Zulu string.
   * @returns {string} Timestamp in `YYYY-MM-DD HH:MM:SSZ` format.
   */
  _formatUTC() {
    const now = new Date(hudTime());
    const y = now.getUTCFullYear();
    const mo = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    const h = String(now.getUTCHours()).padStart(2, '0');
    const mi = String(now.getUTCMinutes()).padStart(2, '0');
    const s = String(now.getUTCSeconds()).padStart(2, '0');
    return `${y}-${mo}-${d} ${h}:${mi}:${s}Z`;
  }

  /**
   * Geoid undulation N at the camera subpoint, memoized per coarse cell.
   * @param {number} latDeg - Camera latitude in decimal degrees.
   * @param {number} lonDeg - Camera longitude in decimal degrees.
   * @returns {number|null} N in metres, or null while the grid is unavailable.
   */
  _geoidUndulationM(latDeg, lonDeg) {
    if (!this._geoidReady) {
      if (!this._geoidRequested) {
        this._geoidRequested = true;
        ensureGeoidReady()
          .then(() => {
            this._geoidReady = true;
          })
          .catch(() => {
            /* readout falls back to the uncorrected height */
          });
      }
      return null;
    }
    const key = `${Math.round(latDeg / HUD_GEOID_CELL_DEG)}:${Math.round(lonDeg / HUD_GEOID_CELL_DEG)}`;
    if (key !== this._geoidCellKey) {
      try {
        this._geoidN = geoidHeight(latDeg, lonDeg);
      } catch {
        this._geoidN = null;
      }
      this._geoidCellKey = key;
    }
    return Number.isFinite(this._geoidN) ? this._geoidN : null;
  }

  /**
   * Derive all camera-based telemetry and push values to the DOM.
   * Reads the viewer camera's cartographic position and computes MGRS,
   * lat/lon DMS, GSD, NIIRS, sun elevation, off-nadir angle, and
   * collection timestamp. Stores results in {@link _latestMetrics}.
   */
  _updateCameraData() {
    const camera = this.viewer.camera;
    const cartographic = camera.positionCartographic;
    if (!cartographic) return;

    const lonDeg = Cesium.Math.toDegrees(cartographic.longitude);
    const latDeg = Cesium.Math.toDegrees(cartographic.latitude);
    const altM = cartographic.height;
    const latDMS = this._toDMS(latDeg, 'lat');
    const lonDMS = this._toDMS(lonDeg, 'lon');
    let mgrsLabel = '---';

    // MGRS
    try {
      const mgrsStr = toMGRS([lonDeg, latDeg], 4); // 4 = 10m precision
      // Format: 18SUJ23370716 → 18S UJ 2337 0716
      const formatted = this._formatMGRS(mgrsStr);
      mgrsLabel = formatted;
    } catch {
      /* the readout keeps its dashes */
    }
    // i18n-ignore: sensor codes
    const readouts = { mgrs: `MGRS: ${mgrsLabel}` };

    // Lat/Lon DMS
    readouts.latlon = `${latDMS} ${lonDMS}`;
    // i18n-ignore: sensor codes
    readouts.bottom = `MGRS: ${mgrsLabel}  LAT: ${latDMS}  LON: ${lonDMS}`;

    // GSD (Ground Sample Distance): an illustrative meters-per-pixel figure
    // scaled from camera altitude, not a measurement of the displayed imagery.
    // NIIRS (National Imagery Interpretability Rating Scale) is then computed
    // from that illustrative GSD with the simplified General Image Quality
    // Equation (GIQE) form: NIIRS = 10.25 - 3.32 * log10(GSD_inches).
    const gsd = Math.max(0.01, altM * 0.000375);
    const gsdInches = gsd * 39.37;
    const niirs = Math.max(
      0,
      Math.min(9, 10.25 - 3.32 * Math.log10(gsdInches)),
    );
    // i18n-ignore: sensor codes
    readouts.gsd = `GSD: ${gsd.toFixed(2)}m  NIIRS: ${niirs.toFixed(1)}`;

    // Altitude — reported as height above MEAN SEA LEVEL. `altM` is the raw
    // ellipsoidal camera height, which reads far below zero wherever the geoid
    // sits under the ellipsoid: a cockpit parked on the SFO deck (N ≈ -32 m)
    // showed "ALT: -15m", and JFK "ALT: -18m". Subtracting N restores the
    // number a viewer expects without touching the camera or any render path.
    const geoidN = this._geoidUndulationM(latDeg, lonDeg);
    const altMslM = ellipsoidalToMslDisplayM(altM, geoidN);
    const sunEl = this._estimateSunElevation(latDeg, lonDeg);
    // i18n-ignore: sensor codes
    readouts.alt = `ALT: ${Math.round(altMslM)}m   SUN: ${sunEl.toFixed(1)}° EL`;

    // Collection timestamp
    const now = new Date(hudTime());
    const h = String(now.getUTCHours()).padStart(2, '0');
    const m = String(now.getUTCMinutes()).padStart(2, '0');
    const s = String(now.getUTCSeconds()).padStart(2, '0');
    // i18n-ignore: sensor codes
    readouts.coll = `COLL: ${h}:${m}:${s}Z`;

    // Off-nadir angle (ONA): camera pitch of -90 deg is nadir (straight down),
    // so ONA = 90 + pitch gives 0 at nadir and increases toward the horizon.
    const pitchDeg = Cesium.Math.toDegrees(camera.pitch);
    const ona = Math.max(0, 90 + pitchDeg);
    // i18n-ignore: sensor codes
    readouts.ona = `ONA: ${ona.toFixed(1)}°`;
    this._present(readouts);

    // `altM` stays the raw ellipsoidal camera height the sensor model reads
    // (GSD/NIIRS, view band). `altMslM` is the ADDITIVE display datum — the
    // only one any readout string should print.
    this._latestMetrics = {
      latDeg,
      lonDeg,
      altM,
      altMslM,
      sunEl,
      ona,
    };

    // First time we have real telemetry: replace the "Awaiting telemetry..."
    // placeholder with the deterministic summary line instantly (no network),
    // so there's always meaningful context on screen. The AI summary upgrades
    // this within a second via the moveEnd kick / periodic refresh.
    if (!this._firstMetricsShown) {
      this._firstMetricsShown = true;
      this._setSummaryText(this._composeSummary(), false);
    }

    // The EGM96 grid lands mid-session, and the corner readout picks it up on
    // the very next telemetry tick. The summary line has no such cadence — it
    // repaints on camera settle or its own 15 s retry — so without this the
    // corner reads `ALT: 17m` beside a summary still reading `ALT -15M`, for
    // up to fifteen seconds. Repaint the deterministic line in the SAME tick
    // the correction turns on (or off, if a lookup starts failing), and mark
    // the summary dirty so the AI line refreshes on its normal cadence —
    // exactly what a camera settle already does.
    const geoidCorrectionApplied = Number.isFinite(geoidN);
    if (geoidCorrectionApplied !== this._geoidCorrectionApplied) {
      this._geoidCorrectionApplied = geoidCorrectionApplied;
      this._markSummaryDirty();
      this._setSummaryText(this._composeSummary(), false);
    }
  }

  /**
   * Insert spaces into a raw MGRS string for human-readable display.
   * @param {string} mgrs - Raw MGRS string, e.g. `"18SUJ23370716"`.
   * @returns {string} Formatted string, e.g. `"18S UJ 2337 0716"`.
   */
  _formatMGRS(mgrs) {
    // Regex captures: grid zone designator (1-2 digits + band letter),
    // 100km square ID (2 letters), numeric easting+northing (split in half).
    const match = mgrs.match(/^(\d{1,2}[A-Z])\s*([A-Z]{2})\s*(\d+)$/);
    if (!match) return mgrs;
    const [, zone, square, coords] = match;
    const half = coords.length / 2;
    const easting = coords.slice(0, half);
    const northing = coords.slice(half);
    return `${zone} ${square} ${easting} ${northing}`;
  }

  /**
   * Convert a decimal-degree value to a degrees-minutes-seconds string.
   * @param {number} decimal - Coordinate in decimal degrees.
   * @param {'lat'|'lon'} type - Axis selector; controls hemisphere letter
   *   and zero-padding width (2 digits for lat, 3 for lon).
   * @returns {string} Formatted DMS string, e.g. `"38°53'23.10"N"`.
   */
  _toDMS(decimal, type) {
    // Round once, in hundredths of a second, so a value that rounds up to
    // 60.00" carries into the minutes and degrees instead of printing 60.
    const hundredths = Math.round(Math.abs(decimal) * 360000);
    const deg = Math.floor(hundredths / 360000);
    const min = Math.floor(hundredths / 6000) % 60;
    const sec = ((hundredths % 6000) / 100).toFixed(2);

    let dir;
    if (type === 'lat') dir = decimal >= 0 ? 'N' : 'S';
    else dir = decimal >= 0 ? 'E' : 'W';

    const degStr =
      type === 'lon'
        ? String(deg).padStart(3, '0')
        : String(deg).padStart(2, '0');
    return `${degStr}°${String(min).padStart(2, '0')}'${String(sec).padStart(5, '0')}"${dir}`;
  }

  /**
   * Estimate current solar elevation angle above the horizon.
   *
   * Uses a simplified astronomical model: solar declination is approximated
   * from the day of year, and elevation is derived from the standard
   * sin(elevation) formula involving latitude, declination, and hour angle.
   *
   * @param {number} lat - Observer latitude in decimal degrees.
   * @param {number} lon - Observer longitude in decimal degrees.
   * @returns {number} Estimated sun elevation in degrees (negative = below horizon).
   */
  _estimateSunElevation(lat, lon) {
    const now = new Date(skyTime());
    // Approximate local solar time by shifting UTC hours by longitude offset
    const hours = now.getUTCHours() + now.getUTCMinutes() / 60 + lon / 15;
    const solarNoon = 12;
    const hourAngle = (hours - solarNoon) * 15;
    // Solar declination approximation (~23.45 deg amplitude sinusoidal over the year)
    const declination =
      23.45 *
      Math.sin(
        Cesium.Math.toRadians(
          (360 / 365) * (now.getUTCDate() + 30 * now.getUTCMonth() - 81),
        ),
      );
    const latRad = Cesium.Math.toRadians(lat);
    const decRad = Cesium.Math.toRadians(declination);
    const haRad = Cesium.Math.toRadians(hourAngle);
    // Standard formula: sin(el) = sin(lat)*sin(dec) + cos(lat)*cos(dec)*cos(ha)
    const sinEl =
      Math.sin(latRad) * Math.sin(decRad) +
      Math.cos(latRad) * Math.cos(decRad) * Math.cos(haRad);
    // Clamp to [-1,1] to guard against floating-point drift before asin
    return Cesium.Math.toDegrees(Math.asin(Math.max(-1, Math.min(1, sinEl))));
  }

  /**
   * Classify the camera altitude into a named observation band.
   * @param {number} altM - Camera altitude in meters.
   * @returns {'STREET'|'CITY'|'METRO'|'REGIONAL'|'GLOBAL'} Band label.
   */
  _viewBand(altM) {
    if (altM < 1200) return 'STREET';
    if (altM < 5000) return 'CITY';
    if (altM < 30000) return 'METRO';
    if (altM < 250000) return 'REGIONAL';
    return 'GLOBAL';
  }

  /**
   * Return a coarse geographic region label based on lat/lon bounding boxes.
   * @param {number} lat - Latitude in decimal degrees.
   * @param {number} lon - Longitude in decimal degrees.
   * @returns {string} Region name (e.g. `"EUROPE"`, `"NORTHERN OCEANIC GRID"`).
   */
  _regionLabel(lat, lon) {
    if (lat > 72) return 'ARCTIC';
    if (lat < -60) return 'ANTARCTIC';
    if (lat >= 5 && lat <= 83 && lon >= -170 && lon <= -50)
      return 'NORTH AMERICA';
    if (lat >= -60 && lat <= 15 && lon >= -90 && lon <= -30)
      return 'SOUTH AMERICA';
    if (lat >= 34 && lat <= 72 && lon >= -25 && lon <= 45) return 'EUROPE';
    if (lat >= -35 && lat <= 38 && lon >= -20 && lon <= 55) return 'AFRICA';
    if (lat >= 5 && lat <= 80 && lon >= 45 && lon <= 180) return 'ASIA';
    if (lat >= -50 && lat <= 5 && lon >= 110 && lon <= 180) return 'OCEANIA';
    return lat >= 0 ? 'NORTHERN OCEANIC GRID' : 'SOUTHERN OCEANIC GRID';
  }

  /**
   * Compute the approximate width and height (in km) of the camera's
   * current view rectangle on the ground.
   * @param {number} latDeg - Center latitude in decimal degrees (for
   *   longitude-to-km cosine correction).
   * @returns {{ widthKm: number, heightKm: number }|null} View window
   *   dimensions, or null if the view rectangle cannot be computed.
   */
  _viewWindowKm(latDeg) {
    const rect = this.viewer.camera.computeViewRectangle();
    if (!rect) return null;
    const north = Cesium.Math.toDegrees(rect.north);
    const south = Cesium.Math.toDegrees(rect.south);
    let east = Cesium.Math.toDegrees(rect.east);
    let west = Cesium.Math.toDegrees(rect.west);
    let lonSpan = Math.abs(east - west);
    // Handle antimeridian wrap: if span exceeds 180 deg, take the shorter arc
    if (lonSpan > 180) lonSpan = 360 - lonSpan;
    const latSpan = Math.abs(north - south);
    // 111 km/deg is the approximate surface distance per degree of latitude;
    // longitude distance is scaled by cos(lat) to account for meridian convergence.
    const widthKm = Math.max(
      0,
      lonSpan * 111 * Math.cos(Cesium.Math.toRadians(latDeg)),
    );
    const heightKm = Math.max(0, latSpan * 111);
    return { widthKm, heightKm };
  }

  /**
   * Compute the great-circle distance between two geographic points
   * using the Haversine formula.
   * @param {number} lat1 - Start latitude (decimal degrees).
   * @param {number} lon1 - Start longitude (decimal degrees).
   * @param {number} lat2 - End latitude (decimal degrees).
   * @param {number} lon2 - End longitude (decimal degrees).
   * @returns {number} Distance in kilometers.
   */
  _haversineKm(lat1, lon1, lat2, lon2) {
    return greatCircleKm({ lat: lat1, lon: lon1 }, { lat: lat2, lon: lon2 });
  }

  /**
   * Find the closest known POI to the given coordinates.
   * @param {number} latDeg - Latitude in decimal degrees.
   * @param {number} lonDeg - Longitude in decimal degrees.
   * @returns {{ city: string, poi: string, lat: number, lon: number, distKm: number }|null}
   *   Nearest point with distance, or null if no POIs are loaded.
   */
  _nearestKnownPoint(latDeg, lonDeg) {
    let best = null;
    for (const point of NEARBY_POINTS) {
      const distKm = this._haversineKm(latDeg, lonDeg, point.lat, point.lon);
      if (!best || distKm < best.distKm) {
        best = { ...point, distKm };
      }
    }
    return best;
  }

  /**
   * Build the one-line semantic summary string from the latest camera metrics.
   * Includes mode, observation band, nearest POI or lat/lon sector, region,
   * altitude, view window dimensions, sun elevation, ONA, and local timezone.
   * @returns {string} Formatted summary line for the HUD summary readout.
   */
  _composeSummary() {
    const m = this._latestMetrics;
    if (!m) return t('Awaiting telemetry...');

    const modeLabel = this._view.mode || t(MODE_LABELS.normal);
    const region = this._regionLabel(m.latDeg, m.lonDeg);
    const nearest = this._nearestKnownPoint(m.latDeg, m.lonDeg);
    const band = this._viewBand(m.altM);
    const window = this._viewWindowKm(m.latDeg);
    // Rough local timezone from longitude (15 deg per hour)
    const utcOffset = Math.round(m.lonDeg / 15);
    const localTag = `UTC${utcOffset >= 0 ? '+' : ''}${utcOffset}`;
    // Same MSL datum as the corner ALT readout — the two are on screen
    // together, so they must never disagree. The view band above deliberately
    // keeps the ellipsoidal height: its thresholds were tuned against it.
    const altDisplayM = Number.isFinite(m.altMslM) ? m.altMslM : m.altM;
    // Display only: the AI summary request carries its own context, so this
    // line is built in the active language.
    const altTag =
      altDisplayM >= 1000
        ? hudQuantity(altDisplayM / 1000, 'km', 1)
        : hudQuantity(Math.round(altDisplayM), 'm');
    const winTag = window
      ? `${hudQuantity(Math.max(1, Math.round(window.widthKm)), '')}x${hudQuantity(Math.max(1, Math.round(window.heightKm)), 'km')}`
      : t('N/A');
    // NEAR the nearest catalogued POI at metro range; otherwise the lat/lon sector.
    const localityTag = composeLocalityTag(
      nearest,
      m.latDeg,
      m.lonDeg,
      LOCALIZED_LOCALITY,
    );

    const provenance = hudTelemetryProvenance(
      this._dataManager?.getAll?.() || [],
    );
    // ALT, SUN and ONA are sensor codes, as in the corner readouts.
    const line = t(
      '{mode} {band} {locality} | {region} | ALT {alt} | WINDOW {window} | SUN {sun}° | ONA {ona}° | {zone}',
      {
        mode: modeLabel,
        band: viewBandLabel(band),
        locality: localityTag,
        region: REGION_LABELS[region] ? t(REGION_LABELS[region]) : region,
        alt: altTag,
        window: winTag,
        sun: formatNumber(Math.round(m.sunEl)),
        ona: formatNumber(Math.round(m.ona)),
        zone: localTag,
      },
    );
    return withProvenance(line, provenance);
  }

  /** Stop a summary still typing out, leaving what it has typed so far. */
  _stopSummaryTyping() {
    clearInterval(this._summaryTypingInterval);
    this._summaryTypingInterval = null;
  }

  /**
   * Animate the summary text into the DOM using a typewriter effect
   * (2 characters every 24ms).
   * @param {string} text - Full summary string to type out.
   */
  _typeSummary(text) {
    clearInterval(this._summaryTypingInterval);
    let index = 0;
    this._present({ summary: '' });
    this._summaryTypingInterval = setInterval(() => {
      index += 2;
      if (index >= text.length) {
        this._present({ summary: text });
        clearInterval(this._summaryTypingInterval);
        this._summaryTypingInterval = null;
        return;
      }
      this._present({ summary: text.slice(0, index) });
    }, 24);
  }

  /**
   * Refresh the summary readout. Optionally animates the text via typewriter.
   * @param {boolean} [animate=false] - If true, types the summary character
   *   by character; otherwise sets it instantly.
   */
  async _updateSummary(animate = false, force = false) {
    const fallbackText = this._composeSummary();
    if (!this._latestMetrics) {
      this._setSummaryText(fallbackText, animate);
      return;
    }
    if (!force && !this._summaryDirty) return;
    if (this.summaryPolicy.canRequest?.() === false) return;

    const revision = this._summaryRevision;
    // The place lookups below are paid Google requests made only to feed the
    // AI summary, so a server without one must not be asked to make them.
    if (!(await this._summaryAvailable())) {
      if (revision !== this._summaryRevision) return;
      this._summaryDirty = false;
      this._setSummaryText(fallbackText, animate);
      return;
    }
    if (revision !== this._summaryRevision) return;
    // Every caller invokes this as `void this._updateSummary(...)`, so nothing
    // owns the returned promise — a rejection escaping from here lands as an
    // unhandled rejection in the console. Building the context walks the live
    // scene (the view-target pick, the layer roster), so it belongs INSIDE a
    // guard rather than in front of one. A summary we cannot build is a
    // fallback line, not a crash.
    let context;
    try {
      context = await this._summaryContext();
    } catch (error) {
      console.warn('[HUD] summary context unavailable:', error);
      // Left dirty on purpose: the next periodic tick retries instead of
      // sticking on the fallback line for the rest of the session. The
      // fallback was composed for this view; a moved camera keeps its own.
      if (revision === this._summaryRevision)
        this._setSummaryText(fallbackText, animate);
      return;
    }
    if (revision !== this._summaryRevision) return;
    // Without a place label the model invents a place: show the plain line.
    const described = [
      context.placeLabels,
      context.streetLabels,
      context.nearbyPlaceLabels,
    ].some((list) => list?.length);
    if (!described) {
      this._summaryDirty = false;
      this._setSummaryText(fallbackText, false);
      return;
    }
    const signature = JSON.stringify(context);
    if (!force && signature === this._lastSummarySignature) {
      this._summaryDirty = false;
      // A settle painted the fallback line over the reply this context
      // already has; reused place labels make that common, so restore it.
      // The warning is the current one: layer states are not in a
      // non-English signature.
      if (this._lastSummaryReply)
        this._setSummaryText(
          aiSummaryLine(this._lastSummaryReply, context.warning),
        );
      return;
    }
    if (this._summaryRequest) return;

    if (force) this._setSummaryText(fallbackText, false);
    this._summaryDirty = false;
    this._lastSummarySignature = signature;
    this._lastSummaryReply = null;
    const controller = new AbortController();
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 5000);
    this._summaryRequest = controller;
    try {
      this.summaryPolicy.onRequest?.();
      const response = await this.summaryService.summarize(context, {
        signal: controller.signal,
      });
      const data = response.data;
      if (revision !== this._summaryRevision) return;
      if (isHudSummaryUnconfigured(response.status, data)) {
        this._summaryUnconfigured = true;
        this._setSummaryText(fallbackText, animate);
        return;
      }
      if (!response.ok || !data?.summary) {
        throw new Error(data?.error || `HTTP ${response.status}`);
      }
      if (
        hudSummaryMatchesProvenance(data, context.feedProvenance) &&
        !hudSummaryHasEnglish(
          data.summary,
          context.locale,
          summaryForbiddenWords(context),
        )
      ) {
        this._lastSummaryReply = data.summary;
      }
      // The warning is the HUD's own translated state, not the model's words.
      this._setSummaryText(
        this._lastSummaryReply
          ? aiSummaryLine(this._lastSummaryReply, context.warning)
          : fallbackText,
        animate,
      );
    } catch (error) {
      // The 5 s timeout is a failure like any other; a move's abort (or
      // destroy's) is not.
      const moved = revision !== this._summaryRevision;
      if (error?.name !== 'AbortError' || timedOut) {
        console.warn('[HUD] AI summary unavailable:', error);
        // Invalidate the committed signature so the next periodic tick
        // retries instead of sticking on the fallback line forever.
        this._lastSummarySignature = null;
        this._summaryDirty = true;
      }
      if (!moved) this._setSummaryText(fallbackText, animate);
    } finally {
      window.clearTimeout(timeout);
      if (this._summaryRequest === controller) this._summaryRequest = null;
      // A request whose answer was dropped (aborted by a move, or a reply
      // that came back after one) committed a signature it never painted;
      // forget it, or the next tick over the same place would skip asking.
      if (revision !== this._summaryRevision) this._lastSummarySignature = null;
    }
  }

  _setSummaryText(text, animate) {
    if (animate) {
      this._typeSummary(text);
      return;
    }
    // A plain paint replaces any reply still typing.
    this._stopSummaryTyping();
    this._present({ summary: text });
  }

  /**
   * False once the summary service reports no AI summary: by its capability
   * probe, when it has one, or by a deliberate unconfigured reply. Unknown
   * stays available, as before.
   */
  async _summaryAvailable() {
    if (this._summaryUnconfigured) return false;
    try {
      if ((await this.summaryService?.configured?.()) === false)
        this._summaryUnconfigured = true;
    } catch {
      /* an unanswered probe leaves the summary as it was */
    }
    return !this._summaryUnconfigured;
  }

  async _summaryContext() {
    const revision = this._summaryRevision;
    const labels = await getBasemapLabelContext(this.viewer, this.placeSearch, {
      ...this.basemapContext,
      previous: this._placeLabels,
    });
    // A slower build for a view the camera has left must not replace the
    // newer view's lookup.
    if (revision === this._summaryRevision) this._placeLabels = labels;
    const locale = getLocale();
    const layerContext = hudSummaryLayerContext(
      this._dataManager?.getAll?.() || [],
    );
    // Outside English a layer's state id is left out: the model echoes it,
    // and `overall` already carries the state.
    const named = ({ feedState, ...layer }) => ({
      ...layer,
      name: localizeLayerName(layer.name),
      ...(locale === 'en' && { feedState }),
    });
    const { feedProvenance } = layerContext;
    const context = {
      locale,
      placeLabels: labels.placeLabels,
      streetLabels: labels.streetLabels,
      nearbyPlaceLabels: labels.nearbyPlaceLabels,
      // The model sees only the layer names the user sees. The English note
      // goes too: a small model copies its words. `overall` stays the id.
      enabledLayerLabels:
        layerContext.enabledLayerLabels.map(localizeLayerName),
      enabledLayers: layerContext.enabledLayers.map(named),
      feedProvenance: {
        ...feedProvenance,
        layers: feedProvenance.layers.map(named),
        note: locale === 'en' ? feedProvenance.note : undefined,
      },
    };
    // Not sent and not part of the signature: the line's own warning, taken
    // before the layer states are left out, and the English names and ids of
    // translated layers, which a reply in another language must not echo.
    Object.defineProperties(context, {
      warning: { value: provenanceTag(feedProvenance) },
      englishLayerWords: {
        value: layerContext.enabledLayers
          .filter(({ name }) => localizeLayerName(name) !== name)
          .flatMap(({ name, id }) => [name, id].filter(Boolean)),
      },
    });
    return context;
  }

  _markSummaryDirty() {
    this._summaryDirty = true;
    this._summaryRevision++;
  }

  // ── Public API ──────────────────────────

  /**
   * React to a shader-style change. Updates the mode label, HUD color
   * scheme (via CSS custom properties), and auto-shows/hides the overlay
   * when in auto mode.
   * @param {string} styleName - Active style key (e.g. `'surveillance'`,
   *   `'thermal'`, `'retro'`, `'normal'`).
   */
  onStyleChange(styleName) {
    this._currentStyle = styleName;

    // Mode label and color scheme
    const colors = HUD_COLORS[styleName] || HUD_COLORS._default;
    this._present({
      mode: MODE_LABELS[styleName]
        ? t(MODE_LABELS[styleName])
        : styleName.toUpperCase(),
      colors: {
        '--hud-color': colors.main,
        '--hud-glow': colors.glow,
        '--hud-border': colors.border,
      },
    });

    // Auto show/hide
    if (this._autoMode) {
      if (MILITARY_STYLES.has(styleName)) {
        this.show();
      } else {
        this.hide();
      }
    }
  }

  /** Make the HUD visible and immediately refresh all readouts. */
  show() {
    this._visible = true;
    this._present({ active: true });
    this._updateCameraData(); // immediate update
    this._markSummaryDirty();
    void this._updateSummary(false, true);
  }

  /** Hide the HUD overlay. */
  hide() {
    this._visible = false;
    this._present({ active: false });
  }

  /** Toggle HUD visibility and disable auto-mode (user override). */
  toggle() {
    if (this._visible) {
      this._autoMode = false; // user override
      this.hide();
    } else {
      this._autoMode = false;
      this.show();
    }
  }

  /**
   * Explicit HUD mode control for scene/recording playback.
   * @param {'auto'|'on'|'off'} mode - `'auto'` re-enables style-driven
   *   show/hide; `'on'`/`'off'` force visibility and disable auto-mode.
   */
  setMode(mode) {
    if (mode === 'auto') {
      this._autoMode = true;
      this.onStyleChange(this._currentStyle);
      return;
    }

    this._autoMode = false;
    if (mode === 'on') this.show();
    else this.hide();
  }

  /**
   * Switch the HUD layout variant. Falls back to `'tactical'` if the
   * name is unrecognized. Cyber also applies a coordinated skin to the full
   * application shell; leaving Cyber restores the standard shell tokens.
   * @param {string} variantName - One of `'tactical'`, `'minimal'`, `'cyber'`.
   */
  setVariant(variantName) {
    this._variant = normalizeHudLayout(variantName);
    this._present({ variant: this._variant });
    applyHudUiTheme(document.documentElement, this._variant);
  }

  /**
   * @returns {string} The current HUD layout variant name.
   */
  getVariant() {
    return this._variant;
  }

  /**
   * @returns {'auto'|'on'|'off'} Current HUD mode — `'auto'` when style-driven
   *   show/hide is active, otherwise the explicit visibility override.
   */
  getMode() {
    if (this._autoMode) return 'auto';
    return this._visible ? 'on' : 'off';
  }

  /** @returns {boolean} Whether the HUD is currently visible. */
  get visible() {
    return this._visible;
  }

  attachDataManager(dataManager) {
    if (this._dataManagerUnsubscribe) {
      this._dataManagerUnsubscribe();
      this._dataManagerUnsubscribe = null;
    }
    this._dataManager = dataManager || null;
    if (typeof this._dataManager?.subscribe === 'function') {
      this._dataManagerUnsubscribe = this._dataManager.subscribe((change) => {
        if (
          ['visibility', 'refresh-transition', 'refresh-cancelled'].includes(
            change?.type,
          )
        )
          this._markSummaryDirty();
      });
    }
    this._markSummaryDirty();
  }

  /** Tear down all running intervals. Call when discarding the HUD instance. */
  destroy() {
    clearInterval(this._updateInterval);
    clearInterval(this._recBlinkInterval);
    clearInterval(this._timestampInterval);
    clearInterval(this._summaryInterval);
    clearInterval(this._summaryTypingInterval);
    this.viewer.camera.moveStart.removeEventListener(this._onCameraMoveStart);
    this.viewer.camera.moveEnd.removeEventListener(this._onCameraMoveEnd);
    this._dataManagerUnsubscribe?.();
    this._vesselUnsubscribe?.();
    this._summaryRequest?.abort();
    this._offLocale();
  }
}
