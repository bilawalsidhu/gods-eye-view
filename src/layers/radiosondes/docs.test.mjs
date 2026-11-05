import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VOICE_OFF_LAYERS } from '../../voice/layerManifest.js';
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const weatherState = () =>
  read('../../../docs/CURRENT-STATE.md')
    .split('## Weather balloons — SondeHub')[1]
    ?.split('\n## ')[0];
test('documentation pins the token, voice state, routes, coverage and attribution', () => {
  const state = weatherState();
  assert.ok(state);
  const rows = JSON.parse(read('../../data/layerStateTokenReservations.json'));
  const token = rows.find(([id]) => id === 'radiosondes')[1];
  assert.ok(state.includes(`share-link token \`${token}\``));
  assert.match(state, /Voice is off for this layer/);
  assert.ok(VOICE_OFF_LAYERS.radiosondes);
  for (const path of [
    '/api/radiosondes/stream',
    '/api/radiosondes/snapshot',
    '/track?serial=',
    '/history?serial=',
  ])
    assert.ok(state.includes(path));
  assert.match(state, /Coverage depends on volunteer/);
  assert.match(state, /no landing predictions/);
  for (const file of ['../../../DATA_SOURCES.md', '../../../README.md'])
    assert.match(read(file), /SondeHub.*CC BY-SA 2.0/);
});
test('documentation places counted balloon controls and launch guidance in the Weather group row', () => {
  const state = weatherState().replace(/\s+/g, ' ');
  assert.match(
    state,
    /layer panel's Weather group row counts ascending, descending, landed and lost contacts/,
  );
  assert.match(state, /unknown direction only when non-zero/);
  assert.match(state, /Both landed states count as Landed/);
  assert.match(state, /single info line shows connection status first/);
  assert.match(
    state,
    /launch reminder when no balloons are loaded, or the next launch window/,
  );
  assert.doesNotMatch(state, /Weather card|Weather legend|readout/i);
  assert.match(
    read('../../../README.md'),
    /Weather balloons.*counts and launch guidance in the Weather group row/,
  );
  assert.match(
    read('../../../changelog.d/1-radiosondes.md').replace(/\s+/g, ' '),
    /layer row shows per-state counts and connection status or launch guidance/,
  );
});
test('documentation pins flight-style sprites, retained contact labels and host-owned declutter', () => {
  const state = weatherState().replace(/\s+/g, ' ');
  for (const rule of [
    /balloon-silhouette sprites/,
    /20 px base size/,
    /`\(1000, 3, 8e6, 0\.5\)`/,
    /single reused `BillboardCollection`/,
    /`MAX_SONDES_RENDERED = 2000`/,
    /selection, aloft state and recency rank excess contacts/,
    /contacts stay visible for the retained store's lifetime/,
    /labels appear only at or below 1,500 km camera height, at the lowest priority/,
    /no additional one-hour retirement/i,
    /`TEST123 23\.0 km`/,
    /unknown-direction or still fixes and altitudes below 1 km/,
    /evidence beyond the 0\.5 m\/s velocity or 100 m track noise thresholds/,
    /`TEST123 landed` and `TEST123 lost`/,
    /`RADIOSONDE_LABEL_CANDIDATE_CAP = 150`/,
    /ranked on-screen, front-side candidates/,
    /overlay host owns declutter/,
    /Aloft labels rank before descending, then landed\/signal-lost/,
    /`stateless: true` prevents the host's incumbent-overlap fallback/,
  ])
    assert.match(state, rule);
  const change = read('../../../changelog.d/1-radiosondes.md').replace(
    /\s+/g,
    ' ',
  );
  for (const rule of [
    /20 px sprites and aircraft distance scaling/,
    /landed\/lost contacts retained under the 2,000-contact render cap/,
    /declutters up to 150 visible label candidates/,
    /coalesce pushes at 500 ms/,
    /bounded client queues/,
    /all available grouped metadata/,
  ])
    assert.match(change, rule);
});
test('documentation records full selected metadata, batching, reuse and bounded streaming', () => {
  const state = weatherState().replace(/\s+/g, ' ');
  for (const rule of [
    /short grouped lines show phase, altitude, vertical and horizontal speed, heading, temperature, humidity, pressure, drift-derived wind, burst maximum, type\/subtype, frequency when present, heard\/launched ages, coverage disclaimer and source attribution/,
    /selected card shows all available metadata/,
    /all 11 locales/,
    /`RADIOSONDE_DATA_BATCH_MS = 500`/,
    /Content signatures skip unchanged input/,
    /zero billboard writes/,
    /camera `moveEnd` or a data batch, with no per-frame scan/,
    /render governor once per batch/,
    /SSE diffs after the first snapshot/,
    /`MAX_SSE_QUEUED_BYTES`/,
    /next event or heartbeat, is limited to 2 MiB/,
    /202 `building` with Retry-After/,
    /first useful frame batch sent immediately/,
    /retry is bounded to 1 s/,
    /SSE data cancels it/,
    /`last=1800`.*then `last=10800`/,
    /`partial: true`, propagated to `stats.partial`/,
    /Partial snapshots merge membership/,
  ])
    assert.match(state, rule);
});
