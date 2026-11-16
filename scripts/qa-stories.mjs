/** Run against the built app's preview server (QA_BASE_URL, port 4173 by default). */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.emulateMediaFeatures([
    { name: 'prefers-reduced-motion', value: 'reduce' },
  ]);
  const url = new URL(process.env.QA_BASE_URL || 'http://localhost:4173/');
  url.searchParams.set('welcome', '0');
  url.searchParams.set('story', 'gev:flights-radar');
  url.searchParams.set('storyTime', '1250');
  url.hash =
    'v=2&lat=20&lon=10&alt=2500000&heading=0&pitch=-90&roll=0&style=normal&map=esri-imagery';
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });

  async function waitForPausedStory() {
    await page.waitForSelector('#tlTrack', { visible: true, timeout: 60000 });
    await page.waitForFunction(
      () => window.__godsEyeView?.styleManager.activeStyle === 'retro',
      { timeout: 30000 },
    );
    const timing = await page.evaluate(async () => {
      const director = window.__godsEyeView.sceneDirector;
      await director.whenIdle();
      return {
        elapsed: director.getPlaybackTimingState().snapshot.sceneElapsedSec,
        running: director.running,
      };
    });
    assert.equal(timing.running, false);
    assert.ok(Math.abs(timing.elapsed - 1.25) < 0.001);
  }

  await waitForPausedStory();
  await page.evaluate(() => history.back());
  await page.waitForSelector('#scrExplore', { visible: true });
  await page.waitForFunction(
    () => window.__godsEyeView.styleManager.activeStyle === 'normal',
  );
  await page.evaluate(() => history.forward());
  await waitForPausedStory();
  await page.waitForFunction(() =>
    document.activeElement.matches(
      '#scrStory .s-back, #scrStory .s-trail button',
    ),
  );
  console.log('Back and Forward restore the style, paused time and focus');

  await page.click('#tlPlay');
  const resumedAt = await (
    await page.waitForFunction(
      () => {
        const snap =
          window.__godsEyeView.sceneDirector.getPlaybackTimingState().snapshot;
        return snap?.running ? snap.sceneElapsedSec : false;
      },
      { timeout: 30000 },
    )
  ).jsonValue();
  assert.ok(
    resumedAt >= 1.25 && resumedAt < 3,
    `Play went on from ${resumedAt} s, not the paused 1.25 s`,
  );
  await page.click('#tlPlay');
  await page.waitForFunction(() => !window.__godsEyeView.sceneDirector.running);
  await page.evaluate(() => window.__godsEyeView.sceneDirector.whenIdle());
  console.log('Play goes on from the paused time, not the start of the shot');

  const track = await page.$('#tlTrack');
  const box = await track.boundingBox();
  assert.ok(box.width > 0);
  await page.evaluate(() => {
    const director = window.__godsEyeView.sceneDirector;
    const seek = director.seekScene.bind(director);
    window.qaSeekProgress = [];
    director.seekScene = (...args) => {
      window.qaSeekProgress.push(args[1]);
      return seek(...args);
    };
  });
  const y = box.y + box.height / 2;
  const at = (fraction) => box.x + box.width * fraction;
  await page.mouse.move(at(0.25), y);
  await page.mouse.down();
  await page.mouse.move(at(0.65), y, { steps: 12 });
  await page.waitForFunction(
    () =>
      Number(document.querySelector('#tlTrack').getAttribute('aria-valuenow')) >
      25,
  );
  assert.deepEqual(await page.evaluate(() => window.qaSeekProgress), []);
  await page.mouse.up();
  await page.waitForFunction(() => window.qaSeekProgress.length === 1);
  await page.evaluate(() => window.__godsEyeView.sceneDirector.whenIdle());
  assert.equal(await page.evaluate(() => window.qaSeekProgress.length), 1);
  console.log('A timeline drag updates the preview before one released seek');

  const pose = () =>
    page.evaluate(() => window.__godsEyeView.styleManager.getCameraState());
  const before = await pose();
  await page.click('#railGev');
  await page.waitForFunction(
    () =>
      !document.body.classList.contains('stories-mode') &&
      document
        .querySelector('#scene-select option:checked')
        ?.textContent.includes('Global Flights Radar'),
  );
  const after = await pose();
  assert.ok(Math.abs(after.lat - before.lat) < 0.01);
  assert.ok(Math.abs(after.lon - before.lon) < 0.01);
  assert.ok(Math.abs(after.alt - before.alt) < 100);
  await page.waitForFunction(() => document.activeElement.id === 'hStories');
  console.log('Open in GEV selects the scene without moving its camera');
  await page.click('#scene-thumb-btn');
  await page.waitForFunction(() =>
    document
      .querySelector('#scene-thumb-preview')
      ?.src.startsWith('data:image/jpeg;'),
  );
  console.log('Authoring captures an Esri thumbnail through the real renderer');

  // This width is within GEV's phone layout and used to miss Stories' layout.
  await page.setViewport({ width: 710, height: 844 });
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await waitForPausedStory();
  await page.waitForFunction(() =>
    document.activeElement.matches('#scrStory .s-back'),
  );
  console.log('The phone layout uses the same breakpoint as GEV');
} finally {
  await browser.close();
}
