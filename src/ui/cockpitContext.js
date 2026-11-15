/** Contact readouts and nearby-signal presentation for the Cockpit controller. */
import * as Cesium from 'cesium';
import { formatNumber, t, tn } from '../i18n/index.js';
import { sourceStatusLabel } from './layerNames.js';
import { unitLabel } from './unitLabels.js';
import {
  bearingBetweenCoordinates,
  formatCockpitContextScope,
  relativeBearing,
  resolveCockpitContextReadout,
} from '../cockpitMath.js';
import {
  cockpitUnitCase,
  formatCockpitDistance,
} from './cockpitPresentation.js';

/** The Context scope line in the active language (see cockpitMath.js). */
const LOCALIZED_CONTEXT_SCOPE = Object.freeze({
  window: ({ label, radiusKm }) =>
    t('{label} · {radius} AIR/SEA WINDOW', {
      label,
      radius: `${radiusKm === null ? '—' : formatNumber(radiusKm)}\u00a0${cockpitUnitCase(unitLabel('km'))}`,
    }),
  installations: ({ scope, coverage }) =>
    t('{scope} · INSTALLATIONS {coverage}', { scope, coverage }),
});

/**
 * Which air feed the aircraft Cockpit's surrounding picture is missing. Entry
 * needs only the ridden aircraft's own layer, so the other one may be off;
 * the panels then say the picture is partial rather than present it as
 * complete. Null with both feeds on, or when the owner cannot tell.
 * @returns {?{title: string, detail: string}}
 */
export function readPartialPicture() {
  const isLayerEnabled = this.services.isLayerEnabled;
  if (typeof isLayerEnabled !== 'function') return null;
  const militaryOff = !isLayerEnabled('military');
  const flightsOff = !isLayerEnabled('flights');
  if (!militaryOff && !flightsOff) return null;
  return {
    title: militaryOff
      ? t('MILITARY FEED OFF · PARTIAL PICTURE')
      : t('FLIGHTS FEED OFF · PARTIAL PICTURE'),
    detail: t('NEARBY AIRCRAFT INCOMPLETE · NOT AN ALL-CLEAR'),
  };
}

/** Hand a fresh copy of the Contact card to the view. */
export function publishContextView() {
  const view = this.contextView;
  this.publishContext({
    ...view,
    cohorts: Object.fromEntries(
      Object.entries(view.cohorts).map(([id, cohort]) => [id, { ...cohort }]),
    ),
    nearest: { ...view.nearest },
    distance: { ...view.distance },
    direction: { ...view.direction },
  });
}

/** Show or hide the Contact card; the HUD marks it with `context-active`. */
export function showContextCard(visible) {
  if (this.presence.context === visible) return;
  this.presence.context = visible;
  this.publishPresenceView();
}

