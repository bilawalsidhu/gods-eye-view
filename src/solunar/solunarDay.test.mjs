import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { solunarDay, solunarWeek } from './solunarDay.js';
import {
  addDays,
  localDayStartMs,
  localDateOf,
  zoneAt,
  zoneOffsetMs,
} from './zone.js';

// USNO Astronomical Applications, api/rstt/oneday, fetched 2026-11-03 with a
// FIXED UTC offset per case (dst=false). Times are HH:MM in that offset.
const CASES = JSON.parse(
  readFileSync(new URL('./fixtures/usnoOneDay.json', import.meta.url), 'utf8'),
);
const TOLERANCE_MS = 2 * 60_000;

const ymd = (s) => {
  const [year, month, day] = s.split('-').map(Number);
  return { year, month, day };
};
/** Etc/GMT zone with the same fixed offset (the sign is inverted in Etc/GMT). */
const fixedZone = (hours) =>
  `Etc/GMT${hours > 0 ? '-' : '+'}${Math.abs(hours)}`;
const usnoUtcMs = (c, hhmm) => {
  const { year, month, day } = ymd(c.date);
  const [h, m] = hhmm.split(':').map(Number);
  return (
    Date.UTC(year, month - 1, day, h, m) - c.usnoUtcOffsetHours * 3_600_000
  );
};
const KINDS = [
  ['moonrise', 'moonrise'],
  ['moonUpperTransit', 'moonUpper'],
  ['moonset', 'moonset'],
  ['sunrise', 'sunrise'],
  ['sunTransit', 'sunTransit'],
  ['sunset', 'sunset'],
];
const spotOf = (c, zone) => ({ latDeg: c.latDeg, lonDeg: c.lonDeg, zone });

for (const c of CASES) {
  test(`USNO ${c.name}: every sun and moon event within 2 min, and no extra event`, () => {
    const day = solunarDay(
      spotOf(c, fixedZone(c.usnoUtcOffsetHours)),
      ymd(c.date),
    );
    for (const [usnoKey, ourKey] of KINDS) {
      const want = c[usnoKey].map((t) => usnoUtcMs(c, t));
      const got = day[ourKey];
      assert.equal(
        got.length,
        want.length,
        `${c.name} ${ourKey}: USNO has ${want.length}, we have ${got.length}`,
      );
      want.forEach((ms, i) =>
        assert.ok(
          Math.abs(got[i] - ms) <= TOLERANCE_MS,
          `${c.name} ${ourKey}: off by ${((got[i] - ms) / 60_000).toFixed(2)} min`,
        ),
      );
    }
  });

  test(`USNO ${c.name}: illumination within 3 points`, () => {
    const day = solunarDay(
      spotOf(c, fixedZone(c.usnoUtcOffsetHours)),
      ymd(c.date),
    );
    const usno = Number.parseInt(c.fracillum, 10) / 100;
    assert.ok(
      Math.abs(day.illumination - usno) <= 0.03,
      `${c.name}: ${day.illumination} vs ${usno}`,
    );
  });
}

test('a local day with no moonrise says none: 2026-11-02 at 33.05,-95.1 (USNO: no rise; transit 07:00, set 13:51)', () => {
  const zone = 'America/Chicago';
  const spot = { latDeg: 33.05, lonDeg: -95.1, zone };
  const nov2 = solunarDay(spot, ymd('2026-11-02'));
  const nov3 = solunarDay(spot, ymd('2026-11-03'));
  assert.deepEqual(nov2.moonrise, [], 'no moonrise that day');
  assert.equal(nov3.moonrise.length, 1);
  // the next day's rise must not appear in Nov 2, in any list
  const borrowed = nov3.moonrise[0];
  for (const key of ['moonrise', 'moonset', 'moonUpper', 'moonLower'])
    assert.ok(!nov2[key].includes(borrowed), `${key} borrowed the next day`);
  assert.ok(
    nov2.windows.every((w) => w.source !== 'rise'),
    'no minor window from a rise',
  );
  // local clock time (CST, UTC-6): upper transit 07:00, set 13:51
  const hhmm = (ms) =>
    new Date(Math.round(ms / 60_000) * 60_000 - 6 * 3_600_000)
      .toISOString()
      .slice(11, 16);
  assert.equal(hhmm(nov2.moonUpper[0]), '07:00');
  assert.equal(hhmm(nov2.moonset[0]), '13:51');
  assert.equal(hhmm(nov3.moonrise[0]), '01:05');
});

