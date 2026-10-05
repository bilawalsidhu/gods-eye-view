#!/usr/bin/env node
// Composed-app media policy/lifecycle checks. Pinokio UA is a policy fixture,
// not native-host acceptance; the YouTube SDK clock below is deterministic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const output = path.resolve(
  process.env.QA_OUTPUT_DIR || 'qa-shots/nepal-media',
);
fs.mkdirSync(output, { recursive: true });
const browser = await puppeteer.launch({
  headless: process.env.QA_HEADFUL !== '1',
  args: process.env.QA_HEADFUL === '1' ? ['--use-angle=metal'] : [],
});
let assertions = 0;
const check = (name, value) => {
  assert.ok(value, name);
  assertions++;
  console.log(`[PASS] ${name}`);
};
try {
  for (const pinokio of [true, false]) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    if (pinokio)
      await page.setUserAgent((await browser.userAgent()) + ' Pinokio/8.0.40');
    const popups = [];
    page.on('popup', (popup) => popups.push(popup.url()));
    // Do not depend on provider availability to prove our startup/trim/exit handoff.
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (/youtube(?:-nocookie)?\.com\/embed\//.test(request.url())) {
        void request.respond({
          status: 200,
          contentType: 'text/html',
          body: '<p>Player clock fixture</p>',
        });
      } else void request.continue();
    });
    await page.evaluateOnNewDocument(() => {
      window.__mediaFixture = { starts: [], stops: [] };
      window.YT = {
        Player: class {
          constructor(_frame, { events }) {
            this.events = events;
            this.began = null;
            this.stoppedAt = null;
            this.timer = setTimeout(
              () => events.onReady({ target: this }),
              1200,
            );
          }
          mute() {}
          playVideo() {
            if (this.began != null) return;
            this.began = Date.now();
            window.__mediaFixture.starts.push(this.began);
            this.events.onStateChange({ target: this, data: 1 });
          }
          getCurrentTime() {
            return this.began == null
              ? 0
              : ((this.stoppedAt || Date.now()) - this.began) / 1000;
          }
          getPlayerState() {
            return this.began == null ? -1 : this.stoppedAt ? 2 : 1;
          }
          pauseVideo() {
            if (this.began != null && !this.stoppedAt) {
              this.stoppedAt = Date.now();
              window.__mediaFixture.stops.push(this.getCurrentTime());
            }
          }
          destroy() {
            clearTimeout(this.timer);
            this.pauseVideo();
          }
        },
      };
    });
    await page.goto(
      `${process.env.QA_BASE_URL || 'http://localhost:4173'}/?welcome=0`,
      { waitUntil: 'domcontentloaded' },
    );
    await page.waitForFunction(
      () =>
        window.__godsEyeView?.sceneDirector &&
        document.querySelector('#loading-screen')?.classList.contains('hidden'),
      { timeout: 60000 },
    );
    const result = await page.evaluate(async (pinokio) => {
      const d = window.__godsEyeView.sceneDirector;
      const scene = d._project.scenes.find((s) => /Nepal/.test(s.title));
      const shot = scene.shots.find((s) => /Mailung Bazzar/.test(s.title));
      const following = scene.shots[scene.shots.indexOf(shot) + 1];
      const previous = scene.shots[scene.shots.indexOf(shot) - 1];
      const frames = () =>
        [...document.querySelectorAll('iframe')].map((f) => f.src);
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      await d.loadShot(scene.id, scene.shots[0].id, { flyDuration: 0.1 });
      const openingFrames = frames();
      await d.loadShot(scene.id, shot.id, { flyDuration: 0.1 });
      const passiveFrames = frames();
      const started = Date.now();
      const run = d.startScene(scene.id, {
        single: true,
        afterShotId: previous.id,
        preview: false,
      });
      let advanced = null;
      while (Date.now() - started < 25000) {
        if (d._selectedShotId === following.id) {
          advanced = Date.now() - started;
          break;
        }
        if (!d.running) break;
        await sleep(100);
      }
      const runningAtAdvance = d.running;
      const clipStops = [...window.__mediaFixture.stops];
      const status = document.querySelector('#scene-status')?.textContent;
      d.stopScene();
      await run;
      await sleep(250);
      const stoppedFrames = frames();
      let replayAutoplay = false;
      let replacementSilent = false;
      if (!pinokio) {
        await d.replayShot(scene.id, shot.id);
        replayAutoplay = frames().some((src) => /autoplay=1/.test(src));
        await d.loadShot(scene.id, scene.shots[0].id, { flyDuration: 0.1 });
        const starts = window.__mediaFixture.starts.length;
        await sleep(1600);
        replacementSilent =
          frames().length === 0 &&
          starts === window.__mediaFixture.starts.length;
      }
      const gl = d.viewer.scene.context._gl;
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        openingFrames,
        passiveFrames,
        advanced,
        runningAtAdvance,
        status,
        clipStops,
        stoppedFrames,
        replayAutoplay,
        replacementSilent,
        renderer: info
          ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL)
          : gl.getParameter(gl.RENDERER),
      };
    }, pinokio);
    console.log(JSON.stringify({ pinokioPolicyFixture: pinokio, ...result }));
    check(
      'opening shot creates no unrelated provider frames',
      result.openingFrames.length === 0,
    );
    check(
      'passive LOAD never requests autoplay',
      result.passiveFrames.every((src) => !/autoplay=1/.test(src)),
    );
    check(
      'actual next-shot identity reached while scene remains running',
      result.advanced > 0 && result.runningAtAdvance,
    );
    check('no scene timeout', !/timed out|Error:/i.test(result.status || ''));
    check('Stop removes provider resources', result.stoppedFrames.length === 0);
    check('no automatic external window', popups.length === 0);
    if (pinokio) {
      check(
        'suppressed providers allocate no iframe',
        result.passiveFrames.length === 0,
      );
      check(
        'fallback keeps authored dwell',
        result.advanced >= 7500 && result.advanced < 18000,
      );
    } else {
      check(
        'supported clip follows seven-second source clock',
        result.clipStops.some((sec) => sec >= 7 && sec < 7.6),
      );
      check(
        'explicit Play Shot still requests autoplay',
        result.replayAutoplay,
      );
      check(
        'replacement disowns pending player startup',
        result.replacementSilent,
      );
    }
    await page.screenshot({
      path: path.join(output, pinokio ? 'pinokio-policy.png' : 'chrome.png'),
    });
    await page.close();
  }
  console.log(`PASS: ${assertions} assertions`);
} finally {
  await browser.close();
}
