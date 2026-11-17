// src/cockpitSubjectProviders.test.mjs — an application's subject providers
// are checked once and what they return is normalized before the Cockpit
// uses it: a malformed provider is left out, a malformed frame ends the view,
// and a malformed HUD view is read field by field and never thrown on.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COCKPIT_BUILT_IN_KINDS,
  COCKPIT_SUBJECT_MAX_READOUTS,
  COCKPIT_SUBJECT_MAX_TICKS,
  cockpitSubjectCandidate,
  cockpitSubjectFrame,
  cockpitSubjectHudView,
  cockpitSubjectProviders,
  cockpitSubjectText,
  createCockpitSubjectCaller,
} from './cockpitSubjectProviders.js';

const noop = () => null;
/** A well-formed provider, with `overrides`. */
const provider = (overrides = {}) => ({
  kind: 'example-kind',
  layerId: 'example-layer',
  entryFace: { icon: 'commute', label: 'RIDE' },
  labels: {
    view: 'First-person view',
    exit: 'Exit first-person view',
    exitText: 'EXIT VIEW',
  },
  candidate: noop,
  hold: () => true,
  read: noop,
  hud: noop,
  release: noop,
  ...overrides,
});

const keep = (list) => {
  const warnings = [];
  const kept = cockpitSubjectProviders(list, {
    warn: (message) => warnings.push(message),
  });
  return { kept, warnings };
};

test('well-formed providers are kept, frozen, in priority then list order', () => {
  const { kept, warnings } = keep([
    provider({ kind: 'late', priority: 5 }),
    provider({ kind: 'first-of-two', priority: 1 }),
    provider({ kind: 'second-of-two', priority: 1 }),
    provider({ kind: 'default-priority' }),
  ]);
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    kept.map(({ kind }) => kind),
    ['default-priority', 'first-of-two', 'second-of-two', 'late'],
  );
  assert.ok(Object.isFrozen(kept));
  assert.ok(Object.isFrozen(kept[0]));
  const [first] = kept;
  assert.equal(first.priority, 0);
  assert.equal(first.look, null);
  assert.equal(first.cameraIntervalMs, null);
  assert.equal(first.headingSlewDps, null);
  assert.equal(first.isEntryAllowed(), true, 'no rule of its own allows');
  assert.deepEqual(first.labels, {
    view: 'First-person view',
    exit: 'Exit first-person view',
    exitText: 'EXIT VIEW',
    kicker: '',
  });
});

test('malformed, reserved and repeated providers are left out with one warning each', () => {
  const cases = [
    [null, /not an object/],
    [provider({ kind: 'X' }), /malformed kind/],
    [provider({ kind: 'a' }), /malformed kind/],
    [provider({ layerId: 'Bad Layer' }), /malformed layer id/],
    [provider({ hold: undefined }), /no hold\(\)/],
    [provider({ read: 'read' }), /no read\(\)/],
    [provider({ isEntryAllowed: true }), /isEntryAllowed/],
    [provider({ entryFace: { icon: 'Bad Icon', label: 'X' } }), /entry face/],
    [provider({ entryFace: { icon: 'commute', label: '' } }), /entry face/],
    [provider({ labels: { view: 'v', exit: 'e' } }), /labels/],
    [provider({ look: { restPitchDeg: -3 } }), /aheadLabel/],
  ];
  for (const [entry, reason] of cases) {
    const { kept, warnings } = keep([entry]);
    assert.equal(kept.length, 0, String(reason));
    assert.equal(warnings.length, 1, String(reason));
    assert.match(warnings[0], reason);
  }
  for (const kind of COCKPIT_BUILT_IN_KINDS) {
    const { kept, warnings } = keep([provider({ kind })]);
    assert.equal(kept.length, 0, kind);
    assert.match(warnings[0], /reserved kind/);
  }
  const { kept, warnings } = keep([provider(), provider()]);
  assert.equal(kept.length, 1);
  assert.match(warnings[0], /repeated kind/);
  assert.deepEqual(keep('not a list').kept, []);
});

