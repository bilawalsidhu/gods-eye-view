/** Contact readouts and nearby-signal presentation for the Cockpit controller. */
import * as Cesium from 'cesium';
import {
  bearingBetweenCoordinates,
  formatCockpitContextScope,
  relativeBearing,
  resolveCockpitContextReadout,
} from '../cockpitMath.js';

export function updateContext(info, heading) {
  if (!this.context) return;
  const snapshot =
    this.services.militaryAwarenessLayer.getContextSnapshot?.() || null;
  const trackedId = info.icao24 || info.id;
  const readout = resolveCockpitContextReadout({ snapshot, info });
  if (!readout.visible) {
    this.context.hidden = true;
    this.hud?.classList.remove('context-active');
    this.contextLayoutStamp = null;
    this.pushCockpitSignal(
      'context-status',
      'info',
      'CONTEXT STANDBY',
      'ENABLE GLOBAL CONTEXT FOR PROXIMITY PINGS',
    );
    return;
  }

  this.context.hidden = false;
  this.hud?.classList.add('context-active');
  if (this.contextSubject) {
    const installationCoverage = snapshot.cohorts.find(
      (cohort) => cohort.id === 'military-installations',
    )?.coverage;
    this.contextSubject.textContent = formatCockpitContextScope(
      snapshot.subject.label || trackedId,
      snapshot.radiusM,
      installationCoverage,
    );
  }
  // Navigation stays wired in every state — the operator must always be able
  // to step off the current contact from the panel that hosts the controls.
  if (this.contextPrevious)
    this.contextPrevious.disabled = !snapshot.navigation?.canPrevious;
  if (this.contextNext)
    this.contextNext.disabled = !snapshot.navigation?.canNext;

  if (readout.contactLost) {
    // The subject left its source. Every number below is measured against a
    // position that stopped updating, so hold the last rendered readout and
    // say so instead of re-deriving stale geometry as if it were live.
    const enteringLost = this.context.dataset.state !== 'lost';
    this.context.dataset.state = 'lost';
    if (this.contextUncertainty) {
      this.contextUncertainty.textContent =
        'CONTACT LOST · LAST KNOWN READOUT · NOT AN ALL-CLEAR';
    }
    // The cue changes the footer's height; re-run layout once on the way in
    // rather than every frame the contact stays lost.
    if (enteringLost) this.scheduleContextLayout();
    this.pushCockpitSignal(
      'context-status',
      'warning',
      `CONTACT LOST · ${snapshot.subject.label || snapshot.subject.id || 'SUBJECT'}`,
      'SUBJECT LEFT ITS FEED · READOUT HOLDING LAST KNOWN',
    );
    return;
  }

  let unknownCount = 0;
  const nearest = [];
  for (const cohort of snapshot.cohorts) {
    const element = this.contextCohorts.get(cohort.id);
    const value = element?.querySelector('strong');
    if (value)
      value.textContent = cohort.count === null ? '?' : String(cohort.count);
    element?.classList.toggle('unknown', cohort.relationship === 'UNKNOWN');
    if (cohort.count === null) unknownCount += 1;
    for (const item of cohort.nearest) nearest.push({ ...item, cohort });
  }
  nearest.sort((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity));
  const closest = nearest[0] || null;
  const closestLabel = this.services.formatAwarenessLabel(closest);
  if (this.contextNearestLabel) {
    this.contextNearestLabel.textContent = closest
      ? `${closest.cohort.label.toUpperCase()} · ${closestLabel}`
      : 'NO AVAILABLE EXAMPLE';
    this.contextNearestLabel.setAttribute(
      'aria-label',
      closest && closestLabel === '—'
        ? `${closest.cohort.label}, Unavailable`
        : this.contextNearestLabel.textContent,
    );
  }
  if (this.contextDistance) {
    const distanceM = closest?.distanceM;
    this.contextDistance.textContent = Number.isFinite(distanceM)
      ? `${distanceM < 10000 ? (distanceM / 1000).toFixed(1) : Math.round(distanceM / 1000)} KM`
      : '—';
    this.contextDistance.setAttribute(
      'aria-label',
      Number.isFinite(distanceM)
        ? this.contextDistance.textContent
        : 'Unavailable',
    );
  }

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
  if (this.contextDirection) {
    this.contextDirection.style.transform = `rotate(${relative ?? 0}deg)`;
    this.contextDirection.classList.toggle('unknown', relative === null);
  }
  if (this.contextBearing) {
    if (relative === null) this.contextBearing.textContent = 'BRG —';
    else if (Math.abs(relative) < 8) this.contextBearing.textContent = 'AHEAD';
    else
      this.contextBearing.textContent = `${relative < 0 ? 'L' : 'R'} ${String(Math.round(Math.abs(relative))).padStart(3, '0')}°`;
  }
  if (this.contextUncertainty) {
    this.contextUncertainty.textContent = unknownCount
      ? `${unknownCount} INPUT${unknownCount === 1 ? '' : 'S'} UNKNOWN · NOT AN ALL-CLEAR`
      : 'AVAILABLE INPUTS CURRENT · NOT AN ALL-CLEAR';
  }
  if (this.contextUpdated) {
    this.contextUpdated.textContent = Number.isFinite(snapshot.evaluatedAt)
      ? new Date(snapshot.evaluatedAt).toISOString().slice(11, 19) + 'Z'
      : '--:--:--Z';
  }
  this.context.dataset.state = unknownCount ? 'uncertain' : 'current';
  this.updateCockpitSignals(snapshot, unknownCount);
  if (this.contextLayoutStamp !== snapshot.evaluatedAt) {
    this.contextLayoutStamp = snapshot.evaluatedAt;
    this.scheduleContextLayout();
  }
}
