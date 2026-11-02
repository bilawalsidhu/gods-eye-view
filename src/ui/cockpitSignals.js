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
          label: t('Select flight {title}', { title: item.title }),
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

export function updateCockpitSignals(snapshot, unknownCount) {
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
  const nextItems = contacts.slice(0, 5).map((item) => ({
    ...item,
    timestamp:
      previous.get(item.key)?.timestamp || snapshot.evaluatedAt || Date.now(),
  }));
  if (unknownCount) {
    const sources = snapshot.cohorts
      .filter((cohort) => cohort.count === null)
      .map((cohort) => cohort.source)
      .join(' · ');
    nextItems.splice(4, Math.max(0, nextItems.length - 4), {
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
  this.services.militaryAwarenessLayer.focusTarget?.(
    target.dataset.signalLayer,
    target.dataset.signalId,
    { origin: 'user' },
  );
}