test('optional settings are kept when in range and defaulted otherwise', () => {
  const [ranged] = keep([
    provider({
      priority: -2,
      look: { restPitchDeg: -120, aheadLabel: 'Look ahead' },
      cameraIntervalMs: 0,
      headingSlewDps: Infinity,
      labels: {
        view: 'v',
        exit: 'e',
        exitText: 'x',
        kicker: 'K'.repeat(80),
      },
    }),
  ]).kept;
  assert.equal(ranged.priority, -2);
  assert.deepEqual(ranged.look, {
    restPitchDeg: -90,
    aheadLabel: 'Look ahead',
  });
  assert.equal(ranged.cameraIntervalMs, 0);
  assert.equal(ranged.headingSlewDps, Infinity);
  assert.equal(ranged.labels.kicker.length, 48);
  assert.ok(ranged.labels.kicker.endsWith('…'));
  const [defaulted] = keep([
    provider({
      priority: NaN,
      cameraIntervalMs: 5000,
      headingSlewDps: -1,
    }),
  ]).kept;
  assert.equal(defaulted.priority, 0);
  assert.equal(defaulted.cameraIntervalMs, null);
  assert.equal(defaulted.headingSlewDps, null);
});

test('a candidate needs an id; its name and face are read with care', () => {
  assert.equal(cockpitSubjectCandidate(null), null);
  assert.equal(cockpitSubjectCandidate({ id: 7 }), null);
  assert.equal(cockpitSubjectCandidate({ id: '   ' }), null);
  assert.equal(cockpitSubjectCandidate({ id: 'x'.repeat(129) }), null);
  assert.deepEqual(cockpitSubjectCandidate({ id: ' a1 ' }), {
    id: 'a1',
    name: 'a1',
    face: null,
    selectedAt: null,
  });
  // A selection token is a number or a short string.
  assert.equal(
    cockpitSubjectCandidate({ id: 'a1', selectedAt: 5 }).selectedAt,
    5,
  );
  assert.equal(
    cockpitSubjectCandidate({ id: 'a1', selectedAt: 'click-2' }).selectedAt,
    'click-2',
  );
  for (const selectedAt of [Number.NaN, {}, 'x'.repeat(65)])
    assert.equal(
      cockpitSubjectCandidate({ id: 'a1', selectedAt }).selectedAt,
      null,
    );
  const read = cockpitSubjectCandidate({
    id: 'a1',
    name: '  Example   12 ',
    face: { icon: 'tram', label: 'RIDE' },
  });
  assert.equal(read.name, 'Example 12');
  assert.deepEqual(read.face, { icon: 'tram', label: 'RIDE' });
  assert.equal(
    cockpitSubjectCandidate({ id: 'a1', face: { icon: 'BAD' } }).face,
    null,
  );
});

test('a frame is the held subject at a finite place with an eye height, else null', () => {
  const frame = (overrides = {}) => ({
    id: 'a1',
    latitude: 47,
    longitude: 8,
    eye: { upM: 3.5 },
    ...overrides,
  });
  const read = cockpitSubjectFrame(frame(), 'a1');
  assert.deepEqual(read, {
    id: 'a1',
    name: 'a1',
    latitude: 47,
    longitude: 8,
    heightM: null,
    headingDeg: null,
    courseDeg: null,
    speedMps: null,
    stale: false,
    groundClamp: true,
    // No speed to run an inertial anchor on: it sits on the subject.
    anchor: 'exact',
    eye: { upM: 3.5, forwardM: 0, pitchDeg: 0, minClearanceM: 0 },
  });
  assert.equal(
    cockpitSubjectFrame(frame({ speedMps: 30 }), 'a1').anchor,
    'inertial',
    'with a speed it runs on',
  );
  // A held id is trimmed (cockpitSubjectCandidate), and so is a frame's.
  assert.equal(cockpitSubjectFrame(frame({ id: ' a1 ' }), 'a1')?.id, 'a1');
  for (const bad of [
    null,
    frame({ id: 'other' }),
    frame({ latitude: 91 }),
    frame({ latitude: NaN }),
    frame({ longitude: Infinity }),
    frame({ eye: null }),
    frame({ eye: { upM: -1 } }),
    frame({ eye: { upM: 2000 } }),
    frame({ eye: { upM: '3' } }),
  ])
    assert.equal(cockpitSubjectFrame(bad, 'a1'), null, JSON.stringify(bad));
  const full = cockpitSubjectFrame(
    frame({
      name: 'Example',
      longitude: 190,
      heightM: 412.5,
      headingDeg: -10,
      courseDeg: 725,
      speedMps: 22,
      stale: true,
      groundClamp: false,
      anchor: 'exact',
      eye: { upM: 2, forwardM: 600, pitchDeg: -100, minClearanceM: 1.5 },
    }),
    'a1',
  );
  assert.equal(full.longitude, -170);
  assert.equal(full.heightM, 412.5);
  // A height outside any plausible ground reads as none.
  for (const heightM of [-6_400_000, 1e9, Infinity])
    assert.equal(cockpitSubjectFrame(frame({ heightM }), 'a1').heightM, null);
  assert.equal(
    cockpitSubjectFrame(frame({ heightM: -400 }), 'a1').heightM,
    -400,
  );
  assert.equal(full.headingDeg, 350);
  assert.equal(full.courseDeg, 5);
  assert.equal(full.speedMps, 22);
  assert.equal(full.stale, true);
  assert.equal(full.groundClamp, false);
  assert.equal(full.anchor, 'exact');
  assert.deepEqual(full.eye, {
    upM: 2,
    forwardM: 0,
    pitchDeg: -90,
    minClearanceM: 1.5,
  });
  // Only exactly false turns the ground clamp off; course falls back to heading.
  const loose = cockpitSubjectFrame(
    frame({ groundClamp: 0, anchor: 'EXACT', headingDeg: 90, speedMps: -1 }),
    'a1',
  );
  assert.equal(loose.groundClamp, true);
  assert.equal(
    cockpitSubjectFrame(frame({ anchor: 'EXACT', speedMps: 5 }), 'a1').anchor,
    'inertial',
  );
  assert.equal(loose.courseDeg, 90);
  assert.equal(loose.speedMps, null);
});

