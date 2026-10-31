import test from 'node:test';
import assert from 'node:assert/strict';
import { createSkyVoice, parseSkyTime, SKY_PRESET_IDS } from './skyVoice.js';

const NOW = Date.parse('2026-10-26T02:00:00Z');

function fakeSky(overrides = {}) {
  const calls = [];
  const state = {
    active: false,
    destroyed: false,
    lines: true,
    timeMs: NOW,
    mode: 'live',
    provider: 'builtin',
    marker: null,
    observer: { latDeg: 32.7, lonDeg: -94.9 },
    satStatus: 'ready',
    contentStatus: 'ready',
    openResult: { ok: true },
    lookAt: { azDeg: 180, elDeg: 40 },
    presetResult: { ok: true, timeMs: Date.parse('2026-10-26T23:41:00Z') },
    setTimeResult: true,
    goLiveResult: true,
    search: () => [],
    ...overrides,
  };
  const sky = {
    get destroyed() {
      return state.destroyed;
    },
    get active() {
      return state.active;
    },
    get observer() {
      return state.observer;
    },
    get clock() {
      return { mode: state.mode, getTime: () => state.timeMs };
    },
    get time() {
      return {
        provider: state.provider,
        getTime: () => state.timeMs,
      };
    },
    get satellites() {
      return { status: state.satStatus };
    },
    content: {
      get status() {
        return state.contentStatus;
      },
      get flags() {
        return { lines: state.lines };
      },
      get marker() {
        return state.marker;
      },
      ensureData: async () => {
        calls.push(['ensureData']);
      },
      search(query) {
        calls.push(['search', query]);
        return state.search(query);
      },
      lookAt(result) {
        calls.push(['lookAt', result.label]);
        if (state.lookAt == null) return null;
        state.marker = { label: result.label };
        return state.lookAt;
      },
      setFlags(next, options) {
        calls.push(['setFlags', next, options]);
        if ('lines' in next) state.lines = next.lines;
      },
    },
    async openHere() {
      calls.push(['openHere']);
      if (!state.openResult.ok) return state.openResult;
      state.active = true;
      return state.openResult;
    },
    exit() {
      calls.push(['exit']);
      state.active = false;
      state.marker = null;
    },
    setTime(ms) {
      calls.push(['setTime', ms]);
      if (state.setTimeResult === false) return false;
      state.timeMs = ms;
      state.mode = 'fixed';
      return true;
    },
    goLive() {
      calls.push(['goLive']);
      if (state.goLiveResult === false) return false;
      state.mode = 'live';
      state.timeMs = NOW;
      return true;
    },
    async applyPreset(id) {
      calls.push(['preset', id]);
      if (state.presetResult?.ok && Number.isFinite(state.presetResult.timeMs))
        state.timeMs = state.presetResult.timeMs;
      return state.presetResult;
    },
  };
  return { sky, calls, state };
}

function voiceFor(overrides = {}) {
  const fake = fakeSky(overrides);
  return {
    ...fake,
    voice: createSkyVoice({
      getHandle: () => fake.sky,
      satelliteWaitMs: overrides.satelliteWaitMs ?? 0,
    }),
  };
}

const hit = (label, kind, score = 0) => ({
  label,
  kind,
  score,
  target: { type: kind, name: label },
});

test('parseSkyTime: ISO with a zone, a bare date is UTC, a zoneless time is refused', () => {
  assert.equal(
    parseSkyTime('2026-03-04T02:00:00Z').ms,
    Date.parse('2026-03-04T02:00:00Z'),
  );
  assert.equal(
    parseSkyTime('2026-03-04T20:00:00-06:00').ms,
    Date.parse('2026-03-05T02:00:00Z'),
  );
  assert.equal(
    parseSkyTime('2026-03-04').ms,
    Date.parse('2026-03-04T00:00:00Z'),
  );
  assert.match(parseSkyTime('2026-03-04T20:00:00').error, /zone/);
  assert.match(parseSkyTime('two in the morning').error, /ISO 8601/);
  assert.match(parseSkyTime('').error, /ISO 8601/);
  assert.match(parseSkyTime(42).error, /ISO 8601/);
  assert.match(parseSkyTime('2026-13-45T00:00:00Z').error, /not a valid date/);
});