test('every event is inside its own local day, for a week at three latitudes', () => {
  const nowMs = Date.UTC(2026, 10, 3, 18);
  for (const spot of [
    { latDeg: 33.05, lonDeg: -95.1 },
    { latDeg: 61.2, lonDeg: -149.9 },
    { latDeg: -33.87, lonDeg: 151.21 },
  ]) {
    for (const day of solunarWeek(spot, nowMs, 7)) {
      for (const key of [
        'sunrise',
        'sunset',
        'sunTransit',
        'moonrise',
        'moonset',
        'moonUpper',
        'moonLower',
      ])
        for (const ms of day[key])
          assert.ok(
            ms >= day.startMs && ms < day.endMs,
            `${day.date} ${key} outside its day`,
          );
    }
  }
});

test('days with no rise or set at high latitude say none instead of borrowing', () => {
  // Longyearbyen in midsummer: the Sun never sets
  const day = solunarDay(
    { latDeg: 78.22, lonDeg: 15.65 },
    { year: 2026, month: 6, day: 21 },
  );
  assert.deepEqual(day.sunset, []);
  assert.deepEqual(day.sunrise, []);
  assert.deepEqual(
    day.bands,
    [],
    'no dawn or dusk band without sunrise or sunset',
  );
  assert.ok(day.huntingStars >= 1 && day.huntingStars <= 4);
});

test('the week is seven consecutive local days that tile the timeline', () => {
  const week = solunarWeek(
    { latDeg: 33.05, lonDeg: -95.1 },
    Date.UTC(2026, 10, 3, 18),
    7,
  );
  assert.equal(week.length, 7);
  assert.equal(week[0].date, '2026-11-03');
  assert.equal(week[6].date, '2026-11-09');
  for (let i = 1; i < 7; i++) assert.equal(week[i].startMs, week[i - 1].endMs);
});

test('"today" is the spot\'s local date, not the viewer\'s', () => {
  // 2026-11-04 03:00 UTC is still Nov 3 in Chicago and already Nov 4 in Sydney
  const nowMs = Date.UTC(2026, 10, 4, 3);
  assert.equal(
    solunarWeek({ latDeg: 33.05, lonDeg: -95.1 }, nowMs, 1)[0].date,
    '2026-11-03',
  );
  assert.equal(
    solunarWeek({ latDeg: -33.87, lonDeg: 151.21 }, nowMs, 1)[0].date,
    '2026-11-04',
  );
});

const DST_CASES = CASES.filter((c) => /dst/.test(c.name));
for (const c of DST_CASES) {
  test(`DST change day ${c.name}: local day is 23 or 25 h and events match USNO where the two days overlap`, () => {
    const day = solunarDay(spotOf(c, c.zone), ymd(c.date));
    const hours = (day.endMs - day.startMs) / 3_600_000;
    assert.ok(hours === 23 || hours === 25, `day length ${hours} h`);
    const usnoStart = usnoUtcMs(c, '00:00');
    const usnoEnd = usnoStart + 86_400_000;
    const lo = Math.max(day.startMs, usnoStart);
    const hi = Math.min(day.endMs, usnoEnd);
    for (const [usnoKey, ourKey] of KINDS) {
      const want = c[usnoKey]
        .map((t) => usnoUtcMs(c, t))
        .filter((ms) => ms >= lo && ms < hi);
      const got = day[ourKey].filter((ms) => ms >= lo && ms < hi);
      assert.equal(
        got.length,
        want.length,
        `${c.name} ${ourKey} count in the overlap`,
      );
      want.forEach((ms, i) =>
        assert.ok(Math.abs(got[i] - ms) <= TOLERANCE_MS, `${c.name} ${ourKey}`),
      );
    }
  });
}

