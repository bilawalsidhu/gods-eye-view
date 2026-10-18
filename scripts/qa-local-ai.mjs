/**
 * Browser gate for local map commands against the real application runner.
 * Run a dev server, then: node scripts/qa-local-ai.mjs [--url http://127.0.0.1:4173]
 * Synthetic airborne/grounded contacts keep assertions independent of live feeds.
 * No model downloads, private microphone or cloud AI are used by this gate.
 * Real Bonsai/Whisper/Piper measurements are recorded in docs/LOCAL_AI_QA.md.
 */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { chromeExecutablePath } from './qa-chrome.mjs';

const index = process.argv.indexOf('--url');
const url = index < 0 ? 'http://127.0.0.1:4173' : process.argv[index + 1];
const response = await fetch(url);
assert.ok(response.ok, `Development server returned ${response.status}`);
const browser = await puppeteer.launch({
  executablePath: chromeExecutablePath(),
  headless: true,
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
  protocolTimeout: 180000,
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  await page.evaluateOnNewDocument(() => {
    const original = window.fetch.bind(window);
    const json = (body) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    window.fetch = (input, options) => {
      const path = new URL(
        typeof input === 'string' ? input : input.url,
        location.href,
      );
      if (path.origin !== location.origin) return original(input, options);
      const now = Math.floor(Date.now() / 1000);
      if (path.pathname === '/api/flights')
        return json({
          time: now,
          states: [
            [
              'aaa001',
              'SYN001',
              'Fixture',
              now,
              now,
              -97.7431,
              30.2672,
              9000,
              false,
              200,
              90,
              0,
              null,
              null,
              null,
              false,
              0,
            ],
            [
              'aaa002',
              'SYN002',
              'Fixture',
              now,
              now,
              -97.76,
              30.28,
              9500,
              false,
              200,
              90,
              0,
              null,
              null,
              null,
              false,
              0,
            ],
            [
              'aaa003',
              'GROUND3',
              'Fixture',
              now,
              now,
              -97.7431,
              30.2672,
              150,
              true,
              0,
              0,
              0,
              null,
              null,
              null,
              false,
              0,
            ],
          ],
        });
      if (path.pathname === '/api/military')
        return json({
          msg: 'No error',
          now: Date.now(),
          ac: [
            {
              hex: 'bbb101',
              flight: 'MIL101',
              lon: -97.75,
              lat: 30.27,
              alt_baro: 28000,
              track: 270,
              gs: 420,
              seen_pos: 0,
            },
          ],
        });
      if (path.pathname === '/api/flights/track') return json({ path: [] });
      if (path.pathname === '/api/military/track')
        return json({ timestamp: now, trace: [] });
      if (/^\/api\/adsbdb\//u.test(path.pathname)) return json({});
      return original(input, options);
    };
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(
    () =>
      window.__gevVoiceCommands?.runner && window.__godsEyeView?.dataManager,
    { timeout: 60000 },
  );
  const rows = await page.evaluate(async () => {
    const { runLocalTurn } = await import('/src/voice/localConversation.js');
    const { dataManager, viewer } = window.__godsEyeView;
    await window.__godsEyeView.styleManager.initialRestorePromise;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const runner = window.__gevVoiceCommands.runner;
    const rows = [];
    const run = async (text) => {
      const calls = [];
      const result = await runLocalTurn({
        text,
        signal: AbortSignal.timeout(45000),
        request: () => {
          throw new Error('Ordinary commands must not request model inference');
        },
        runAction: async (name, args, options) => {
          const result = await runner(name, args, options);
          calls.push({ name, args, result });
          return result;
        },
      });
      const row = {
        text,
        reply: result.text,
        calls,
        tracked: dataManager.layers.get('flights').module.getTrackedInfo()
          ?.icao24,
      };
      rows.push(row);
      return row;
    };
    await run('Останови слежение');
    await run('Покажи 30.2672, -97.7431');
    const before = viewer.camera.positionCartographic.height;
    const zoom = await run('Приблизь камеру немного');
    zoom.zoomChanged = viewer.camera.positionCartographic.height < before;
    await run('Выключи самолёты');
    await run('Следи за самолётом SYN001');
    await run('Останови слежение');
    await run('Покажи ближайший самолёт');
    await run('Следи за этим самолётом');
    await run('Follow flight UNKNOWN999999');
    await run('Follow military aircraft MIL101');
    await run('Останови слежение');
    await run('Включи самолёты и приблизь немного');
    return rows;
  });
  for (const row of rows) {
    if (row.text.includes('UNKNOWN')) {
      assert.equal(row.calls.at(-1).result.ok, false);
      assert.match(row.reply, /Could not/);
    } else {
      for (const call of row.calls)
        assert.equal(
          call.result?.ok,
          true,
          `${row.text}: ${JSON.stringify(call.result)}`,
        );
    }
  }
  assert.equal(
    rows.find((row) => row.text.includes('30.2672')).calls[0].result.arrived,
    true,
  );
  assert.equal(
    rows.find((row) => row.zoomChanged !== undefined).zoomChanged,
    true,
  );
  const specific = rows.find((row) => row.text === 'Следи за самолётом SYN001');
  assert.deepEqual(
    specific.calls.map((call) => call.name),
    ['set_layer_visibility', 'track_entity'],
  );
  assert.equal(specific.tracked, 'aaa001');
  const nearest = rows.find((row) => row.text === 'Покажи ближайший самолёт');
  assert.equal(nearest.calls.at(-1).name, 'select_nearest_aircraft');
  assert.ok(
    ['aaa001', 'aaa002'].includes(nearest.tracked),
    'Nearest contact must be airborne',
  );
  assert.equal(
    rows.find((row) => row.text === 'Следи за этим самолётом').tracked,
    nearest.tracked,
  );
  assert.equal(
    rows.find((row) => row.text.includes('MIL101')).calls.at(-1).result.layerId,
    'military',
  );
  console.log(
    JSON.stringify(
      {
        ok: true,
        scenarios: rows.length,
        rows: rows.map(({ text, reply, tracked }) => ({
          text,
          reply,
          tracked,
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