test('status: closed to begin with, then reports lines, time and where you stand', () => {
  const h = voiceFor();
  const s = h.voice.status();
  assert.equal(s.ok, true);
  assert.equal(s.open, false);
  assert.equal(s.lines, true);
  assert.equal(s.timeMode, 'live');
  assert.equal(s.lookingAt, null);
  assert.equal(s.latitude, 32.7);
  assert.equal(s.longitude, -94.9);
});

test('open stands at the map centre; a second open does not open again', async () => {
  const h = voiceFor();
  const a = await h.voice.open();
  assert.equal(a.ok, true);
  assert.equal(a.open, true);
  assert.equal(a.opened, true);
  assert.deepEqual(
    h.calls.filter((c) => c[0] === 'openHere'),
    [['openHere']],
  );
  const b = await h.voice.open();
  assert.equal(b.ok, true);
  assert.equal(b.opened, false);
  assert.equal(h.calls.filter((c) => c[0] === 'openHere').length, 1);
});

test('open reports a fixed reason when the map centre has no ground', async () => {
  const h = voiceFor({
    openResult: {
      ok: false,
      error: 'No ground at the screen centre. Move the map onto land first.',
    },
  });
  const r = await h.voice.open();
  assert.equal(r.ok, false);
  assert.match(r.error, /screen centre/);
  assert.equal(h.state.active, false);
});

test('close leaves the sky; closing a closed sky does not call exit', () => {
  const h = voiceFor();
  const closed = h.voice.close();
  assert.equal(closed.ok, true);
  assert.equal(closed.open, false);
  assert.equal(
    h.calls.some((c) => c[0] === 'exit'),
    false,
  );
  h.state.active = true;
  const left = h.voice.close();
  assert.equal(left.open, false);
  assert.deepEqual(
    h.calls.filter((c) => c[0] === 'exit'),
    [['exit']],
  );
});

test('look opens the sky, then looks at an exact planet', async () => {
  const h = voiceFor({
    search: (query) => (query === 'Jupiter' ? [hit('Jupiter', 'body')] : []),
  });
  const r = await h.voice.look('Jupiter');
  assert.equal(r.ok, true);
  assert.equal(r.opened, true);
  assert.equal(r.open, true);
  assert.equal(r.target, 'Jupiter');
  assert.equal(r.kind, 'body');
  assert.equal(r.azimuthDeg, 180);
  assert.equal(r.elevationDeg, 40);
  assert.equal(r.belowHorizon, false);
  assert.equal(r.lookingAt, 'Jupiter');
  assert.deepEqual(h.calls[0], ['openHere']);
  assert.ok(h.calls.some((c) => c[0] === 'lookAt' && c[1] === 'Jupiter'));
});

test('look treats ISS, the ISS and the space station as ISS (ZARYA)', async () => {
  const h = voiceFor({
    search: (query) =>
      query === 'ISS (ZARYA)' ? [hit('ISS (ZARYA)', 'satellite', 0)] : [],
  });
  for (const name of [
    'ISS',
    'the ISS',
    'international space station',
    'the space station',
    'the international space station',
  ]) {
    h.calls.length = 0;
    h.state.active = true;
    const r = await h.voice.look(name);
    assert.equal(r.ok, true, name);
    assert.equal(r.target, 'ISS (ZARYA)');
    assert.ok(h.calls.some((c) => c[0] === 'search' && c[1] === 'ISS (ZARYA)'));
  }
});