test('a HUD view is read field by field: caps, tones, clamps, never a throw', () => {
  const empty = cockpitSubjectHudView(null);
  assert.deepEqual(empty, {
    kicker: '',
    title: '',
    meta: { text: '', tone: 'normal' },
    speed: null,
    readouts: [],
    sources: [],
    route: null,
    progress: null,
    banner: null,
    veil: null,
    lookReadout: '',
    signals: [],
  });
  for (const odd of [42, 'text', [], { readouts: 'x', progress: { ticks: 3 } }])
    assert.doesNotThrow(() => cockpitSubjectHudView(odd));
  const view = cockpitSubjectHudView({
    kicker: 'LINE · OPERATOR',
    title: 'Name → Destination',
    meta: { text: 'LIVE', tone: 'bogus' },
    speed: { value: 84.4, unit: 'km/h', tag: 'LIVE', tone: 'live' },
    readouts: [
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `r${i}`,
        label: 'NEXT',
        value: `Stop ${i}`,
        tone: 'warning',
      })),
    ],
    sources: [
      { id: 'track', label: 'TRACK', text: 'operator shape' },
      { id: 'track', label: 'TRACK', text: 'repeated id' },
      { id: 'Bad Id', text: 'refused' },
      { id: 'empty', label: 'X', text: '' },
    ],
    route: { title: 'ROUTE', from: 'A', to: 'B', status: '3 stops' },
    banner: { title: 'BANNER', detail: 'detail', tone: 'alert' },
    veil: { level: 4, streaks: 1 },
    lookReadout: 'LOOK RIGHT',
    signals: [{ id: 's1', title: 'T', detail: 'D', tone: 'warning' }],
  });
  assert.equal(view.meta.tone, 'normal');
  assert.deepEqual(view.speed, {
    value: 84.4,
    unit: 'km/h',
    tag: 'LIVE',
    tone: 'live',
  });
  assert.equal(view.readouts.length, COCKPIT_SUBJECT_MAX_READOUTS);
  assert.equal(view.readouts[0].tone, 'warning');
  assert.deepEqual(
    view.sources.map(({ id }) => id),
    ['track'],
  );
  assert.deepEqual(view.route, {
    title: 'ROUTE',
    from: 'A',
    to: 'B',
    status: '3 stops',
  });
  assert.equal(view.banner.tone, 'alert');
  assert.deepEqual(view.veil, { level: 1, streaks: false });
  assert.equal(view.lookReadout, 'LOOK RIGHT');
  assert.equal(view.signals[0].tone, 'warning');
  // A veil at 0, a speed below 0 and a route with no ends are absent.
  const absent = cockpitSubjectHudView({
    veil: { level: 0 },
    speed: { value: -3 },
    route: { from: '', to: '' },
  });
  assert.equal(absent.veil, null);
  assert.equal(absent.speed, null);
  assert.equal(absent.route, null);
  // A speed of null is a speed not yet known.
  assert.equal(
    cockpitSubjectHudView({ speed: { value: null } }).speed.value,
    null,
  );
});

