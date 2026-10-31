// Sky view "Next passes". ISS passes are checked
// against an independent Skyfield reference (reference/build_pass_reference.py
// + passReference.json, versions inside); the rest are the panel rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { observerSolarElevation } from '../data/satellitePass.js';
import { createSatEngine, ISS_NORAD, makeObserver } from './satCore.js';
import {
  createPassScan,
  isPassCandidate,
  mergeDockedPasses,
  nextPassOf,
  observerDistanceKm,
  passArc,
  passCacheValid,
  passCoverage,
  passesForEntry,
  passScanStart,
  passReachable,
  PASS_MIN_ELEV_DEG,
  RESCAN_AFTER_MS,
  revsPerDay,
  upcomingPasses,
} from './passes.js';
import { createSatWorkerHandler } from './satWorker.js';
import {
  ENTRIES,
  entryOf,
  renumber,
  tle,
} from '../testSupport/skyTleFixture.mjs';

const REF = JSON.parse(
  readFileSync(
    new URL('./reference/passReference.json', import.meta.url),
    'utf8',
  ),
);
const tleText = tle;
const ISS_ROW = entryOf(ISS_NORAD);
/** The ISS elements renamed/renumbered: a "docked module" twin. */
const NAUKA_ROW = renumber(ISS_ROW, 49044, 'ISS (NAUKA)');

function engineWith(groups, rcs = null) {
  const engine = createSatEngine();
  for (const [path, text] of groups) engine.loadGroup(path, text);
  if (rcs) engine.setRcs(rcs);
  return engine;
}

const start = Date.parse(REF.start);

test('reference provenance: Skyfield script, versions and the fixture ISS epoch are committed', () => {
  assert.equal(REF.generatedBy, 'build_pass_reference.py');
  assert.match(REF.versions.skyfield, /^\d+\.\d+/);
  assert.match(REF.versions.sgp4, /^\d+\.\d+/);
  assert.equal(REF.noradId, ISS_NORAD);
  assert.ok(
    Math.abs(ISS_ROW.epochMs - Date.parse(`${REF.epoch}Z`)) < 10,
    'same element set as the fixture',
  );
  assert.deepEqual(
    REF.sites.map((s) => s.latDeg),
    [0, 30, 60],
  );
  for (const site of REF.sites) assert.equal(site.passes.length, 5);
  assert.ok(
    readFileSync(
      new URL('./reference/build_pass_reference.py', import.meta.url),
      'utf8',
    ).includes('find_events'),
  );
});

test('ISS passes vs Skyfield at 0/30/60 N: rise/set within 10 s, peak elevation within 0.5 deg, none missed or extra', () => {
  const engine = engineWith([['stations', tleText(ISS_ROW)]]);
  const iss = engine.byNorad(ISS_NORAD);
  let worst = { rise: 0, set: 0, peak: 0 };
  for (const site of REF.sites) {
    const observer = makeObserver(site.latDeg, site.lonDeg);
    const ours = passesForEntry(iss, observer, start);
    const lastSet = Date.parse(site.passes.at(-1).setIso);
    const inRange = ours.filter((p) => p.riseMs < lastSet);
    assert.equal(inRange.length, 5, `lat ${site.latDeg}: same pass count`);
    site.passes.forEach((ref, k) => {
      const p = inRange[k];
      const dRise = Math.abs(p.riseMs - Date.parse(ref.riseIso)) / 1000;
      const dSet = Math.abs(p.setMs - Date.parse(ref.setIso)) / 1000;
      const dPeak = Math.abs(p.peakElevDeg - ref.peakElevDeg);
      worst = {
        rise: Math.max(worst.rise, dRise),
        set: Math.max(worst.set, dSet),
        peak: Math.max(worst.peak, dPeak),
      };
      assert.ok(
        dRise <= 10,
        `lat ${site.latDeg} pass ${k} rise off ${dRise} s`,
      );
      assert.ok(dSet <= 10, `lat ${site.latDeg} pass ${k} set off ${dSet} s`);
      assert.ok(
        dPeak <= 0.5,
        `lat ${site.latDeg} pass ${k} peak off ${dPeak} deg`,
      );
    });
  }
  // measured 2026-10-12: worst rise/set about 1 s, peak about 0.01 deg
  assert.ok(
    worst.rise < 10 && worst.set < 10 && worst.peak < 0.5,
    JSON.stringify(worst),
  );
});