test('look refuses a tie, a weak substring, and a missing name, and does not move', async () => {
  const h = voiceFor({
    search: (query) => {
      if (query === 'Orion')
        return [hit('Orion', 'star'), hit('Orion', 'star')];
      if (query === 'Meissa') return [hit('Meissa', 'star', 3)];
      return [];
    },
  });
  h.state.active = true;
  const tie = await h.voice.look('Orion');
  assert.equal(tie.ok, false);
  assert.deepEqual(tie.candidates, ['Orion', 'Orion']);
  assert.equal(
    h.calls.some((c) => c[0] === 'lookAt'),
    false,
  );
  const weak = await h.voice.look('Meissa');
  assert.equal(weak.ok, false);
  assert.match(weak.error, /Nothing matched/);
  assert.equal(
    h.calls.some((c) => c[0] === 'lookAt'),
    false,
  );
  const empty = await h.voice.look('   ');
  assert.equal(empty.ok, false);
  assert.match(empty.error, /needs the name/);
});

test('look says satellites are loading instead of inventing an ISS', async () => {
  const h = voiceFor({ satStatus: 'loading', search: () => [] });
  h.state.active = true;
  const r = await h.voice.look('ISS');
  assert.equal(r.ok, false);
  assert.equal(r.satellites, 'loading');
  assert.equal(
    h.calls.some((c) => c[0] === 'lookAt'),
    false,
  );
});

test('look below the horizon is still a look, and says so', async () => {
  const h = voiceFor({
    lookAt: { azDeg: 12, elDeg: -8.2 },
    search: () => [hit('Saturn', 'body')],
  });
  h.state.active = true;
  const r = await h.voice.look('Saturn');
  assert.equal(r.ok, true);
  assert.equal(r.belowHorizon, true);
  assert.equal(r.elevationDeg, -8.2);
});

test('look with no position does not claim it looked', async () => {
  const h = voiceFor({
    lookAt: null,
    search: () => [hit('Mars', 'body')],
  });
  h.state.active = true;
  const r = await h.voice.look('Mars');
  assert.equal(r.ok, false);
  assert.match(r.error, /No position/);
  assert.equal(r.lookingAt, undefined);
});

test('time sets an ISO time, live returns to now, and a zoneless time changes nothing', async () => {
  const h = voiceFor();
  h.state.active = true;
  const set = await h.voice.time({ time: '2026-10-26T04:30:00Z' });
  assert.equal(set.ok, true);
  assert.equal(set.time, '2026-10-26T04:30:00.000Z');
  assert.equal(h.state.mode, 'fixed');
  const back = await h.voice.time({ live: true });
  assert.equal(back.ok, true);
  assert.equal(back.live, true);
  assert.equal(h.state.mode, 'live');
  const bad = await h.voice.time({ time: '2026-10-26T04:30:00' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /zone/);
  assert.equal(h.calls.filter((c) => c[0] === 'setTime').length, 1);
});

test('time reports a clamp outside the sky range and never echoes the text', async () => {
  const h = voiceFor();
  h.state.active = true;
  const future = await h.voice.time({ time: '2500-01-01T00:00:00Z' });
  assert.equal(future.ok, true);
  assert.equal(future.clamped, 'future');
  const past = await h.voice.time({ time: '1600-01-01T00:00:00Z' });
  assert.equal(past.clamped, 'past');
});

test('lines turns constellation lines on and off, and refuses a non-boolean', async () => {
  const h = voiceFor();
  h.state.active = true;
  const off = await h.voice.lines(false);
  assert.equal(off.ok, true);
  assert.equal(off.lines, false);
  assert.deepEqual(h.calls.find((c) => c[0] === 'setFlags')[1], {
    lines: false,
  });
  assert.equal(h.calls.find((c) => c[0] === 'setFlags')[2].notify, true);
  const on = await h.voice.lines(true);
  assert.equal(on.lines, true);
  const bad = await h.voice.lines('false');
  assert.equal(bad.ok, false);
  assert.equal(h.state.lines, true, 'a string does not flip the lines');
});

test('preset jumps to a known preset and refuses an unknown one', async () => {
  const h = voiceFor();
  h.state.active = true;
  assert.deepEqual(h.voice.presetIds(), [...SKY_PRESET_IDS]);
  const r = await h.voice.preset('Sunset');
  assert.equal(r.ok, true);
  assert.equal(r.preset, 'sunset');
  assert.equal(r.time, '2026-10-26T23:41:00.000Z');
  const bad = await h.voice.preset('noon');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /sunset, dusk, midnight, moonrise, iss/);
  assert.equal(h.calls.filter((c) => c[0] === 'preset').length, 1);
});

