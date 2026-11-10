/** The Cockpit signal rows: which contacts and statuses they show, and their selection. */
import { t, tn } from '../i18n/index.js';
import { formatCockpitDistance } from './cockpitPresentation.js';

/**
 * Publish the signal rows. A row's key includes its action target, so a
 * reused status key never turns a focused flight button into a different
 * selection; repeats of a key are numbered so each keeps its own row.
 */
export function publishCockpitSignals() {
  const seen = new Map();
  this.publishSignals(
    this.signalItems.map((item) => {
      const identity = JSON.stringify([
        item.key,
        Boolean(item.target),
        item.target?.layerId || '',
        String(item.target?.id ?? ''),
      ]);
      const repeat = seen.get(identity) ?? 0;
      seen.set(identity, repeat + 1);
      return {
        key: repeat ? `${identity}#${repeat}` : identity,
        className: item.target ? `${item.tone} actionable` : item.tone,
        time: new Date(item.timestamp).toISOString().slice(11, 19) + 'Z',
        title: item.title,
        detail: item.detail,
        target: item.target && {
          layerId: item.target.layerId,
          id: item.target.id,
          // Orbit's site and satellite rows name their own action.
          label:
            item.target.label ??
            t('Select flight {title}', { title: item.title }),
        },
      };
    }),
  );
  this.scheduleContextLayout();
}

export function pushCockpitSignal(key, tone, title, detail, target = null) {
  if (!title || !detail) return;
  const signature = `${title}|${detail}|${target?.layerId || ''}|${target?.id || ''}`;
  if (this.signalSignatures.get(key) === signature) return;
  this.signalSignatures.set(key, signature);
  // A locale change words the signal again where it stands.
  const shown = this.rewordingSignals
    ? this.signalItems.find((item) => item.key === key)
    : null;
  if (shown) {
    Object.assign(shown, { title, detail });
    this.publishCockpitSignals();
    return;
  }
  this.signalItems.unshift({
    key,
    tone,
    title,
    detail,
    target,
    timestamp: Date.now(),
  });
  this.signalItems = this.signalItems.slice(0, 5);
  this.publishCockpitSignals();
}

/**
 * Take a status row off the list, as when the feed it warned about is back.
 * @param {string} key The row's key.
 */
export function dropCockpitSignal(key) {
  this.signalSignatures.delete(key);
  const kept = this.signalItems.filter((item) => item.key !== key);
  if (kept.length === this.signalItems.length) return;
  this.signalItems = kept;
  this.publishCockpitSignals();
}

/** Whether a row is one a Contacts snapshot builds, with its status rows. */
const isContextSnapshotRow = (key) =>
  key.startsWith('flight:') ||
  ['input-status', 'feed-status', 'context-status'].includes(key);

/**
 * Take off every row a Contacts snapshot built, as when Contacts goes off:
 * its contacts, distances and CURRENT would otherwise read as live. Rows the
 * session made without Contacts, such as TRACK ACQUIRED, stay.
 */
export function dropContextSnapshotSignals() {
  for (const key of [...this.signalSignatures.keys()])
    if (isContextSnapshotRow(key)) this.signalSignatures.delete(key);
  const kept = this.signalItems.filter(
    (item) => !isContextSnapshotRow(item.key),
  );
  if (kept.length === this.signalItems.length) return;
  this.signalItems = kept;
  this.publishCockpitSignals();
}

/**
 * Rebuild the rows from a Contacts snapshot: the nearest flights, a row for
 * unknown inputs and, first, a row naming an air feed that is off.
 * @param {object} snapshot `militaryAwareness.getContextSnapshot()` result.
 * @param {number} unknownCount Cohorts whose count is unknown.
 * @param {?{title: string, detail: string}} [partialPicture] The feed-off
 *   row (see `readPartialPicture`), or null with every air feed on.
 */
