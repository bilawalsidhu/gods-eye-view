#!/usr/bin/env node
/** Real pointer/keyboard acceptance using a synthetic, self-authored feature pack. */
import fs from 'node:fs';
import puppeteer from 'puppeteer';
const output = 'qa-shots/director-interactions';
fs.mkdirSync(output, { recursive: true });
const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
let failures = 0;
const errors = [];
const check = (name, ok) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (!ok) failures++;
};
page.on('pageerror', (e) => errors.push(e.message));
await page.setRequestInterception(true);
page.on('request', (request) => {
  if (new URL(request.url()).pathname === '/scene-assets/qa/actions.json')
    void request
      .respond({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              id: 'point',
              geometry: { type: 'Point', coordinates: [-97.742, 30.2672, 600] },
            },
          ],
        }),
      })
      .catch(() => {});
  else void request.continue().catch(() => {});
});
const action = (id) => `[data-director-action="${id}"]`;
const load = () =>
  page.evaluate(() =>
    window.__godsEyeView.sceneDirector.loadShot('interactive', 'one', {
      flyDuration: 0.2,
    }),
  );
try {
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(
    `${process.env.QA_BASE_URL || 'http://localhost:4173'}/?welcome=0`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.sceneDirector &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 60000 },
  );
  await page.evaluate(async () => {
    const d = window.__godsEyeView.sceneDirector;
    const camera = {
      lat: 30.2672,
      lon: -97.742,
      alt: 4000,
      heading: 0,
      pitch: -90,
      roll: 0,
      altitudeReference: 'ellipsoid',
    };
    const target = { packId: 'data', featureId: 'point' };
    const interaction = (id, label, action) => ({ id, label, target, action });
    window.__interactionProject = {
      version: 6,
      scenes: [
        {
          id: 'interactive',
          title: 'Interactive fixture',
          anchors: [
            {
              id: 'view',
              lat: 30.27,
              lon: -97.74,
              alt: 5000,
              altitudeReference: 'ellipsoid',
            },
          ],
          dataPacks: [
            {
              id: 'data',
              version: 1,
              format: 'geojson',
              source: { adapter: 'assets', path: 'qa/actions.json' },
              attribution: { text: 'Synthetic fixture', license: 'CC0-1.0' },
              placement: { altitudeReference: 'ellipsoid' },
            },
          ],
          shots: [
            {
              id: 'one',
              title: 'Choose an action',
              camera,
              durationSec: 0.2,
              holdSec: 0,
              move: {
                from: { ...camera, alt: 4100, altitudeReference: 'ellipsoid' },
                easing: 'linear',
              },
              visual: { style: 'normal', mapStack: 'photoreal' },
              layers: { traffic: false },
              dataPackIds: ['data'],
              interactions: [
                interaction('card', 'Read source', {
                  type: 'card',
                  text: '<b>Plain text only</b>',
                  url: 'https://example.org/source',
                }),
                interaction('focus', 'Focus anchor', {
                  type: 'focus',
                  anchorId: 'view',
                }),
                interaction('layer', 'Show traffic', {
                  type: 'layer',
                  layerId: 'traffic',
                  enabled: true,
                }),
                interaction('next', 'Next shot', {
                  type: 'shot',
                  shotId: 'two',
                }),
              ],
            },
            {
              id: 'two',
              title: 'Next',
              camera: { ...camera, heading: 30 },
              durationSec: 0.2,
              holdSec: 0,
              layers: { traffic: false },
            },
          ],
        },
      ],
    };
    await d.importProjectFile(
      new File([JSON.stringify(window.__interactionProject)], 'actions.json'),
    );
  });
  check(
    'import installs no action handlers or UI',
    await page.evaluate(
      () =>
        !window.__godsEyeView.sceneDirector.getInteractionState().active &&
        !document.querySelector('[data-director-interactions]'),
    ),
  );
  await load();
  check(
    'settled LOAD activates four actions',
    await page.evaluate(
      () =>
        window.__godsEyeView.sceneDirector.getInteractionState().count === 4,
    ),
  );
  await page.waitForFunction(
    () => window.__godsEyeView.tileset?.tilesLoaded === true,
    { timeout: 60000 },
  );
  await new Promise((r) => setTimeout(r, 2000));
  const point = await page.evaluate(async () => {
    const d = window.__godsEyeView.sceneDirector;
    const entity = d.viewer.entities.values.find(
      (e) => e.name === 'data / point',
    );
    const pos = entity.position.getValue(d.viewer.clock.currentTime);
    const screen = d.viewer.scene.cartesianToCanvasCoordinates(pos);
    const rect = d.viewer.scene.canvas.getBoundingClientRect();
    return { x: screen.x + rect.left, y: screen.y + rect.top };
  });
  await page.mouse.click(point.x, point.y);
  check(
    'real globe pick selects the feature and focuses its keyboard action',
    await page.evaluate(
      () =>
        document.activeElement?.dataset.directorAction === 'card' &&
        document
          .querySelector('[data-director-interactions] [role=status]')
          .textContent.includes('point'),
    ),
  );
  await page.keyboard.press('Enter');
  check(
    'Enter shows literal text and a safe source link',
    await page.evaluate(() => {
      const card = document.querySelector('[data-director-action-card]');
      return (
        card?.textContent.includes('<b>Plain text only</b>') &&
        !card.querySelector('b') &&
        card.querySelector('a')?.rel === 'noopener noreferrer'
      );
    }),
  );
  await page.screenshot({ path: `${output}/selected.png` });
  fs.writeFileSync(
    `${output}/report.json`,
    JSON.stringify(
      await page.evaluate(() => ({
        tilesSettled: window.__godsEyeView.tileset?.tilesLoaded === true,
      })),
      null,
      2,
    ),
  );
  await page.keyboard.press('Tab');
  await page.keyboard.press('Space');
  check(
    'Tab/Space focuses the authored anchor through camera ownership',
    await page.evaluate(
      () =>
        Math.abs(
          window.__godsEyeView.sceneDirector.viewer.camera.positionCartographic
            .height - 5000,
        ) < 1,
    ),
  );
  await page.screenshot({ path: `${output}/anchor.png` });
  const sourceBase = process.env.QA_SOURCE_BASE || '/src';
  // Resolve ownership from the same module graph as the active application.
  await page.evaluate(async (base) => {
    window.__inputOwner = await import(`${base}/data/inputOwnership.js`);
    window.__lease = window.__inputOwner.claimPointer('qa-draw');
  }, sourceBase);
  await page.click(action('card'));
  check(
    'drawing ownership refuses actions',
    await page.evaluate(() =>
      document
        .querySelector('[data-director-interactions] [role=status]')
        .textContent.includes('unavailable'),
    ),
  );
  await page.evaluate(() => window.__inputOwner.releasePointer(window.__lease));
  // Hold the actual manager admission call to exercise Stop before an enable settles.
  await page.evaluate(() => {
    const d = window.__godsEyeView.sceneDirector,
      m = d.dataManager;
    window.__originalEnable = m.setEnabled;
    m.setEnabled = function (id, enabled, options) {
      if (id !== 'traffic' || !enabled)
        return window.__originalEnable.call(this, id, enabled, options);
      window.__actionSignal = options.signal;
      return new Promise((resolve) => {
        window.__lateAction = () => resolve(true);
        options.signal.addEventListener('abort', () => resolve(false), {
          once: true,
        });
      });
    };
  });
  await page.click(action('layer'));
  await page.waitForFunction(() => window.__actionSignal);
  await page.evaluate(() => window.__godsEyeView.sceneDirector.stopScene());
  check(
    'Stop aborts pending layer admission and removes handlers/cards/selection',
    await page.evaluate(
      () =>
        window.__actionSignal.aborted &&
        !window.__godsEyeView.sceneDirector.getInteractionState().active &&
        !document.querySelector('[data-director-interactions]'),
    ),
  );
  await page.evaluate(() => {
    window.__lateAction();
    window.__godsEyeView.sceneDirector.dataManager.setEnabled =
      window.__originalEnable;
  });
  await load();
  await page.evaluate(() =>
    window.__godsEyeView.sceneDirector.seekScene('interactive', 0.1),
  );
  check(
    'same-shot seek restores pack geometry and resets action state',
    await page.evaluate(
      () =>
        window.__godsEyeView.sceneDirector.getInteractionState().count === 4 &&
        window.__godsEyeView.sceneDirector.getInteractionState().selected ===
          null &&
        window.__godsEyeView.sceneDirector.getDataPackState().count === 1,
    ),
  );
  await page.evaluate(() => {
    window.__oldActionButton = document.querySelector(
      '[data-director-action=card]',
    );
  });
  await page.click(action('next'));
  await page.waitForFunction(
    () => window.__godsEyeView.sceneDirector._selectedShotId === 'two',
  );
  check(
    'explicit shot transition replaces resources and removes actions',
    await page.evaluate(
      () =>
        !window.__godsEyeView.sceneDirector.getInteractionState().active &&
        window.__godsEyeView.sceneDirector.getDataPackState().count === 0,
    ),
  );
  await load();
  await page.evaluate(() => window.__oldActionButton.click());
  check(
    'detached buttons cannot invoke replacement actions with the same ID',
    await page.evaluate(
      () =>
        window.__godsEyeView.sceneDirector.getInteractionState().selected ===
          null &&
        !document.querySelector('[data-director-action-card]').textContent,
    ),
  );
  await page.evaluate(() => {
    window.__godsEyeView.sceneDirector._interactionTransitions = 64;
  });
  await page.click(action('next'));
  check(
    'bounded transition chain cannot take another branch',
    await page.evaluate(
      () => window.__godsEyeView.sceneDirector._selectedShotId === 'one',
    ),
  );
  await load();
  await page.evaluate(async () => {
    const p = structuredClone(window.__interactionProject);
    p.scenes[0].shots[0].interactions[0].target.featureId = 'missing';
    const d = window.__godsEyeView.sceneDirector;
    await d.importProjectFile(new File([JSON.stringify(p)], 'missing.json'));
    await d.loadShot('interactive', 'one', { flyDuration: 0.2 });
  });
  check(
    'unknown loaded feature refuses the whole action set',
    await page.evaluate(
      () =>
        !window.__godsEyeView.sceneDirector.getInteractionState().active &&
        !document.querySelector('[data-director-interactions]'),
    ),
  );
  await page.evaluate(async () => {
    const d = window.__godsEyeView.sceneDirector;
    await d.importProjectFile(
      new File([JSON.stringify(window.__interactionProject)], 'restore.json'),
    );
    await d.loadShot('interactive', 'one', { flyDuration: 0.2 });
    await d.destroy();
  });
  check(
    'teardown releases interactive resources',
    await page.evaluate(
      () =>
        window.__godsEyeView.sceneDirector.getInteractionState().count === 0 &&
        !document.querySelector('[data-director-interactions]'),
    ),
  );
  check('no uncaught browser errors', errors.length === 0);
} finally {
  await browser.close();
}
process.exitCode = failures ? 1 : 0;
