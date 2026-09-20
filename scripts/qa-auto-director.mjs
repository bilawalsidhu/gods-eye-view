#!/usr/bin/env node
/**
 * Headless smoke for the voice Auto-Director: build a short tour from whatever
 * is loaded, play it through the SceneDirector and save it as a bundle.
 *
 *   QA_BASE_URL=http://127.0.0.1:4323 node scripts/qa-auto-director.mjs [seconds]
 */
import puppeteer from 'puppeteer';

const base = process.env.QA_BASE_URL || 'http://127.0.0.1:4323';
const seconds = Number(process.argv[2]) || 10;
const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
const errors = [];
const consoleErrors = [];
const speech = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  const text = message.text();
  if (text.startsWith('[speak]')) speech.push(text.slice(8));
  else if (message.type() === 'error') consoleErrors.push(text);
});
let failures = 0;
function check(name, passed, detail = '') {
  console.log(
    `[${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`,
  );
  if (!passed) failures++;
}
try {
  await page.setViewport({ width: 1280, height: 720 });
  await page.goto(`${base}/?welcome=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.sceneDirector &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: Number(process.env.QA_READY_TIMEOUT_MS) || 90000 },
  );
  if (process.env.QA_BASELINE) {
    // Attribution run: same page, same wait, no tour.
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 2000));
    console.log(
      JSON.stringify({ baseline: true, errors, consoleErrors }, null, 2),
    );
    await browser.close();
    process.exit(0);
  }
  // Boot-time errors (keyless API routes, headless WebGL) are attributed
  // before the tour starts; only errors raised during the tour count.
  const bootErrors = errors.length;
  const bootConsoleErrors = consoleErrors.length;
  const result = await page.evaluate(async (budget) => {
    const mod = await import('/src/voice/tools/director.js');
    const events = [];
    const director = window.__godsEyeView.sceneDirector;
    director.subscribe(
      ({ change }) => {
        if (change?.type === 'run-event') events.push(change.event);
      },
      { emitCurrent: false },
    );
    const handlers = mod.createHandlers({
      getGlobe: () => window.__godsEyeView,
      runner: null,
      memory: null,
      speak: (text) => console.log('[speak] ' + text),
    });
    const started = performance.now();
    const made = await handlers.make_tour({
      theme: 'airspace',
      seconds: budget,
    });
    const t0 = performance.now();
    let status = director.getPlaybackStatus();
    while (performance.now() - t0 < budget * 1000 + 15000) {
      status = director.getPlaybackStatus();
      if (!status.running && performance.now() - t0 > 1500) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const ranMs = Math.round(performance.now() - started);
    const scenes = director.listScenes().map((scene) => scene.id);
    const saved = await handlers.save_tour({ name: 'Smoke tour' });
    return {
      made,
      ranMs,
      events,
      status,
      scenes,
      saved,
      after: director.listScenes().map((scene) => scene.id),
    };
  }, seconds);
  console.log(JSON.stringify({ result, speech }, null, 2));
  check('make_tour ok', result.made?.ok === true, result.made?.error);
  check(
    'played through the Director',
    result.made?.mode === 'director',
    result.made?.mode,
  );
  check('auto-tour scene listed', result.scenes.includes('auto-tour'));
  check(
    'run started and finished',
    result.events.includes('scene_run_start') &&
      result.events.includes('scene_run_complete'),
    result.events.join(','),
  );
  check(
    'every shot narrated',
    speech.length === (result.made?.shots?.length || 0),
    `${speech.length}/${result.made?.shots?.length}`,
  );
  check(
    'run length near budget',
    result.ranMs >= seconds * 1000 - 500 &&
      result.ranMs < seconds * 1000 + 15000,
    `${result.ranMs} ms`,
  );
  check(
    'save_tour persisted',
    result.saved?.persisted === true &&
      result.after.includes('tour-smoke-tour'),
    JSON.stringify(result.saved),
  );
  check(
    'no page errors during the tour',
    errors.length === bootErrors,
    `${bootErrors} at boot; new: ${errors.slice(bootErrors).join(' | ')}`,
  );
  check(
    'no console errors during the tour',
    consoleErrors.length === bootConsoleErrors,
    `${bootConsoleErrors} at boot; new: ${consoleErrors.slice(bootConsoleErrors).join(' | ')}`,
  );
} catch (error) {
  const state = await page
    .evaluate(() => ({
      ready: document.readyState,
      globe: !!window.__godsEyeView,
      director: !!window.__godsEyeView?.sceneDirector,
      loading: document.getElementById('loading-screen')?.className ?? null,
      loadingText:
        document
          .getElementById('loading-screen')
          ?.textContent?.trim()
          .slice(0, 200) ?? null,
    }))
    .catch(() => null);
  check(
    'smoke completed',
    false,
    `${error.message} ${JSON.stringify({ state, errors, consoleErrors: consoleErrors.slice(0, 5) })}`,
  );
} finally {
  await browser.close();
}
process.exit(failures ? 1 : 0);