test('a preset that is not found does not claim the time moved', async () => {
  const h = voiceFor({
    presetResult: {
      ok: false,
      reason: 'The Sun does not set here in the next 2 days.',
    },
  });
  h.state.active = true;
  const r = await h.voice.preset('sunset');
  assert.equal(r.ok, false);
  assert.match(r.error, /does not set/);
});

test('look, time, lines and preset do not run when open fails', async () => {
  const h = voiceFor({
    openResult: { ok: false, error: 'Sky view is not available in this mode.' },
  });
  for (const call of [
    () => h.voice.look('Mars'),
    () => h.voice.time({ time: '2026-10-26T04:00:00Z' }),
    () => h.voice.lines(false),
    () => h.voice.preset('midnight'),
  ]) {
    const r = await call();
    assert.equal(r.ok, false);
    assert.match(r.error, /not available in this mode/);
  }
  assert.equal(
    h.calls.some((c) => c[0] === 'lookAt'),
    false,
  );
  assert.equal(
    h.calls.some((c) => c[0] === 'setTime'),
    false,
  );
  assert.equal(
    h.calls.some((c) => c[0] === 'setFlags'),
    false,
  );
  assert.equal(
    h.calls.some((c) => c[0] === 'preset'),
    false,
  );
});

test('a destroyed or missing sky answers unavailable, never throws', async () => {
  const h = voiceFor();
  h.state.destroyed = true;
  for (const call of [
    () => h.voice.status(),
    () => h.voice.open(),
    () => h.voice.close(),
    () => h.voice.look('Mars'),
    () => h.voice.time({ live: true }),
    () => h.voice.lines(true),
    () => h.voice.preset('dusk'),
  ]) {
    const r = await call();
    assert.equal(r.ok, false);
    assert.match(r.error, /not available/);
  }
  const none = createSkyVoice({ getHandle: () => null });
  assert.equal(none.status().ok, false);
  assert.deepEqual(none.presetIds(), [...SKY_PRESET_IDS]);
});

test('a refused look or time never echoes the text it was given', async () => {
  const h = voiceFor({ search: () => [] });
  h.state.active = true;
  const secret = 'https://user:pass@host/?api_key=SECRETKEY123';
  for (const call of [
    () => h.voice.look(secret),
    () => h.voice.look('Bearer abcdef-SECRETKEY123'),
    () => h.voice.time({ time: `${secret}` }),
    () => h.voice.time({ time: 'yesterday SECRETKEY123' }),
  ]) {
    const r = await call();
    assert.equal(r.ok, false);
    assert.ok(!JSON.stringify(r).includes('SECRETKEY123'), JSON.stringify(r));
    assert.ok(!JSON.stringify(r).includes('pass@host'));
  }
});

test('parseSkyTime refuses a space between the date and the time', () => {
  assert.match(parseSkyTime('2026-03-04 02:00:00Z').error, /ISO 8601/);
});

test('look still finds the ISS when star data fails to load', async () => {
  const h = voiceFor({
    search: (query) =>
      query === 'ISS (ZARYA)' ? [hit('ISS (ZARYA)', 'satellite')] : [],
  });
  h.sky.content.ensureData = async () => {
    throw new Error('catalogue down');
  };
  h.state.active = true;
  const r = await h.voice.look('ISS');
  assert.equal(r.ok, true);
  assert.equal(r.target, 'ISS (ZARYA)');
});