test('the clock-change days really are 23 h and 25 h at 33.05,-95.1', () => {
  const zone = 'America/Chicago';
  const len = (s) => {
    const d = ymd(s);
    const n = addDays(d, 1);
    return (
      (localDayStartMs(zone, n.year, n.month, n.day) -
        localDayStartMs(zone, d.year, d.month, d.day)) /
      3_600_000
    );
  };
  assert.equal(len('2026-03-08'), 23);
  assert.equal(len('2026-11-01'), 25);
  assert.equal(len('2026-11-03'), 24);
});

test('major windows are 2 h around a transit, minor windows 1 h around a rise or set', () => {
  const day = solunarDay(
    { latDeg: 33.05, lonDeg: -95.1, zone: 'America/Chicago' },
    ymd('2026-11-03'),
  );
  assert.ok(day.windows.length >= 3);
  for (const w of day.windows) {
    const want = w.kind === 'major' ? 2 : 1;
    assert.equal((w.endMs - w.startMs) / 3_600_000, want);
    assert.equal((w.startMs + w.endMs) / 2, w.centerMs);
  }
  assert.equal(
    day.windows.filter((w) => w.kind === 'major').length,
    day.moonUpper.length + day.moonLower.length,
  );
  assert.equal(
    day.windows.filter((w) => w.kind === 'minor').length,
    day.moonrise.length + day.moonset.length,
  );
});

test('zone lookup: Lake Bob Sandlin is America/Chicago, bad input falls back to UTC', () => {
  assert.equal(zoneAt(33.05, -95.1), 'America/Chicago');
  assert.equal(zoneAt(61.2, -149.9), 'America/Anchorage');
  assert.equal(zoneAt(NaN, 0), 'UTC');
  assert.equal(zoneAt(91, 0), 'UTC');
});

test('zone offsets follow daylight time', () => {
  const z = 'America/Chicago';
  assert.equal(zoneOffsetMs(z, Date.UTC(2026, 6, 1)), -5 * 3_600_000);
  assert.equal(zoneOffsetMs(z, Date.UTC(2026, 11, 1)), -6 * 3_600_000);
  assert.deepEqual(localDateOf(z, Date.UTC(2026, 10, 4, 3)), {
    year: 2026,
    month: 11,
    day: 3,
  });
});

test('a runtime that prints local midnight as 24:00 on the previous date still gives the right local day', async () => {
  const { localDayStartMs, localDateOf } = await import('./zone.js');
  const real = Intl.DateTimeFormat.prototype.formatToParts;
  Intl.DateTimeFormat.prototype.formatToParts = function (d) {
    const parts = real.call(this, d);
    const hour = parts.find((p) => p.type === 'hour');
    if (
      hour &&
      Number(hour.value) === 0 &&
      this.resolvedOptions().timeZone === 'America/Chicago'
    ) {
      // 00:xx on the 4th is reported as 24:xx on the 3rd
      const day = parts.find((p) => p.type === 'day');
      hour.value = '24';
      day.value = String(Number(day.value) - 1);
    }
    return parts;
  };
  try {
    const start = localDayStartMs('America/Chicago', 2026, 11, 4);
    assert.equal(new Date(start).toISOString(), '2026-11-04T06:00:00.000Z');
    assert.deepEqual(localDateOf('America/Chicago', start), {
      year: 2026,
      month: 11,
      day: 4,
    });
  } finally {
    Intl.DateTimeFormat.prototype.formatToParts = real;
  }
});

test('a zone that springs forward AT midnight (Havana 2026-03-08) starts the day at 01:00 local and the day is 23 h', async () => {
  const { localDayStartMs, addDays } = await import('./zone.js');
  const start = localDayStartMs('America/Havana', 2026, 3, 8);
  assert.equal(new Date(start).toISOString(), '2026-03-08T05:00:00.000Z');
  const n = addDays({ year: 2026, month: 3, day: 8 }, 1);
  const end = localDayStartMs('America/Havana', n.year, n.month, n.day);
  assert.equal((end - start) / 3_600_000, 23);
  // the day before is a normal 24 h day and ends where this one starts
  const p = addDays({ year: 2026, month: 3, day: 8 }, -1);
  assert.equal(
    start - localDayStartMs('America/Havana', p.year, p.month, p.day),
    24 * 3_600_000,
  );
});