test('VISIBLE is false for every reference pass wholly in daylight (Sun above -6 deg throughout)', () => {
  const engine = engineWith([['stations', tleText(ISS_ROW)]]);
  const iss = engine.byNorad(ISS_NORAD);
  let daylight = 0;
  for (const site of REF.sites) {
    const observer = makeObserver(site.latDeg, site.lonDeg);
    const ours = passesForEntry(iss, observer, start);
    for (const ref of site.passes) {
      const p = ours.find(
        (q) => Math.abs(q.riseMs - Date.parse(ref.riseIso)) < 30_000,
      );
      assert.ok(p, `pass ${ref.riseIso} found`);
      if (ref.minSunAltDeg > -6) {
        daylight += 1;
        assert.equal(
          p.visible,
          false,
          `${site.latDeg} ${ref.riseIso} daylight`,
        );
        assert.equal(p.estMag === null || p.visible === false, true);
      }
      if (!ref.anySunlit) assert.equal(p.visible, false, 'never sunlit');
    }
  }
  assert.ok(daylight >= 8, `fixture has ${daylight} daylight passes`);
});

test('scan over stations + visual: no pass below minElev, daylight passes never VISIBLE, sorted, merged twins', () => {
  // 25 fixture objects as the "visual" group plus the ISS and a docked twin.
  const visual = ENTRIES.filter((e) => e.norad !== ISS_NORAD).slice(0, 25);
  const engine = engineWith([
    ['stations', tleText(ISS_ROW, NAUKA_ROW)],
    ['visual', tleText(...visual)],
  ]);
  const observer = makeObserver(29.7604, -95.3698);
  const scan = createPassScan({
    entries: engine.entries,
    observer,
    fromMs: start,
  });
  assert.equal(scan.candidates + 0 >= scan.total, true);
  const firstRows = scan.step();
  assert.ok(
    firstRows.every((p) => p.noradId === ISS_NORAD),
    'ISS is scanned first',
  );
  while (!scan.done) scan.step();
  const passes = scan.passes();
  assert.ok(passes.length > 20, `${passes.length} passes`);
  for (const p of passes) {
    assert.ok(
      p.peakElevDeg >= PASS_MIN_ELEV_DEG,
      `${p.name} peak ${p.peakElevDeg}`,
    );
    assert.ok(
      p.riseMs < p.setMs && p.riseMs <= p.peakMs && p.peakMs <= p.setMs,
    );
    // wholly in daylight (Sun above -6 at every 10 s arc sample) => not VISIBLE
    const entry = engine.byNorad(p.noradId);
    const arc = passArc(entry, observer, p.riseMs, p.setMs);
    if (
      arc.every(
        (s) =>
          observerSolarElevation(observer.latDeg, observer.lonDeg, s.timeMs) >
          -6,
      )
    )
      assert.equal(
        p.visible,
        false,
        `${p.name} ${new Date(p.riseMs).toISOString()}`,
      );
  }
  for (let i = 1; i < passes.length; i++)
    assert.ok(passes[i - 1].riseMs <= passes[i].riseMs, 'sorted by start time');
  const issPasses = passes.filter((p) => p.noradId === ISS_NORAD);
  assert.ok(issPasses.length > 0);
  assert.ok(
    issPasses.every(
      (p) => p.alsoNames.includes('ISS (NAUKA)') && p.alsoIds.includes(49044),
    ),
    'docked twin merged into the ISS row',
  );
  assert.ok(!passes.some((p) => p.noradId === 49044));
});

test('prefilter rejects only orbits that cannot pass, and never loses a pass', () => {
  const engine = engineWith([['stations', tleText(ISS_ROW)]]);
  const iss = engine.byNorad(ISS_NORAD).satrec;
  assert.equal(passReachable(iss, 0), true);
  assert.equal(passReachable(iss, 60), true);
  assert.equal(passReachable(iss, -60), true);
  assert.equal(passReachable(iss, 78), false, '51.6 deg orbit at 78 N');
  assert.equal(passReachable(iss, -80), false);
  // a 75 N observer: the prefiltered scan must equal the full one
  const visual = ENTRIES.slice(0, 40);
  const eng = engineWith([['visual', tleText(...visual)]]);
  const observer = makeObserver(75, 20);
  const fromMs = start;
  const scan = createPassScan({
    entries: eng.entries,
    observer,
    fromMs,
    hours: 12,
  });
  while (!scan.done) scan.step();
  assert.ok(scan.prefiltered > 0, 'some orbits were skipped');
  const full = [];
  for (const e of eng.entries.filter(isPassCandidate))
    full.push(...passesForEntry(e, observer, fromMs, { hours: 12 }));
  assert.deepEqual(
    scan
      .passes()
      .map((p) => `${p.noradId}@${p.riseMs}`)
      .sort(),
    mergeDockedPasses(full)
      .map((p) => `${p.noradId}@${p.riseMs}`)
      .sort(),
  );
});