test('look prefers a planet over a same-score satellite, and asks when one kind ties', async () => {
  const h = voiceFor({
    search: (query) => {
      if (query === 'Venus')
        return [hit('Venus', 'body'), hit('VENUS', 'satellite')];
      if (query === 'Vega') return [hit('Vega', 'star'), hit('Vega', 'star')];
      return [];
    },
  });
  h.state.active = true;
  const planet = await h.voice.look('Venus');
  assert.equal(planet.ok, true);
  assert.equal(planet.kind, 'body');
  assert.equal(planet.target, 'Venus');
  const tie = await h.voice.look('Vega');
  assert.equal(tie.ok, false);
  assert.deepEqual(tie.candidates, ['Vega', 'Vega']);
});

test('a preset that did not move the clock is not reported as done', async () => {
  const h = voiceFor({
    presetResult: { ok: true, timeMs: Date.parse('2026-10-26T23:41:00Z') },
  });
  h.sky.applyPreset = async () => h.state.presetResult;
  h.state.active = true;
  const r = await h.voice.preset('sunset');
  assert.equal(r.ok, false);
  assert.match(r.error, /newer time change/);
});

test('look returns unavailable if Sky is destroyed while satellites load', async () => {
  const h = voiceFor({
    satStatus: 'loading',
    satelliteWaitMs: 200,
    search: () => [hit('ISS (ZARYA)', 'satellite')],
  });
  h.state.active = true;
  const pending = h.voice.look('the ISS');
  await new Promise((resolve) => setTimeout(resolve, 30));
  h.state.destroyed = true;
  const r = await pending;
  assert.equal(r.ok, false);
  assert.match(r.error, /not available/);
  assert.equal(
    h.calls.some((c) => c[0] === 'lookAt'),
    false,
  );
});

test('look returns unavailable if Sky is destroyed while star data loads', async () => {
  const h = voiceFor({
    satelliteWaitMs: 0,
    search: () => [hit('Jupiter', 'planet')],
  });
  h.state.active = true;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  h.sky.content.ensureData = async () => {
    h.calls.push(['ensureData']);
    await gate;
  };
  const pending = h.voice.look('Jupiter');
  await new Promise((resolve) => setTimeout(resolve, 20));
  h.state.destroyed = true;
  release();
  const r = await pending;
  assert.equal(r.ok, false);
  assert.match(r.error, /not available/);
  assert.equal(
    h.calls.some((c) => c[0] === 'search'),
    false,
  );
  assert.equal(
    h.calls.some((c) => c[0] === 'lookAt'),
    false,
  );
});

