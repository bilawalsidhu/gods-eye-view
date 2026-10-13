/** Fixed-rate synthetic AIS replay: CPU time is measured, not battery energy. */
import fs from 'node:fs';
import { Session } from 'node:inspector';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const baseline = args.includes('--baseline');
const profile = args.includes('--profile');
fs.mkdirSync('output/playwright', { recursive: true });
const modulePath = baseline
  ? 'output/playwright/ais-store-before.mjs'
  : 'server/providers/vessels/ais-store.js';
const store = await import(pathToFileURL(resolve(modulePath)));
const { decodeAisFrameSync } = await import(
  pathToFileURL(
    resolve(
      baseline
        ? 'output/playwright/ais-adapter-before.mjs'
        : 'src/data/aisStreamAdapter.js',
    ),
  )
);
const vessels = 30000;
const rate = 500;
const batch = 25;
const samples = [];
const fixture = (index, moved, timestamp) => ({
  MessageType: 'PositionReport',
  MetaData: {
    MMSI: String(200000000 + (index % vessels)),
    latitude: 25 + (index % 100) / 1000 + (moved ? 0.001 : 0),
    longitude: 56 + (index % 200) / 1000,
    time_utc: timestamp,
  },
  Message: {
    PositionReport: { UserID: 200000000 + (index % vessels), Sog: 12, Cog: 90 },
  },
});
// Both implementations start with the same thinned-track eligibility, regardless
// of how long filling the cache took. All reports remain inside the retention window.
const seedAt = new Date(Date.now() - 60000).toISOString();
for (let i = 0; i < vessels; i++)
  store.ingestAisStreamEnvelope(fixture(i, false, seedAt));
console.log(`Seeded ${vessels} synthetic vessels; replay ${rate} messages/sec`);
let session;
const post = (method) =>
  new Promise((ok, fail) =>
    session.post(method, (error, result) => (error ? fail(error) : ok(result))),
  );
if (profile) {
  session = new Session();
  session.connect();
  await post('Profiler.enable');
  await post('Profiler.start');
}
let index = 0;
for (let round = 0; round < 3; round++) {
  const started = performance.now();
  const before = process.cpuUsage();
  for (let tick = 0; tick < 300; tick++) {
    const timestamp = new Date().toISOString();
    for (let j = 0; j < batch; j++) {
      const raw = Buffer.from(
        JSON.stringify(fixture(index++, true, timestamp)),
      );
      if (!store.ingestAisStreamEnvelope(JSON.parse(decodeAisFrameSync(raw))))
        throw new Error('Valid synthetic AIS record was rejected');
    }
    await delay(
      Math.max(
        0,
        started + ((tick + 1) * batch * 1000) / rate - performance.now(),
      ),
    );
  }
  const elapsedMs = performance.now() - started;
  const used = process.cpuUsage(before);
  const observation = {
    round: round + 1,
    messages: 300 * batch,
    elapsedMs,
    cpuSeconds: (used.user + used.system) / 1e6,
    cpuPercent: (used.user + used.system) / (elapsedMs * 10),
  };
  samples.push(observation);
  console.log(JSON.stringify(observation));
}
if (profile) {
  const result = await post('Profiler.stop');
  fs.writeFileSync(
    `output/playwright/ais-${baseline ? 'before' : 'after'}.cpuprofile`,
    JSON.stringify(result.profile),
  );
  session.disconnect();
}
const rows = store.aisStreamRows(vessels);
if (rows.length !== vessels) throw new Error('Replay lost current vessels');
const result = {
  evidence:
    'SIMULATED AIS workload: identical 30k-vessel cache and 500 messages/sec; process CPU time / elapsed time; 100% = one core',
  baseline,
  vessels,
  rate,
  samples,
  meanCpuPercent:
    samples.reduce((sum, sample) => sum + sample.cpuPercent, 0) /
    samples.length,
  retainedRows: rows.length,
};
fs.writeFileSync(
  `output/playwright/ais-cpu-${baseline ? 'before' : 'after'}.json`,
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result, null, 2));