test('GEO-like objects are not scanned (no passes), non stations/visual groups are not scanned', () => {
  const geoRow = ENTRIES.find((e) => e.meanMotion < 1.1);
  assert.ok(geoRow, 'fixture has a GEO object');
  const engine = engineWith([
    ['visual', tleText(geoRow)],
    ['gps-ops', tleText(renumber(ISS_ROW, 99901))],
  ]);
  for (const e of engine.entries) {
    if (e.group === 'visual') assert.ok(revsPerDay(e.satrec) < 1.5);
    assert.equal(isPassCandidate(e), false, e.name);
  }
});

test('cache rule: valid until the data key changes, the observer moves > 50 km, or Sky time leaves the first 24 h', () => {
  const observer = makeObserver(29.76, -95.37);
  const cache = { key: '3:1', observer, fromMs: start };
  const t = start + 3600_000;
  assert.equal(
    passCacheValid(cache, { key: '3:1', observer, timeMs: t }),
    true,
  );
  assert.equal(
    passCacheValid(cache, { key: '4:1', observer, timeMs: t }),
    false,
    'TLE refresh',
  );
  assert.equal(
    passCacheValid(cache, { key: '3:2', observer, timeMs: t }),
    false,
    'new RCS',
  );
  const near = makeObserver(29.76 + 0.4, -95.37); // ~44 km
  const far = makeObserver(29.76 + 0.5, -95.37); // ~56 km
  assert.ok(Math.abs(observerDistanceKm(observer, near) - 44.5) < 1);
  assert.equal(
    passCacheValid(cache, { key: '3:1', observer: near, timeMs: t }),
    true,
  );
  assert.equal(
    passCacheValid(cache, { key: '3:1', observer: far, timeMs: t }),
    false,
  );
  assert.equal(
    passCacheValid(cache, {
      key: '3:1',
      observer,
      timeMs: start + RESCAN_AFTER_MS + 1,
    }),
    false,
  );
  assert.equal(
    passCacheValid(cache, { key: '3:1', observer, timeMs: start - 1 }),
    false,
  );
  assert.equal(
    passCacheValid(null, { key: '3:1', observer, timeMs: t }),
    false,
  );
});

test('upcomingPasses / nextPassOf: soonest first, over passes dropped, VISIBLE filter, twin ids', () => {
  const mk = (noradId, riseMs, visible, extra = {}) => ({
    noradId,
    riseMs,
    setMs: riseMs + 300_000,
    visible,
    alsoIds: [],
    ...extra,
  });
  const list = [
    mk(1, 5_000_000, true),
    mk(ISS_NORAD, 2_000_000, false),
    mk(ISS_NORAD, 9_000_000, true, { alsoIds: [49044] }),
    mk(2, 1_000_000, true),
  ];
  const now = 1_400_000; // pass 2 already over (set 1.3e6)
  assert.deepEqual(
    upcomingPasses(list, now).map((p) => p.riseMs),
    [5_000_000, 9_000_000],
  );
  assert.deepEqual(
    upcomingPasses(list, now, { visibleOnly: false }).map((p) => p.riseMs),
    [2_000_000, 5_000_000, 9_000_000],
  );
  assert.equal(nextPassOf(list, ISS_NORAD, now).riseMs, 2_000_000);
  assert.equal(
    nextPassOf(list, ISS_NORAD, now, { visibleOnly: true }).riseMs,
    9_000_000,
  );
  assert.equal(
    nextPassOf(list, 49044, now).riseMs,
    9_000_000,
    'docked module id',
  );
  assert.equal(nextPassOf(list, 777, now), null);
});