export function updateContext(info, heading) {
  if (!this.context) return;
  const view = this.contextView;
  const snapshot =
    this.services.militaryAwarenessLayer.getContextSnapshot?.() || null;
  const trackedId = info.icao24 || info.id;
  const readout = resolveCockpitContextReadout({ snapshot, info });
  const partial = readPartialPicture.call(this);
  if (!readout.visible) {
    // Contacts just went off: the rows its snapshot built stop being
    // measured, so they go before the standby rows replace them.
    if (this.presence.context) this.dropContextSnapshotSignals?.();
    this.showContextCard(false);
    this.contextLayoutStamp = null;
    this.pushCockpitSignal(
      'context-status',
      'info',
      t('CONTEXT STANDBY'),
      t('ENABLE GLOBAL CONTEXT FOR PROXIMITY PINGS'),
    );
    if (partial)
      this.pushCockpitSignal(
        'feed-status',
        'warning',
        partial.title,
        partial.detail,
      );
    else this.dropCockpitSignal?.('feed-status');
    return;
  }

  this.showContextCard(true);
  const installationCoverage = snapshot.cohorts.find(
    (cohort) => cohort.id === 'military-installations',
  )?.coverage;
  view.subject = formatCockpitContextScope(
    snapshot.subject.label || trackedId,
    snapshot.radiusM,
    installationCoverage,
    LOCALIZED_CONTEXT_SCOPE,
  );
  // Navigation stays wired in every state — the operator must always be able
  // to step off the current contact from the panel that hosts the controls.
  view.canPrevious = Boolean(snapshot.navigation?.canPrevious);
  view.canNext = Boolean(snapshot.navigation?.canNext);

  if (readout.contactLost) {
    // The subject left its source. Every number below is measured against a
    // position that stopped updating, so hold the last rendered readout and
    // say so instead of re-deriving stale geometry as if it were live.
    const enteringLost = view.state !== 'lost';
    view.state = 'lost';
    view.uncertainty = t(
      'CONTACT LOST · LAST KNOWN READOUT · NOT AN ALL-CLEAR',
    );
    this.publishContextView();
    // The cue changes the footer's height; re-run layout once on the way in
    // rather than every frame the contact stays lost.
    if (enteringLost) this.scheduleContextLayout();
    this.pushCockpitSignal(
      'context-status',
      'warning',
      t('CONTACT LOST · {subject}', {
        subject: snapshot.subject.label || snapshot.subject.id || 'SUBJECT',
      }),
      t('SUBJECT LEFT ITS FEED · READOUT HOLDING LAST KNOWN'),
    );
    return;
  }

  let unknownCount = 0;
  const nearest = [];
  for (const cohort of snapshot.cohorts) {
    const shown = view.cohorts[cohort.id];
    if (shown) {
      shown.count = cohort.count === null ? '?' : String(cohort.count);
      shown.unknown = cohort.relationship === 'UNKNOWN';
      shown.source = sourceStatusLabel(cohort.source, cohort.sourceStatus);
    }
    if (cohort.count === null) unknownCount += 1;
    for (const item of cohort.nearest) nearest.push({ ...item, cohort });
  }
  nearest.sort((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity));
  const closest = nearest[0] || null;
  const closestLabel = this.services.formatAwarenessLabel(closest);
  const nearestLabel = closest
    ? t('{cohort} · {contact}', {
        cohort: closest.cohort.label.toUpperCase(),
        contact: closestLabel,
      })
    : t('NO AVAILABLE EXAMPLE');
  view.nearest = {
    label: nearestLabel,
    ariaLabel:
      closest && closestLabel === '—'
        ? t('{cohort}, Unavailable', { cohort: closest.cohort.label })
        : nearestLabel,
  };
  const distanceM = closest?.distanceM;
  const distance = Number.isFinite(distanceM)
    ? formatCockpitDistance(distanceM)
    : '—';
  view.distance = {
    text: distance,
    ariaLabel: Number.isFinite(distanceM) ? distance : t('Unavailable'),
  };

  // The arrow and BRG are nose-relative to the tracked aircraft. When the
  // subject is a vessel, an installation, or another aircraft, the rest of
  // this row is measured from that subject — so the aircraft-frame half is
  // dashed rather than presented alongside subject-frame distances as if the
  // two shared an origin.
  let relative = null;
  if (
    readout.aircraftRelative &&
    closest?.position &&
    Number.isFinite(info.latitude) &&
    Number.isFinite(info.longitude)
  ) {
    const cartographic = Cesium.Cartographic.fromCartesian(closest.position);
    const bearing = cartographic
      ? bearingBetweenCoordinates(
          info.latitude,
          info.longitude,
          Cesium.Math.toDegrees(cartographic.latitude),
          Cesium.Math.toDegrees(cartographic.longitude),
        )
      : null;
    relative = relativeBearing(bearing, heading);
  }
  view.direction = { angle: relative ?? 0, unknown: relative === null };
  if (relative === null) view.bearing = t('BRG —');
  else if (Math.abs(relative) < 8) view.bearing = t('AHEAD');
  else {
    view.bearing = t('{side} {angle}', {
      side: relative < 0 ? t('L') : t('R'),
      angle: `${String(Math.round(Math.abs(relative))).padStart(3, '0')}°`,
    });
  }
  // A feed that is off outranks unknown inputs: the picture is partial.
  view.uncertainty = partial
    ? partial.title
    : unknownCount
      ? tn(
          unknownCount,
          '{count} INPUT UNKNOWN · NOT AN ALL-CLEAR',
          '{count} INPUTS UNKNOWN · NOT AN ALL-CLEAR',
        )
      : t('AVAILABLE INPUTS CURRENT · NOT AN ALL-CLEAR');
  view.updated = Number.isFinite(snapshot.evaluatedAt)
    ? new Date(snapshot.evaluatedAt).toISOString().slice(11, 19) + 'Z'
    : '--:--:--Z';
  view.state = unknownCount || partial ? 'uncertain' : 'current';
  this.publishContextView();
  this.updateCockpitSignals(snapshot, unknownCount, partial);
  if (this.contextLayoutStamp !== snapshot.evaluatedAt) {
    this.contextLayoutStamp = snapshot.evaluatedAt;
    this.scheduleContextLayout();
  }
}