test('look returns unavailable if Sky is destroyed while opening', async () => {
  const h = voiceFor({
    search: () => [hit('Jupiter', 'planet')],
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  h.sky.openHere = async () => {
    h.calls.push(['openHere']);
    await gate;
    h.state.active = true;
    return { ok: true };
  };
  const pending = h.voice.look('Jupiter');
  await new Promise((resolve) => setTimeout(resolve, 20));
  h.state.destroyed = true;
  release();
  const r = await pending;
  assert.equal(r.ok, false);
  assert.match(r.error, /not available/);
  assert.equal(
    h.calls.some((c) => c[0] === 'ensureData' || c[0] === 'search'),
    false,
  );
});

async function destroyDuringOpen(h, run) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  h.sky.openHere = async () => {
    h.calls.push(['openHere']);
    await gate;
    h.state.active = true;
    return { ok: true };
  };
  const pending = run();
  await new Promise((resolve) => setTimeout(resolve, 20));
  h.state.destroyed = true;
  release();
  return pending;
}

test('time returns unavailable if Sky is destroyed while opening', async () => {
  const h = voiceFor();
  const r = await destroyDuringOpen(h, () =>
    h.voice.time({ time: '2026-10-26T03:00:00Z' }),
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /not available/);
  assert.equal(
    h.calls.some((c) => c[0] === 'setTime'),
    false,
  );
});

test('lines returns unavailable if Sky is destroyed while opening', async () => {
  const h = voiceFor();
  const r = await destroyDuringOpen(h, () => h.voice.lines(false));
  assert.equal(r.ok, false);
  assert.match(r.error, /not available/);
  assert.equal(
    h.calls.some((c) => c[0] === 'setFlags'),
    false,
  );
});

test('preset returns unavailable if Sky is destroyed while opening', async () => {
  const h = voiceFor();
  const r = await destroyDuringOpen(h, () => h.voice.preset('sunset'));
  assert.equal(r.ok, false);
  assert.match(r.error, /not available/);
  assert.equal(
    h.calls.some((c) => c[0] === 'preset'),
    false,
  );
});

test('preset returns unavailable if Sky is destroyed during applyPreset', async () => {
  const h = voiceFor();
  h.state.active = true;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  h.sky.applyPreset = async (id) => {
    h.calls.push(['preset', id]);
    await gate;
    if (
      h.state.presetResult?.ok &&
      Number.isFinite(h.state.presetResult.timeMs)
    )
      h.state.timeMs = h.state.presetResult.timeMs;
    return h.state.presetResult;
  };
  const pending = h.voice.preset('sunset');
  await new Promise((resolve) => setTimeout(resolve, 20));
  h.state.destroyed = true;
  release();
  const r = await pending;
  assert.equal(r.ok, false);
  assert.match(r.error, /not available/);
  assert.equal(r.preset, undefined);
  assert.equal(r.time, undefined);
});

function replaceableVoice() {
  const opened = fakeSky();
  const replacement = fakeSky();
  let mounted = opened.sky;
  const voice = createSkyVoice({
    getHandle: () => mounted,
    satelliteWaitMs: 0,
  });
  return {
    opened,
    replacement,
    voice,
    replace() {
      mounted = replacement.sky;
    },
  };
}

async function replaceDuringOpen(pair, run) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  pair.opened.sky.openHere = async () => {
    pair.opened.calls.push(['openHere']);
    await gate;
    pair.opened.state.active = true;
    return { ok: true };
  };
  const pending = run();
  await new Promise((resolve) => setTimeout(resolve, 20));
  pair.replace();
  release();
  return pending;
}

test('time returns unavailable if a different Sky is mounted while opening', async () => {
  const pair = replaceableVoice();
  const r = await replaceDuringOpen(pair, () =>
    pair.voice.time({ time: '2026-10-26T03:00:00Z' }),
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /not available/);
  assert.equal(r.opened, undefined);
  assert.equal(
    pair.replacement.calls.some((c) => c[0] === 'setTime'),
    false,
  );
});

test('lines returns unavailable if a different Sky is mounted while opening', async () => {
  const pair = replaceableVoice();
  const r = await replaceDuringOpen(pair, () => pair.voice.lines(false));
  assert.equal(r.ok, false);
  assert.match(r.error, /not available/);
  assert.equal(r.opened, undefined);
  assert.equal(
    pair.replacement.calls.some((c) => c[0] === 'setFlags'),
    false,
  );
});

test('preset returns unavailable if a different Sky is mounted while opening', async () => {
  const pair = replaceableVoice();
  const r = await replaceDuringOpen(pair, () => pair.voice.preset('sunset'));
  assert.equal(r.ok, false);
  assert.match(r.error, /not available/);
  assert.equal(r.opened, undefined);
  assert.equal(
    pair.replacement.calls.some((c) => c[0] === 'preset'),
    false,
  );
});

test('preset returns unavailable if a different Sky is mounted during applyPreset', async () => {
  const pair = replaceableVoice();
  pair.opened.state.active = true;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  pair.opened.sky.applyPreset = async (id) => {
    pair.opened.calls.push(['preset', id]);
    await gate;
    if (
      pair.opened.state.presetResult?.ok &&
      Number.isFinite(pair.opened.state.presetResult.timeMs)
    )
      pair.opened.state.timeMs = pair.opened.state.presetResult.timeMs;
    return pair.opened.state.presetResult;
  };
  const pending = pair.voice.preset('sunset');
  await new Promise((resolve) => setTimeout(resolve, 20));
  pair.replace();
  release();
  const r = await pending;
  assert.equal(r.ok, false);
  assert.match(r.error, /not available/);
  assert.equal(r.preset, undefined);
  assert.equal(r.time, undefined);
  assert.equal(
    pair.replacement.calls.some((c) => c[0] === 'preset'),
    false,
  );
});