test('worker: progressive pass messages between ticks, ISS first, cached answer, rescan on a 60 km move', () => {
  const out = [];
  const queue = [];
  let clock = 0;
  const handle = createSatWorkerHandler((m) => out.push(m), {
    schedule: (fn) => queue.push(fn),
    clock: () => (clock += 10), // every step "takes" 10 ms
    sliceMs: 1,
  });
  const visual = ENTRIES.filter((e) => e.norad !== ISS_NORAD).slice(0, 6);
  handle({ type: 'tle', path: 'stations', text: tleText(ISS_ROW) });
  handle({ type: 'tle', path: 'visual', text: tleText(...visual) });
  handle({ type: 'observer', latDeg: 29.7604, lonDeg: -95.3698 });
  out.length = 0;
  handle({ type: 'passes', timeMs: start });
  const first = out.shift();
  assert.equal(first.type, 'passes');
  assert.equal(first.done, false, 'progressive: not all at once');
  assert.equal(first.processed, 1);
  assert.ok(
    first.added.length > 0 && first.added.every((p) => p.noradId === ISS_NORAD),
  );
  // a tick is answered while the scan is still running
  handle({ type: 'tick', seq: 1, timeMs: start, sets: ['core'] });
  assert.equal(out.shift().type, 'tick');
  let last = first;
  let added = first.added.length;
  while (queue.length) {
    queue.shift()();
    last = out.at(-1);
    added += last.added.length;
  }
  assert.equal(last.done, true);
  assert.equal(last.processed, last.total);
  assert.equal(last.passes.length, added, 'no docked twins here: merged = all');
  const scanId = last.scanId;
  // same request: cached answer, no new scan
  out.length = 0;
  handle({ type: 'passes', timeMs: start + 3600_000 });
  assert.equal(out.length, 1);
  assert.equal(out[0].cached, true);
  assert.equal(out[0].scanId, scanId);
  assert.equal(queue.length, 0);
  // observer moves 30 km: still cached; 60 km: a new scan
  handle({ type: 'observer', latDeg: 29.7604 + 0.27, lonDeg: -95.3698 });
  out.length = 0;
  handle({ type: 'passes', timeMs: start });
  assert.equal(out.at(-1).scanId, scanId);
  handle({ type: 'observer', latDeg: 29.7604 + 0.54, lonDeg: -95.3698 });
  out.length = 0;
  handle({ type: 'passes', timeMs: start });
  assert.ok(out.at(-1).scanId > scanId, 'rescanned');
  // new TLE sets in a scanned group invalidate too
  while (queue.length) queue.shift()();
  const id2 = out.at(-1).scanId;
  handle({ type: 'tle', path: 'visual', text: tleText(ENTRIES[39]) });
  out.length = 0;
  handle({ type: 'passes', timeMs: start });
  assert.ok(out.at(-1).scanId > id2, 'TLE refresh => rescan');
});

test('worker: pass arc samples every 10 s from rise to set; unknown object -> empty arc', () => {
  const out = [];
  const handle = createSatWorkerHandler((m) => out.push(m), {
    schedule: () => {},
  });
  handle({ type: 'tle', path: 'stations', text: tleText(ISS_ROW) });
  handle({ type: 'observer', latDeg: 30, lonDeg: -95.37 });
  const ref = REF.sites[1].passes[0];
  const riseMs = Date.parse(ref.riseIso);
  const setMs = Date.parse(ref.setIso);
  handle({ type: 'passArc', requestId: 7, noradId: ISS_NORAD, riseMs, setMs });
  const msg = out.at(-1);
  assert.equal(msg.type, 'passArc');
  assert.equal(msg.requestId, 7);
  assert.equal(msg.arc.length, Math.ceil((setMs - riseMs) / 10_000) + 1);
  assert.equal(msg.arc[0][3], riseMs);
  assert.equal(msg.arc.at(-1)[3], setMs);
  assert.ok(Math.abs(msg.arc[0][1] - 10) < 0.2, 'starts at minElev');
  const top = Math.max(...msg.arc.map((s) => s[1]));
  assert.ok(Math.abs(top - ref.peakElevDeg) < 0.5);
  handle({ type: 'passArc', requestId: 8, noradId: 1, riseMs, setMs });
  assert.deepEqual(out.at(-1).arc, []);
});

