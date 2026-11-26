// A zone-less forecast run time must mean the
// same instant on every client (or be rejected).
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

const parseIn = (tz, run) => {
  const code = `import('./src/layers/airQuality/field.js').then(({readFieldManifest})=>{let out;try{out=String(readFieldManifest({run:${JSON.stringify(run)},scale:{pm25:1,pm10:1,o3:1,no2:1,so2:1,co:1,aqi:1},global:{width:2,height:2,lon0:0,lat0:0,step:1,steps:[0,1]}}).runMs)}catch{out='rejected'}console.log(out)})`;
  return execFileSync(process.execPath, ['-e', code], {
    env: { ...process.env, TZ: tz },
    cwd: process.cwd(),
  })
    .toString()
    .trim();
};

test('a zone-less run time is one instant in every time zone', () => {
  const utc = parseIn('UTC', '2026-11-25T12:00:00');
  const ny = parseIn('America/New_York', '2026-11-25T12:00:00');
  const paris = parseIn('Europe/Paris', '2026-11-25T12:00:00');
  // Either rejected everywhere, or the same instant everywhere.
  assert.equal(ny, utc);
  assert.equal(paris, utc);
  if (utc !== 'rejected') assert.equal(Number(utc), Date.UTC(2026, 10, 25, 12));
});

test('a zone-less run with a space before the time is one instant in every time zone', () => {
  const run = '2026-11-25 12:00:00';
  const utc = String(Date.UTC(2026, 10, 25, 12));
  assert.equal(parseIn('America/New_York', run), utc);
  assert.equal(parseIn('Europe/Paris', run), utc);
});

test('a zone-less run that is not ISO is refused in every time zone', () => {
  for (const tz of ['UTC', 'America/New_York', 'Europe/Paris'])
    assert.equal(parseIn(tz, 'Nov 25 2026 12:00'), 'rejected');
});

test('control: explicit Z and offset agree across time zones', () => {
  const z = String(Date.UTC(2026, 10, 25, 12));
  assert.equal(parseIn('America/New_York', '2026-11-25T12:00:00Z'), z);
  assert.equal(parseIn('Europe/Paris', '2026-11-25T13:00:00+01:00'), z);
});