test('look returns unavailable if a different Sky is mounted while opening', async () => {
  const pair = replaceableVoice();
  pair.replacement.state.search = () => [hit('Jupiter', 'planet')];
  const r = await replaceDuringOpen(pair, () => pair.voice.look('Jupiter'));
  assert.equal(r.ok, false);
  assert.match(r.error, /not available/);
  assert.equal(r.opened, undefined);
  assert.equal(
    pair.replacement.calls.some(
      (c) => c[0] === 'search' || c[0] === 'ensureData',
    ),
    false,
  );
});

test('look returns unavailable if a different Sky is mounted while star data loads', async () => {
  const pair = replaceableVoice();
  pair.opened.state.active = true;
  pair.replacement.state.search = () => [hit('Jupiter', 'planet')];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  pair.opened.sky.content.ensureData = async () => {
    pair.opened.calls.push(['ensureData']);
    await gate;
  };
  const pending = pair.voice.look('Jupiter');
  await new Promise((resolve) => setTimeout(resolve, 20));
  pair.replace();
  release();
  const r = await pending;
  assert.equal(r.ok, false);
  assert.match(r.error, /not available/);
  assert.equal(r.target, undefined);
  assert.equal(
    pair.replacement.calls.some((c) => c[0] === 'search' || c[0] === 'lookAt'),
    false,
  );
});

test('look returns unavailable if a different Sky is mounted while satellites load', async () => {
  const opened = fakeSky({ satStatus: 'loading' });
  const replacement = fakeSky({
    satStatus: 'ready',
    search: () => [hit('ISS (ZARYA)', 'satellite')],
  });
  opened.state.active = true;
  let mounted = opened.sky;
  const voice = createSkyVoice({
    getHandle: () => mounted,
    satelliteWaitMs: 800,
  });
  const started = Date.now();
  const pending = voice.look('the ISS');
  await new Promise((resolve) => setTimeout(resolve, 30));
  mounted = replacement.sky;
  const r = await pending;
  const elapsed = Date.now() - started;
  assert.equal(r.ok, false);
  assert.match(r.error, /not available/);
  assert.equal(r.target, undefined);
  assert.ok(elapsed < 250, `waited ${elapsed}ms`);
  assert.equal(
    replacement.calls.some((c) => c[0] === 'search' || c[0] === 'lookAt'),
    false,
  );
});

test('open returns unavailable if Sky is destroyed while opening', async () => {
  const h = voiceFor();
  const r = await destroyDuringOpen(h, () => h.voice.open());
  assert.equal(r.ok, false);
  assert.match(r.error, /not available/);
  assert.equal(r.opened, undefined);
  assert.equal(r.open, undefined);
});

test('open returns unavailable if a different Sky is mounted while opening', async () => {
  const pair = replaceableVoice();
  const r = await replaceDuringOpen(pair, () => pair.voice.open());
  assert.equal(r.ok, false);
  assert.match(r.error, /not available/);
  assert.equal(r.opened, undefined);
  assert.equal(r.open, undefined);
  assert.equal(
    pair.replacement.calls.some((c) => c[0] === 'openHere'),
    false,
  );
});

test('preset returns a fail reply if applyPreset rejects, and does not throw', async () => {
  const h = voiceFor();
  h.state.active = true;
  h.sky.applyPreset = async () => {
    throw new Error('preset boom SECRETKEY123');
  };
  const r = await h.voice.preset('sunset');
  assert.equal(r.ok, false);
  assert.match(r.error, /could not be applied/);
  assert.equal(r.preset, undefined);
  assert.equal(r.time, undefined);
  assert.equal(JSON.stringify(r).includes('SECRETKEY123'), false);
  assert.equal(JSON.stringify(r).includes('sunset'), false);
});
