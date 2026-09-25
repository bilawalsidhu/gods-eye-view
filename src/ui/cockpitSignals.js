/** Reconcile actionable signal rows without disturbing native keyboard focus. */
import { t } from '../i18n/index.js';

export function renderCockpitSignals() {
  if (!this.signalList) return;
  const existing = [...this.signalList.children];
  const focusedEntry = existing.find((entry) =>
    entry.contains(document.activeElement),
  );
  const entriesByKey = new Map();
  for (const entry of existing) {
    const key = entry.dataset.signalKey;
    if (!entriesByKey.has(key)) entriesByKey.set(key, []);
    entriesByKey.get(key).push(entry);
  }
  const setText = (element, value) => {
    if (element.textContent !== value) element.textContent = value;
  };
  const entries = this.signalItems.map((item) => {
    // Identity includes the action target: a reused status key must never
    // silently turn a focused flight button into a different selection.
    const key = JSON.stringify([
      item.key,
      Boolean(item.target),
      item.target?.layerId || '',
      String(item.target?.id ?? ''),
    ]);
    let entry = entriesByKey.get(key)?.shift();
    if (!entry) {
      entry = document.createElement('li');
      entry.dataset.signalKey = key;
      const time = document.createElement('time');
      const body = document.createElement('div');
      const heading = document.createElement(item.target ? 'button' : 'strong');
      if (item.target) {
        heading.type = 'button';
        heading.className = 'cockpit-signal-target';
        const label = document.createElement('span');
        label.className = 'cockpit-signal-target-label';
        const rule = document.createElement('span');
        rule.className = 'cockpit-signal-target-rule';
        rule.setAttribute('aria-hidden', 'true');
        const chevron = document.createElement('span');
        chevron.className =
          'material-symbols-outlined cockpit-signal-target-chevron';
        chevron.setAttribute('aria-hidden', 'true');
        chevron.textContent = 'chevron_right';
        heading.append(label, rule, chevron);
      }
      body.append(heading, document.createElement('span'));
      entry.append(time, body);
    }
    const [time, body] = entry.children;
    const [heading, copy] = body.children;
    const className = item.target ? `${item.tone} actionable` : item.tone;
    if (entry.className !== className) entry.className = className;
    setText(time, new Date(item.timestamp).toISOString().slice(11, 19) + 'Z');
    if (item.target) {
      heading.dataset.signalLayer = item.target.layerId;
      heading.dataset.signalId = item.target.id;
      const label = t('cockpit.signal.selectFlightAria', { title: item.title });
      if (heading.getAttribute('aria-label') !== label)
        heading.setAttribute('aria-label', label);
      setText(heading.children[0], item.title);
    } else {
      setText(heading, item.title);
    }
    setText(copy, item.detail);
    return entry;
  });
  const retainedFocus = entries.includes(focusedEntry) ? focusedEntry : null;
  if (focusedEntry && !retainedFocus) {
    // A departed contact cannot remain selectable. Continue from the stable
    // briefing footer instead of dropping keyboard traversal to the page top.
    (this.briefTabs?.[this.briefPageIndex] || this.signalToggle)?.focus({
      preventScroll: true,
    });
  }
  for (const entry of existing) if (!entries.includes(entry)) entry.remove();

  // Ordinary insertBefore moves disconnect an element and lose its focus.
  // Reorder the other rows around the focused row, which stays connected.
  const focusIndex = retainedFocus ? entries.indexOf(retainedFocus) : -1;
  if (retainedFocus) {
    let anchor = retainedFocus;
    for (let index = focusIndex - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry.nextElementSibling !== anchor)
        this.signalList.insertBefore(entry, anchor);
      anchor = entry;
    }
  }
  let anchor = retainedFocus
    ? retainedFocus.nextElementSibling
    : this.signalList.firstElementChild;
  for (let index = focusIndex + 1; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === anchor) anchor = anchor.nextElementSibling;
    else this.signalList.insertBefore(entry, anchor);
  }
  this.scheduleContextLayout();
}

export function pushCockpitSignal(key, tone, title, detail, target = null) {
  if (!this.signalList || !title || !detail) return;
  const signature = `${title}|${detail}|${target?.layerId || ''}|${target?.id || ''}`;
  if (this.signalSignatures.get(key) === signature) return;
  this.signalSignatures.set(key, signature);
  this.signalItems.unshift({
    key,
    tone,
    title,
    detail,
    target,
    timestamp: Date.now(),
  });
  this.signalItems = this.signalItems.slice(0, 5);
  this.renderCockpitSignals();
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
      detail: t('cockpit.signal.contactCurrent', {
        aircraftClass:
          subject.layerId === 'military'
            ? t('cockpit.signal.classMilitary')
            : t('cockpit.signal.classCommercial'),
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
        detail: t('cockpit.signal.contactRange', {
          aircraftClass:
            cohort.id === 'military'
              ? t('cockpit.signal.classMilitary')
              : t('cockpit.signal.classCommercial'),
          distance: Number.isFinite(item.distanceM)
            ? `${item.distanceM < 10000 ? (item.distanceM / 1000).toFixed(1) : Math.round(item.distanceM / 1000)} KM`
            : t('cockpit.signal.distanceUnknown'),
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
      title: t('cockpit.signal.inputsUnknown', { count: unknownCount }),
      detail: sources || t('cockpit.signal.sourceStatusUnavailable'),
      target: null,
      timestamp:
        previous.get('input-status')?.timestamp ||
        snapshot.evaluatedAt ||
        Date.now(),
    });
  }
  this.signalItems = nextItems;
  this.signalSignatures.clear();
  this.renderCockpitSignals();
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
