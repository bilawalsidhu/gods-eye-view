// Edge cases for military-awareness:
// with no scene the same nearest contacts come back, and NEXT/PREV, a type
// filter and an exhausted list lead to the same ID whatever scene is attached
// and whatever order the feeds list equally distant contacts in.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../geo/index.js';
import { summarizeAwarenessCohort } from '../../data/militaryAwarenessEngine.js';
import { createState } from './state.js';
import { createNavigation } from './navigation.js';
import { createHistory } from './history.js';
import { createFocus } from './focus.js';

const at = (lon) => geo.cartesian3.fromDegrees(lon, 30, 3_000);

// Two pairs of exact distance ties: f2/f3 inside one layer, f1/m1 across layers.
const CONTACTS = {
  flights: [
    { icao24: 'f1', distanceM: 1_500, klass: 'widebody', position: at(0.01) },
    { icao24: 'f2', distanceM: 4_000, klass: 'helicopter', position: at(0.02) },
    { icao24: 'f3', distanceM: 4_000, klass: 'helicopter', position: at(0.03) },
  ],
  military: [
    { icao24: 'm1', distanceM: 1_500, klass: 'fighter', position: at(0.04) },
    { icao24: 'm2', distanceM: 9_000, klass: 'helicopter', position: at(0.05) },
  ],
  'ais-live-vessels': [
    { mmsi: '366000001', distanceM: 800, position: at(0.06) },
  ],
};
const SUBJECT = { layerId: 'military', id: 'm0', label: 'M0', position: at(0) };

/** The real navigation, history and focus parts over one Contacts state. */
function contacts({ reversed = false, display = null } = {}) {
  const order = (items) => (reversed ? [...items].reverse() : [...items]);
  const state = createState({ services: {} });
  state.enabled = true;
  state.display = display;
  const parts = {};
  const select = (layerId, id) => {
    const item = CONTACTS[layerId].find(
      (entry) => String(entry.icao24 || entry.mmsi) === String(id),
    );
    if (!item) return false;
    parts.subject.selectSubject({
      layerId,
      id: String(id),
      label: String(id),
      position: item.position,
    });
    return true;
  };
  const aircraftLayer = (layerId) => ({
    getNearby: (_center, radiusM, limit) =>
      order(CONTACTS[layerId])
        .filter((item) => item.distanceM <= radiusM)
        .slice(0, limit),
    trackById: (id) => select(layerId, id),
  });
  const services = {
    flights: aircraftLayer('flights'),
    military: aircraftLayer('military'),
    vessels: {
      selectById: (id) => select('ais-live-vessels', id),
      getAllPositions: () => [],
    },
    installations: { focusById: () => false },
    navigation: { announceNavigationAuthority() {} },
  };
  const context = { state, services, parts };
  parts.navigation = createNavigation(context);
  parts.history = createHistory(context);
  parts.focus = createFocus(context);
  parts.model = {
    contextTargetFlyToAllowed: () => true,
    releaseAircraftTracking() {},
  };
  // The bookkeeping subject.js does on a selection (subject.selectSubject),
  // without the panel and refresh it also drives.
  parts.subject = {
    subjectKey: (subject) =>
      subject ? `${subject.layerId}:${subject.id}` : '',
    subjectCohortFeedUnknown: () => false,
    selectSubject(subject) {
      const key = parts.subject.subjectKey(subject);
      state.navigationVisited.add(key);
      const suppress = state.suppressedHistoryKey === key;
      state.pendingSelectionKey = state.suppressedHistoryKey = null;
      const current = state.navigationHistory[state.navigationIndex];
      if (!suppress && parts.subject.subjectKey(current) !== key) {
        state.navigationHistory.splice(state.navigationIndex + 1);
        state.navigationHistory.push(
          parts.history.historySubjectSnapshot(
            subject,
            parts.history.historySourceItem(subject),
          ),
        );
        state.navigationIndex = state.navigationHistory.length - 1;
      }
      state.subject = subject;
    },
  };
  state.results = {
    cohorts: order(Object.keys(CONTACTS)).map((id) => ({
      id,
      summary: parts.navigation.summarizeAwarenessCohortForNavigation(
        order(CONTACTS[id]),
        { available: true },
      ),
    })),
  };
  parts.subject.selectSubject(SUBJECT);
  return { state, controls: parts.history };
}

function walk(session) {
  const key = () =>
    `${session.state.subject.layerId}:${session.state.subject.id}`;
  const steps = [];
  const step = (label, direction, options) => {
    const moved = session.controls.navigateHistory(direction, options);
    steps.push(`${label}${moved ? '' : '!'} ${key()}`);
  };
  // Walk past the end of the cohort so the visited cycle is exhausted.
  for (let i = 0; i < 8; i += 1) step('next', 1);
  step('prev', -1);
  step('prev', -1);
  for (let i = 0; i < 4; i += 1)
    step('next-helicopter', 1, { aircraftClass: 'helicopter' });
  for (let i = 0; i < 3; i += 1)
    step('next-military', 1, { targetLayer: 'military' });
  return steps;
}

test('edge:military-awareness: nearest contacts are the same with no scene and in any feed order', () => {
  for (const id of Object.keys(CONTACTS)) {
    const forward = summarizeAwarenessCohort(CONTACTS[id], { limit: 3 });
    const backward = summarizeAwarenessCohort([...CONTACTS[id]].reverse(), {
      limit: 3,
    });
    assert.deepEqual(
      backward.nearest.map((item) => item.icao24 || item.mmsi),
      forward.nearest.map((item) => item.icao24 || item.mmsi),
      id,
    );
  }
});

test('edge:military-awareness: NEXT, PREV, a type filter and exhaustion reach the same IDs on any scene', () => {
  const sceneless = walk(contacts());
  const attached = walk(
    contacts({ display: { camera: { positionWC: at(1) } } }),
  );
  const reordered = walk(contacts({ reversed: true }));
  assert.deepEqual(attached, sceneless);
  assert.deepEqual(reordered, sceneless);
  // Every contact is reached before the cycle starts over.
  const firstLap = sceneless.slice(0, 6).map((entry) => entry.split(' ')[1]);
  assert.equal(new Set(firstLap).size, 6, firstLap.join(', '));
  assert.ok(
    sceneless
      .filter((entry) => entry.startsWith('next-helicopter'))
      .every((entry) => /:(f2|f3|m2)$/.test(entry)),
    'the type filter only lands on helicopters',
  );
});