test('reverse play: scan windows anchor 24 h back; coverage gap/short/ok', () => {
  assert.equal(passScanStart(start), start);
  assert.equal(
    passScanStart(start, { backward: true }),
    start - RESCAN_AFTER_MS,
  );
  const cache = {
    key: '1:1',
    observer: makeObserver(29.76, -95.37),
    fromMs: passScanStart(start, { backward: true }),
  };
  // the request time and the next 24 h of reverse play are inside the rule
  for (const t of [start, start - 12 * 3600_000, start - RESCAN_AFTER_MS])
    assert.equal(
      passCacheValid(cache, {
        key: '1:1',
        observer: cache.observer,
        timeMs: t,
      }),
      true,
    );
  assert.equal(passCoverage(null, start), 'none');
  assert.equal(passCoverage(start, start - 1), 'gap');
  assert.equal(passCoverage(start, start), 'ok');
  assert.equal(passCoverage(start, start + RESCAN_AFTER_MS), 'ok');
  assert.equal(passCoverage(start, start + RESCAN_AFTER_MS + 1), 'short');
});

test('worker: playback (defer) requests never cancel a running scan; the newest runs after it; jumps, TLE and observer changes still replace at once', () => {
  const out = [];
  const queue = [];
  let clock = 0;
  const handle = createSatWorkerHandler((m) => out.push(m), {
    schedule: (fn) => queue.push(fn),
    clock: () => (clock += 10),
    sliceMs: 1,
  });
  const visual = ENTRIES.filter((e) => e.norad !== ISS_NORAD).slice(0, 6);
  handle({ type: 'tle', path: 'stations', text: tleText(ISS_ROW) });
  handle({ type: 'tle', path: 'visual', text: tleText(...visual) });
  handle({ type: 'observer', latDeg: 29.7604, lonDeg: -95.3698 });
  const passMsgs = () => out.filter((m) => m.type === 'passes');
  const ids = () => [...new Set(passMsgs().map((m) => m.scanId))];
  handle({ type: 'passes', timeMs: start });
  const first = passMsgs()[0].scanId;
  assert.equal(passMsgs()[0].done, false);
  // eight reverse playback requests while it runs: no new scan
  let t = start;
  for (let i = 0; i < 8; i++) {
    t -= 900_000;
    handle({ type: 'passes', timeMs: t, defer: true, backward: true });
  }
  assert.deepEqual(ids(), [first], 'still the one scan');
  while (queue.length) queue.shift()();
  const firstDone = passMsgs().find((m) => m.scanId === first && m.done);
  assert.ok(firstDone, 'the running scan completed');
  assert.equal(firstDone.processed, firstDone.total);
  // ...then exactly one scan for the NEWEST deferred request, 24 h back
  assert.equal(ids().length, 2);
  const second = ids()[1];
  const secondDone = passMsgs().find((m) => m.scanId === second && m.done);
  assert.ok(secondDone, 'deferred scan completed');
  assert.equal(secondDone.fromMs, t - RESCAN_AFTER_MS);
  assert.ok(
    secondDone.passes.every((p) => p.setMs > secondDone.fromMs),
    'window from the anchored start',
  );
  // a request back inside the window drops a pending one
  handle({ type: 'passes', timeMs: start + 30 * 3600_000 }); // jump: replace
  const third = ids()[2];
  assert.ok(third > second);
  handle({ type: 'passes', timeMs: start - 72 * 3600_000, defer: true });
  handle({ type: 'passes', timeMs: start + 31 * 3600_000, defer: true }); // inside
  while (queue.length) queue.shift()();
  assert.equal(ids().length, 3, 'pending dropped: back inside the window');
  // jump (no defer) while running: replaced at once (unchanged)
  handle({ type: 'passes', timeMs: start - 100 * 3600_000 });
  const fourth = ids()[3];
  assert.ok(queue.length > 0, 'running');
  handle({ type: 'passes', timeMs: start + 200 * 3600_000 });
  assert.ok(ids()[4] > fourth, 'jump replaced the running scan');
  // defer, but the TLE data changed: replaced at once (invalidation)
  const fifth = ids()[4];
  handle({ type: 'tle', path: 'visual', text: tleText(ENTRIES[39]) });
  handle({ type: 'passes', timeMs: start + 300 * 3600_000, defer: true });
  assert.ok(ids()[5] > fifth, 'TLE refresh beats defer');
  // defer, but the observer moved 60 km: replaced at once
  const sixth = ids()[5];
  handle({ type: 'observer', latDeg: 29.7604 + 0.54, lonDeg: -95.3698 });
  handle({ type: 'passes', timeMs: start + 400 * 3600_000, defer: true });
  assert.ok(ids()[6] > sixth, 'observer move beats defer');
  // no scan id ever reported done before all its objects were scanned
  for (const m of passMsgs())
    if (m.done) assert.equal(m.processed, m.total, `scan ${m.scanId}`);
  while (queue.length) queue.shift()();
});