test('a progress line keeps ticks in 0..1, sorted and capped, and needs two', () => {
  const read = cockpitSubjectHudView({
    progress: {
      ticks: [
        { at: 1, label: { text: 'End', align: 'end', priority: 1 } },
        { at: 0.5, tone: 'warning' },
        { at: 2 },
        { at: -0.1 },
        { at: 0, label: { text: 'Start', align: 'start', priority: 12 } },
        { at: 0.25, label: { text: '', detail: 'no text, no label' } },
      ],
      marker: { at: 1.4, dwell: true },
      tag: 'TIMETABLE',
      summary: 'From Start to End',
    },
  }).progress;
  assert.deepEqual(
    read.ticks.map(({ at }) => at),
    [0, 0.25, 0.5, 1],
  );
  assert.equal(read.ticks[0].label.priority, 9);
  assert.equal(read.ticks[0].label.align, 'start');
  assert.equal(read.ticks[1].label, null);
  assert.equal(read.ticks[2].tone, 'warning');
  assert.deepEqual(read.marker, { at: 1, dwell: true });
  assert.equal(read.tag, 'TIMETABLE');
  assert.equal(read.summary, 'From Start to End');
  assert.equal(
    cockpitSubjectHudView({ progress: { ticks: [{ at: 0.5 }] } }).progress,
    null,
  );
  const many = cockpitSubjectHudView({
    progress: {
      ticks: Array.from({ length: COCKPIT_SUBJECT_MAX_TICKS + 40 }, (_, i) => ({
        at: i / (COCKPIT_SUBJECT_MAX_TICKS + 40),
      })),
    },
  }).progress;
  assert.equal(many.ticks.length, COCKPIT_SUBJECT_MAX_TICKS);
});

test('texts are trimmed, collapsed and cut with an ellipsis', () => {
  assert.equal(cockpitSubjectText('  a \n  b ', 10), 'a b');
  assert.equal(cockpitSubjectText('abcdef', 4), 'abc…');
  assert.equal(cockpitSubjectText(12.5, 10), '12.5');
  assert.equal(cockpitSubjectText({}, 10), '');
  assert.equal(cockpitSubjectText(NaN, 10), '');
});

test('a cut never splits a surrogate pair', () => {
  // The cut would fall between the emoji's halves: it is left out whole.
  assert.equal(cockpitSubjectText('abcd😀efgh', 6), 'abcd…');
  // One that fits before the cut is kept whole.
  assert.equal(cockpitSubjectText('abc😀efgh', 6), 'abc😀…');
  const lone =
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (let max = 2; max <= 24; max += 1)
    assert.equal(
      lone.test(cockpitSubjectText('🚆 Example 12 🚉 Central', max)),
      false,
      `cut at ${max}`,
    );
});

test('a provider method that throws returns the fallback and warns once', () => {
  const warnings = [];
  const call = createCockpitSubjectCaller({
    warn: (message) => warnings.push(message),
  });
  const failing = {
    kind: 'example-kind',
    read() {
      throw new Error('boom');
    },
    hud: (value) => value * 2,
  };
  assert.equal(call(failing, 'read', [], 'fallback'), 'fallback');
  assert.equal(call(failing, 'read', [], 'fallback'), 'fallback');
  assert.equal(call(failing, 'hud', [21]), 42);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /example-kind read\(\) failed/);
});

test('a provider method that returns a promise is refused as a throw is, warning once', async () => {
  const warnings = [];
  const call = createCockpitSubjectCaller({
    warn: (message) => warnings.push(message),
  });
  const asynchronous = {
    kind: 'example-kind',
    hold: async () => true,
    read: () => Promise.reject(new Error('late')),
  };
  assert.equal(call(asynchronous, 'hold', ['a1'], 'refused'), 'refused');
  assert.equal(call(asynchronous, 'hold', ['a1'], 'refused'), 'refused');
  assert.equal(call(asynchronous, 'read', [], null), null);
  assert.equal(warnings.length, 2, 'once per method');
  assert.match(warnings[0], /hold\(\) returned a promise/);
  // The rejected promise is not left unhandled.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test('an answer whose `then` throws when read is handled as a throw', () => {
  const warnings = [];
  const call = createCockpitSubjectCaller({
    warn: (message) => warnings.push(message),
  });
  const tricky = {
    kind: 'example-kind',
    hold: () => ({
      get then() {
        throw new Error('no then');
      },
    }),
  };
  assert.equal(call(tricky, 'hold', ['a1'], 'refused'), 'refused');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /example-kind hold\(\) failed/);
});