test('phase name matches USNO curphase on every fixture day, and agrees with the lit percentage', () => {
  for (const c of CASES) {
    const day = solunarDay(
      { latDeg: c.latDeg, lonDeg: c.lonDeg, zone: c.zone },
      {
        year: Number(c.date.slice(0, 4)),
        month: Number(c.date.slice(5, 7)),
        day: Number(c.date.slice(8, 10)),
      },
    );
    // USNO's curphase is for the start of the UT day. On 2026-11-01 the exact
    // Last Quarter falls that same local day (USNO phases API: 2026-11-01
    // 20:28 UTC = 15:28 CDT), so the card names the day Last Quarter at 51%.
    const expected =
      c.name === 'chicago-2026-11-01-dst-end' ? 'Last Quarter' : c.curphase;
    assert.equal(day.phase, expected, c.name);
    const lit = day.illumination;
    if (/Crescent/.test(day.phase)) assert.ok(lit < 0.5, c.name);
    if (/Gibbous/.test(day.phase)) assert.ok(lit > 0.5, c.name);
  }
});

test('phaseName: crescent below half, gibbous above, principal phases only near the exact moment', async () => {
  const { phaseName } = await import('./solunarDay.js');
  const at = (deg) => phaseName(deg);
  assert.equal(at(0), 'New Moon');
  assert.equal(at(355), 'New Moon');
  assert.equal(at(40), 'Waxing Crescent');
  assert.equal(at(90), 'First Quarter');
  assert.equal(at(135), 'Waxing Gibbous');
  assert.equal(at(180), 'Full Moon');
  assert.equal(at(225), 'Waning Gibbous');
  assert.equal(at(270), 'Last Quarter');
  assert.equal(at(282), 'Waning Crescent'); // ~40% lit, was mislabelled Last Quarter
  assert.equal(at(300), 'Waning Crescent');
});

test('days to the nearest new or full moon are searched, anchored on USNO new moon 2026-11-09 07:02 UTC and full moon 2026-11-24 14:53 UTC', async () => {
  const { daysFromSyzygy } = await import('./solunarDay.js');
  const nm = Date.UTC(2026, 10, 9, 7, 2);
  const fm = Date.UTC(2026, 10, 24, 14, 53);
  assert.ok(daysFromSyzygy(nm) < 0.01);
  assert.ok(daysFromSyzygy(fm) < 0.01);
  assert.ok(Math.abs(daysFromSyzygy(fm - 1.2 * 86_400_000) - 1.2) < 0.02);
  assert.ok(Math.abs(daysFromSyzygy(nm + 1.5 * 86_400_000) - 1.5) < 0.05);
  assert.ok(Math.abs(daysFromSyzygy(nm - 2.4 * 86_400_000) - 2.4) < 0.05);
});

test('moon underfoot (lower transit, drives the major windows) sits halfway between USNO upper transits, within 3 min', () => {
  // USNO rstt gives upper transits only. The lower transit is the midpoint of
  // the two surrounding upper transits (the Moon's hour angle advances
  // smoothly), so two consecutive USNO days check it independently.
  const pairs = [['chicago-2026-11-02', 'chicago-2026-11-03']];
  const byName = Object.fromEntries(CASES.map((c) => [c.name, c]));
  for (const [a, b] of pairs) {
    const ca = byName[a];
    const cb = byName[b];
    const upperA = usnoUtcMs(ca, ca.moonUpperTransit[0]);
    const upperB = usnoUtcMs(cb, cb.moonUpperTransit[0]);
    const expected = (upperA + upperB) / 2;
    const day = solunarDay(
      { latDeg: ca.latDeg, lonDeg: ca.lonDeg, zone: ca.zone },
      ymd(ca.date),
    );
    assert.equal(day.moonLower.length, 1, a);
    assert.ok(
      Math.abs(day.moonLower[0] - expected) <= 3 * 60_000,
      `${a}: lower transit ${new Date(day.moonLower[0]).toISOString()} vs USNO midpoint ${new Date(expected).toISOString()}`,
    );
  }
});
