import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createFeedAvailability,
  probeFeedGroups,
  NO_FEED_CAMERA_TTL_MS,
  NO_FEED_GROUP_TTL_MS,
  NO_FEED_SUSPECT_TTL_MS,
} from './feedAvailability.js';

// Cameras with no public picture are served location-only.

test('two consecutive failed frames mark a camera; a success clears it', () => {
  const a = createFeedAvailability();
  a.recordFrame('cam1', false);
  assert.equal(a.isUnavailable('cam1'), false, 'one failure is not enough');
  a.recordFrame('cam1', false);
  assert.equal(a.isUnavailable('cam1'), true);
  a.recordFrame('cam1', true);
  assert.equal(a.isUnavailable('cam1'), false);
});

test('a success between failures resets the count', () => {
  const a = createFeedAvailability();
  a.recordFrame('cam1', false);
  a.recordFrame('cam1', true);
  a.recordFrame('cam1', false);
  assert.equal(a.isUnavailable('cam1'), false);
});

test('a camera mark expires so the feed is retried', () => {
  let t = 1_000;
  const a = createFeedAvailability({ now: () => t });
  a.recordFrame('cam1', false);
  a.recordFrame('cam1', false);
  t += NO_FEED_CAMERA_TTL_MS - 1;
  assert.equal(a.isUnavailable('cam1'), true);
  t += 1;
  assert.equal(a.isUnavailable('cam1'), false);
});

test('group probe: two consecutive all-fail probes -> location-only; one ok -> not', async () => {
  let t = 1_000;
  const a = createFeedAvailability({ now: () => t });
  const sources = [
    ...Array.from({ length: 10 }, (_, i) => ({ id: `hou${i}`, g: 'tx-hou' })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `dal${i}`, g: 'tx-dal' })),
  ];
  const probed = [];
  const probe = async (s) => {
    probed.push(s.id);
    return s.g === 'tx-dal';
  };
  let verdicts = await probeFeedGroups(sources, a, (s) => s.g, probe);
  assert.deepEqual(verdicts, { 'tx-hou': 'suspect', 'tx-dal': 'ok' });
  assert.equal(
    probed.filter((id) => id.startsWith('hou')).length,
    3,
    'samples 3 per failing group',
  );
  assert.equal(
    probed.filter((id) => id.startsWith('dal')).length,
    1,
    'stops at first success',
  );
  assert.equal(
    a.isUnavailable('hou7', 'tx-hou'),
    false,
    'one failed probe only makes it suspect',
  );
  // Suspect is re-probed soon; ok verdicts are not.
  probed.length = 0;
  await probeFeedGroups(sources, a, (s) => s.g, probe);
  assert.equal(
    probed.length,
    0,
    'suspect verdict is fresh for NO_FEED_SUSPECT_TTL_MS',
  );
  t += NO_FEED_SUSPECT_TTL_MS;
  verdicts = await probeFeedGroups(sources, a, (s) => s.g, probe);
  assert.deepEqual(
    verdicts,
    { 'tx-hou': 'location-only' },
    'only the suspect group is re-probed',
  );
  assert.equal(a.isUnavailable('hou7', 'tx-hou'), true);
  assert.equal(a.isUnavailable('dal7', 'tx-dal'), false);
  // After the group TTL the group is probed again and can recover.
  t += NO_FEED_GROUP_TTL_MS;
  assert.equal(
    a.isUnavailable('hou7', 'tx-hou'),
    false,
    'expired verdict is not applied',
  );
  await probeFeedGroups(
    sources,
    a,
    (s) => s.g,
    async () => true,
  );
  assert.equal(a.isUnavailable('hou7', 'tx-hou'), false);
});

test('a transient blip does not hide a working group (El Paso case)', async () => {
  let t = 1_000;
  const a = createFeedAvailability({ now: () => t });
  const sources = Array.from({ length: 10 }, (_, i) => ({
    id: `elp${i}`,
    g: 'tx-elp',
  }));
  await probeFeedGroups(
    sources,
    a,
    (s) => s.g,
    async () => false,
  ); // blip
  t += NO_FEED_SUSPECT_TTL_MS;
  const verdicts = await probeFeedGroups(
    sources,
    a,
    (s) => s.g,
    async () => true,
  );
  assert.deepEqual(verdicts, { 'tx-elp': 'ok' });
  assert.equal(a.isUnavailable('elp3', 'tx-elp'), false);
});

test('state persists across restarts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-nofeed-'));
  const file = path.join(dir, 'state.json');
  const a = createFeedAvailability({ file });
  a.recordFrame('cam1', false);
  a.recordFrame('cam1', false);
  a.setGroupVerdict('txdot:tx-hou', true);
  a.setGroupVerdict('txdot:tx-hou', true);
  await a.persistNow();
  const b = createFeedAvailability({ file });
  assert.equal(b.isUnavailable('cam1'), true);
  assert.equal(b.isUnavailable('other', 'txdot:tx-hou'), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('/api/cctv/sources wiring marks unavailable cameras feedType none', () => {
  const src = fs.readFileSync(new URL('../cctv.js', import.meta.url), 'utf8');
  assert.match(src, /feedAvailability\.isUnavailable\(\s*source\.id/);
  assert.match(src, /feedAvailability\.recordFrame\(/);
});

test('client treats feedType none as location-only', () => {
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.match(
    read('../../../src/layers/cctv/model.js'),
    /function isNoFeedType/,
  );
  assert.match(
    read('../../../src/layers/cctv/projection.js'),
    /isNoFeedType\(/,
  );
  assert.match(read('../../../src/layers/cctv/cards.js'), /isNoFeedType\(/);
  assert.match(read('../../../src/layers/cctv/hover.js'), /isNoFeedType\(/);
  assert.match(
    read('../../../src/layers/cctv/presentation.js'),
    /isNoFeedType\(/,
  );
});