test('the caller’s warnOnce shares its once-per-provider-and-method record', () => {
  const warnings = [];
  const call = createCockpitSubjectCaller({
    warn: (message) => warnings.push(message),
  });
  const ride = {
    kind: 'example-kind',
    hold() {
      throw new Error('boom');
    },
  };
  call.warnOnce(ride, 'read', 'is odd');
  call.warnOnce(ride, 'read', 'is odd again');
  call(ride, 'hold', ['a1']);
  call.warnOnce(ride, 'hold', 'is odd');
  assert.deepEqual(warnings, [
    '[Cockpit] subject provider example-kind read() is odd',
    '[Cockpit] subject provider example-kind hold() failed',
  ]);
});

test('a class-based provider keeps its `this`, in its methods and its worded members', () => {
  class Ride {
    #word = 'RIDE';
    #held = null;
    kind = 'example-kind';
    layerId = 'example-layer';
    speak(word) {
      this.#word = word;
    }
    entryFace() {
      return { icon: 'commute', label: this.#word };
    }
    get labels() {
      return {
        view: `${this.#word} view`,
        exit: 'Exit ride view',
        exitText: 'EXIT RIDE',
      };
    }
    look() {
      return { aheadLabel: `Look ahead, ${this.#word}` };
    }
    candidate() {
      return { id: 'a1', name: this.#word };
    }
    isEntryAllowed(candidate) {
      return candidate.id === 'a1' && this.#held === null;
    }
    hold(id) {
      this.#held = id;
      return true;
    }
    read() {
      return this.#held;
    }
    hud(frame) {
      return { title: `${this.#word} ${frame}` };
    }
    release() {
      this.#held = null;
      return 'released';
    }
  }
  const instance = new Ride();
  const { kept, warnings } = keep([instance]);
  assert.deepEqual(warnings, []);
  const [ride] = kept;
  assert.equal(ride.entryFace.label, 'RIDE');
  assert.equal(ride.labels.view, 'RIDE view');
  assert.equal(ride.look.aheadLabel, 'Look ahead, RIDE');
  instance.speak('FAHRT');
  assert.equal(ride.entryFace.label, 'FAHRT', 'read again, on the instance');
  assert.equal(ride.look.aheadLabel, 'Look ahead, FAHRT');
  // Called on the kept copy, as the Cockpit calls them.
  const failures = [];
  const call = createCockpitSubjectCaller({
    warn: (message) => failures.push(message),
  });
  assert.deepEqual(call(ride, 'candidate'), { id: 'a1', name: 'FAHRT' });
  assert.equal(ride.isEntryAllowed({ id: 'a1' }), true);
  assert.equal(call(ride, 'hold', ['a1']), true);
  assert.equal(ride.isEntryAllowed({ id: 'a1' }), false);
  assert.equal(call(ride, 'read', [0, {}]), 'a1');
  assert.deepEqual(call(ride, 'hud', ['a1', {}]), { title: 'FAHRT a1' });
  assert.equal(call(ride, 'release', ['a1', { restore: true }]), 'released');
  assert.equal(call(ride, 'read', [0, {}]), null);
  assert.deepEqual(failures, []);
});

test('labels, entry face and look given as functions are read again on each use', () => {
  let lang = 'en';
  const words = {
    en: { view: 'Ride view', exit: 'Exit ride view', exitText: 'EXIT RIDE' },
    de: { view: 'Fahrtansicht', exit: 'Verlassen', exitText: 'VERLASSEN' },
  };
  const { kept, warnings } = keep([
    provider({
      labels: () => words[lang],
      entryFace: () => ({
        icon: 'commute',
        label: { en: 'RIDE', de: 'FAHRT' }[lang],
      }),
      look: () => ({
        restPitchDeg: lang === 'de' ? 40 : -3,
        aheadLabel: lang === 'de' ? 'Nach vorn' : 'Look ahead',
      }),
    }),
  ]);
  assert.deepEqual(warnings, []);
  const [ride] = kept;
  assert.equal(ride.labels.exitText, 'EXIT RIDE');
  assert.equal(ride.entryFace.label, 'RIDE');
  assert.equal(ride.look.aheadLabel, 'Look ahead');
  lang = 'de';
  assert.equal(ride.labels.exitText, 'VERLASSEN');
  assert.equal(ride.entryFace.label, 'FAHRT');
  assert.equal(ride.look.aheadLabel, 'Nach vorn');
  assert.equal(ride.look.restPitchDeg, -3, 'the rest pitch is as first read');
  // A read that fails or is malformed keeps the last good one.
  lang = 'xx';
  assert.equal(ride.labels.exitText, 'VERLASSEN');
  assert.equal(ride.entryFace.label, 'FAHRT');
  // Functions that are malformed from the start leave the provider out.
  const bad = keep([
    provider({ kind: 'bad-labels', labels: () => null }),
    provider({
      kind: 'thrown-face',
      entryFace: () => {
        throw new Error('no face');
      },
    }),
  ]);
  assert.deepEqual(bad.kept, []);
  assert.equal(bad.warnings.length, 2);
});

/** `target` with a getter for `key` that throws (provider code runs on a read). */
const throwingGetter = (target, key) =>
  Object.defineProperty(target, key, {
    enumerable: true,
    get() {
      throw new Error(`${key} unavailable`);
    },
  });

test('a provider whose getter throws is left out with one warning; the next is kept', () => {
  const { kept, warnings } = keep([
    throwingGetter(provider({ kind: 'thrown-face' }), 'entryFace'),
    throwingGetter(provider({ kind: 'thrown-labels' }), 'labels'),
    throwingGetter(provider({ kind: 'thrown-look' }), 'look'),
    throwingGetter(provider(), 'kind'),
    throwingGetter(provider({ kind: 'thrown-method' }), 'read'),
    // Read only once the provider is accepted, so its kind must stay free.
    throwingGetter(provider({ kind: 'example-kind' }), 'priority'),
    provider({ kind: 'example-kind' }),
  ]);
  assert.deepEqual(
    kept.map(({ kind }) => kind),
    ['example-kind'],
  );
  assert.deepEqual(warnings, [
    '[Cockpit] subject provider thrown-face left out: malformed entry face',
    '[Cockpit] subject provider thrown-labels left out: labels need view, exit and exitText',
    '[Cockpit] subject provider thrown-look left out: a member threw when read',
    '[Cockpit] subject provider #3 left out: a member threw when read',
    '[Cockpit] subject provider thrown-method left out: a member threw when read',
    '[Cockpit] subject provider example-kind left out: a member threw when read',
  ]);
});

test('a worded getter that starts throwing keeps the last good words', () => {
  let failing = false;
  const words = (value) => () => {
    if (failing) throw new Error('translations unavailable');
    return value;
  };
  const definition = provider();
  for (const [key, value] of Object.entries({
    labels: { view: 'Ride view', exit: 'Exit ride view', exitText: 'EXIT' },
    entryFace: { icon: 'commute', label: 'RIDE' },
    look: { restPitchDeg: 10, aheadLabel: 'Look ahead' },
  }))
    Object.defineProperty(definition, key, { get: words(value) });
  const { kept, warnings } = keep([definition]);
  assert.deepEqual(warnings, []);
  const [ride] = kept;
  failing = true;
  assert.equal(ride.labels.view, 'Ride view');
  assert.equal(ride.entryFace.label, 'RIDE');
  assert.deepEqual(ride.look, { restPitchDeg: 10, aheadLabel: 'Look ahead' });
  // So does a worded object whose own member throws when read.
  failing = false;
  Object.defineProperty(definition, 'labels', {
    get: () => throwingGetter({ view: 'v', exit: 'e', exitText: 'x' }, 'view'),
  });
  assert.equal(ride.labels.view, 'Ride view');
});

test('a candidate, frame or HUD view whose getter throws reads as null', () => {
  assert.equal(
    cockpitSubjectCandidate(throwingGetter({ name: 'Example' }, 'id')),
    null,
  );
  const frame = { id: 'a1', latitude: 1, longitude: 2, eye: { upM: 3 } };
  assert.ok(cockpitSubjectFrame(frame, 'a1'), 'well formed');
  assert.equal(
    cockpitSubjectFrame(throwingGetter({ ...frame }, 'latitude'), 'a1'),
    null,
  );
  assert.equal(
    cockpitSubjectFrame({ ...frame, eye: throwingGetter({}, 'upM') }, 'a1'),
    null,
  );
  assert.equal(
    cockpitSubjectHudView(throwingGetter({ title: 'T' }, 'meta')),
    null,
  );
  assert.equal(
    cockpitSubjectHudView({ title: 'T', readouts: [throwingGetter({}, 'id')] }),
    null,
  );
  // Nothing to read is still the empty view, never null.
  assert.equal(cockpitSubjectHudView(null).title, '');
});