export function updateCockpitSignals(
  snapshot,
  unknownCount,
  partialPicture = null,
) {
  const previous = new Map(this.signalItems.map((item) => [item.key, item]));
  const contacts = [];
  const subject = snapshot.subject;
  if (['flights', 'military'].includes(subject?.layerId) && subject?.id) {
    contacts.push({
      key: `flight:${subject.layerId}:${subject.id}`,
      tone: 'track',
      title: subject.label || subject.id,
      detail: t('{aircraftClass} · CURRENT', {
        aircraftClass:
          subject.layerId === 'military'
            ? t('MILITARY FLIGHT')
            : t('COMMERCIAL FLIGHT'),
      }),
      target: { layerId: subject.layerId, id: String(subject.id) },
      distanceM: -1,
    });
  }
  for (const cohort of snapshot.cohorts) {
    if (!['flights', 'military'].includes(cohort.id)) continue;
    for (const item of cohort.nearest) {
      const id = item.icao24 || item.id;
      if (!id) continue;
      contacts.push({
        key: `flight:${cohort.id}:${id}`,
        tone: cohort.id === 'military' ? 'nearby military' : 'nearby',
        // `id` above is IDENTITY (the ICAO hex). Display must not reuse it:
        // the row's own `id` already carries the layer's label convention
        // (callsign → registration → hex), so a callsign-less enriched
        // contact reads as its registration here too. Same helper the
        // Context panel's nearest list uses.
        title: this.services.formatAwarenessLabel(item),
        detail: t('{aircraftClass} · {distance}', {
          aircraftClass:
            cohort.id === 'military'
              ? t('MILITARY FLIGHT')
              : t('COMMERCIAL FLIGHT'),
          distance: Number.isFinite(item.distanceM)
            ? formatCockpitDistance(item.distanceM)
            : t('DISTANCE UNKNOWN'),
        }),
        target: { layerId: cohort.id, id: String(id) },
        distanceM: item.distanceM ?? Infinity,
      });
    }
  }
  contacts.sort((a, b) => a.distanceM - b.distanceM);
  // A feed-off row leads, so the list never reads as the whole picture.
  const reserved = partialPicture ? 1 : 0;
  const nextItems = contacts.slice(0, 5 - reserved).map((item) => ({
    ...item,
    timestamp:
      previous.get(item.key)?.timestamp || snapshot.evaluatedAt || Date.now(),
  }));
  if (unknownCount) {
    const sources = snapshot.cohorts
      .filter((cohort) => cohort.count === null)
      .map((cohort) => cohort.source)
      .join(' · ');
    nextItems.splice(
      4 - reserved,
      Math.max(0, nextItems.length - 4 + reserved),
      {
        key: 'input-status',
        tone: 'warning',
        title: tn(
          unknownCount,
          '{count} INPUT UNKNOWN',
          '{count} INPUTS UNKNOWN',
        ),
        detail: sources || t('SOURCE STATUS UNAVAILABLE'),
        target: null,
        timestamp:
          previous.get('input-status')?.timestamp ||
          snapshot.evaluatedAt ||
          Date.now(),
      },
    );
  }
  if (partialPicture) {
    nextItems.unshift({
      key: 'feed-status',
      tone: 'warning',
      title: partialPicture.title,
      detail: partialPicture.detail,
      target: null,
      timestamp:
        previous.get('feed-status')?.timestamp ||
        snapshot.evaluatedAt ||
        Date.now(),
    });
  }
  this.signalItems = nextItems;
  this.signalSignatures.clear();
  this.publishCockpitSignals();
}

export function handleSignalClick(event) {
  if (this.destroyed) return;
  const target = event.target.closest(
    'button[data-signal-layer][data-signal-id]',
  );
  if (!target) return;
  event.preventDefault();
  // In orbit the rows are sites and satellites (cockpitOrbitalSignals.js).
  if (
    this.handleOrbitalSignalClick?.(
      target.dataset.signalLayer,
      target.dataset.signalId,
    )
  )
    return;
  this.services.militaryAwarenessLayer.focusTarget?.(
    target.dataset.signalLayer,
    target.dataset.signalId,
    { origin: 'user' },
  );
}
