#!/usr/bin/env node
/** Sharing/authoring acceptance with local synthetic assets and real installed controls. */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
const output = path.resolve('qa-shots/director-sharing');
fs.mkdirSync(output, { recursive: true });
const geometry = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'point',
      geometry: { type: 'Point', coordinates: [-97.742, 30.2672, 500] },
    },
  ],
};
fs.writeFileSync(path.join(output, 'data.geojson'), JSON.stringify(geometry));
const camera = {
  lat: 30.2672,
  lon: -97.742,
  alt: 4000,
  heading: 0,
  pitch: -90,
  roll: 0,
};
const project = {
  version: 6,
  scenes: [
    {
      id: 'share',
      title: 'Sharing fixture',
      dataPacks: [
        {
          id: 'data',
          version: 1,
          format: 'geojson',
          source: { adapter: 'assets', path: 'example/data.geojson' },
          attribution: { text: 'Synthetic <b>fixture</b>', license: 'CC0-1.0' },
          placement: { altitudeReference: 'ellipsoid' },
        },
      ],
      shots: [
        {
          id: 'shot',
          title: 'First',
          camera,
          durationSec: 0.3,
          holdSec: 0,
          visual: { style: 'normal', mapStack: 'photoreal' },
          layers: {},
          dataPackIds: ['data'],
          interactions: [
            {
              id: 'info',
              label: 'Read fixture',
              target: { packId: 'data', featureId: 'point' },
              action: { type: 'card', text: 'Synthetic scene note' },
            },
          ],
        },
      ],
    },
    { id: 'second', title: 'Other scene', shots: [] },
  ],
};
const file = path.join(output, 'project.json');
fs.writeFileSync(file, JSON.stringify(project));
const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
let failures = 0;
const errors = [],
  requests = [];
const check = (name, ok) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (!ok) failures++;
};
page.on('pageerror', (e) => errors.push(e.message));
page.on('request', (r) => {
  if (new URL(r.url()).pathname.startsWith('/scene-assets/'))
    requests.push(r.url());
});
async function click(label) {
  const handle = await page.evaluateHandle(
    (label) =>
      [...document.querySelectorAll('button')].find(
        (b) => b.textContent === label,
      ),
    label,
  );
  await handle.asElement().click();
  await handle.dispose();
}
async function value(label, text) {
  await page.$eval(
    `[aria-label="${label}"]`,
    (node, text) => {
      node.value = text;
      node.dispatchEvent(new Event('input', { bubbles: true }));
    },
    text,
  );
}
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
  await page.click('[data-collapse-target="scene-panel"]');
  const before = await page.evaluate(() =>
    JSON.stringify(window.__godsEyeView.sceneDirector._project),
  );
  const input = await page.$('#scene-import-file');
  await input.uploadFile(file);
  await page.waitForSelector('[data-director-apply-import]');
  check(
    'preview parses metadata without acquiring assets or replacing the current project',
    requests.length === 0 &&
      (await page.evaluate(
        (before) =>
          JSON.stringify(window.__godsEyeView.sceneDirector._project) ===
          before,
        before,
      )),
  );
  check(
    'preview renders author attribution as literal text',
    await page.evaluate(
      () =>
        document
          .querySelector('[data-director-dialog]')
          .textContent.includes('Synthetic <b>fixture</b>') &&
        !document.querySelector('[data-director-dialog] b'),
    ),
  );
  await page.keyboard.press('Escape');
  check(
    'Escape cancels preview without altering saved work',
    await page.evaluate(
      (before) =>
        !document.querySelector('[data-director-dialog]') &&
        JSON.stringify(window.__godsEyeView.sceneDirector._project) === before,
      before,
    ),
  );
  await input.uploadFile(file);
  await page.waitForSelector('[data-director-apply-import]');
  await page.click('[data-director-apply-import]');
  await page.waitForFunction(
    () => !document.querySelector('[data-director-dialog]'),
  );
  check(
    'Apply import replaces metadata but does not start playback or fetch a pack',
    requests.length === 0 &&
      (await page.evaluate(
        () =>
          window.__godsEyeView.sceneDirector._project.scenes.length === 2 &&
          !window.__godsEyeView.sceneDirector.running,
      )),
  );
  await click('EDIT DETAILS');
  await click('Capture camera as anchor');
  await page.waitForFunction(() =>
    document
      .querySelector('[data-director-dialog] [role=status]')
      .textContent.includes('Anchor added'),
  );
  await click('Set move start to current camera');
  await page.waitForFunction(() =>
    document
      .querySelector('[data-director-dialog] [role=status]')
      .textContent.includes('Move added'),
  );
  const draft = await page.$eval(
    '[aria-label="Shot camera, timing, packs and actions"]',
    (n) => n.value,
  );
  const bad = JSON.parse(draft);
  bad.camera.lat = 91;
  await value('Shot camera, timing, packs and actions', JSON.stringify(bad));
  const saved = await page.evaluate(() =>
    localStorage.getItem('godsEyeView.sceneProject.v2'),
  );
  await page.click('[data-director-apply-details]');
  await page.waitForFunction(() =>
    document
      .querySelector('[data-director-dialog] [role=status]')
      .textContent.includes('camera.lat'),
  );
  check(
    'invalid draft preserves saved bytes and existing authored content',
    await page.evaluate(
      (saved) => localStorage.getItem('godsEyeView.sceneProject.v2') === saved,
      saved,
    ),
  );
  await value('Shot camera, timing, packs and actions', draft);
  await page.click('[data-director-apply-details]');
  await page.waitForFunction(
    () => !document.querySelector('[data-director-dialog]'),
  );
  check(
    'author controls preserve selected shot, pack attribution and action definitions',
    await page.evaluate(() => {
      const d = window.__godsEyeView.sceneDirector,
        s = d._getSelectedScene();
      return (
        d._selectedShotId === 'shot' &&
        s.anchors.length === 1 &&
        s.shots[0].move.easing === 'cubic-in-out' &&
        s.shots[0].interactions.length === 1 &&
        s.dataPacks[0].attribution.license === 'CC0-1.0'
      );
    }),
  );
  await page.evaluate(() => {
    window.__shareExports = [];
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      if (blob.type === 'application/json')
        window.__shareExports.push(blob.text());
      return create(blob);
    };
  });
  await click('SHARE SCENE');
  await click('Download scene JSON');
  const exported = await page.evaluate(async () =>
    JSON.parse(await window.__shareExports.at(-1)),
  );
  check(
    'scene JSON exports only the selected scene and keeps its credit',
    exported.scenes.length === 1 &&
      exported.scenes[0].dataPacks[0].attribution.license === 'CC0-1.0',
  );
  await click('Download asset bundle');
  await page.waitForFunction(() =>
    document
      .querySelector('[data-director-dialog] [role=status]')
      .textContent.includes('Could not complete'),
  );
  check(
    'missing explicit files produce no partial download or network fallback',
    requests.length === 0 &&
      (await page.evaluate(() => window.__shareExports.length === 1)),
  );
  const files = await page.$('[aria-label="Choose data-pack files"]');
  await files.uploadFile(path.join(output, 'data.geojson'));
  await click('Download asset bundle');
  await page.waitForFunction(
    () =>
      document.querySelector('[data-director-dialog] [role=status]')
        .textContent === 'Asset bundle downloaded',
  );
  const bundle = await page.evaluate(
    async () => await window.__shareExports.at(-1),
  );
  const bundleFile = path.join(output, 'scene.gevbundle.json');
  fs.writeFileSync(bundleFile, bundle);
  check(
    'bundle contains the selected bytes and preserves attribution',
    JSON.parse(bundle).assets.length === 1 &&
      JSON.parse(bundle).project.scenes[0].dataPacks[0].attribution.license ===
        'CC0-1.0',
  );
  await page.keyboard.press('Escape');
  await input.uploadFile(bundleFile);
  await page.waitForSelector('[data-director-apply-import]');
  check(
    'bundle preview verifies bytes and explains session-only storage',
    await page.evaluate(
      () =>
        document
          .querySelector('[data-director-dialog]')
          .textContent.includes('bundled bytes verified') &&
        window.__godsEyeView.sceneDirector.getSharingState().assets.count === 0,
    ),
  );
  await page.screenshot({ path: path.join(output, 'preview.png') });
  await page.click('[data-director-apply-import]');
  await page.waitForFunction(
    () => !document.querySelector('[data-director-dialog]'),
  );
  await page.evaluate(() =>
    window.__godsEyeView.sceneDirector.loadShot('share', 'shot', {
      flyDuration: 0.3,
    }),
  );
  check(
    'imported bundle renders and enables feature actions with zero asset requests',
    requests.length === 0 &&
      (await page.evaluate(
        () =>
          window.__godsEyeView.sceneDirector.getDataPackState().count === 1 &&
          window.__godsEyeView.sceneDirector.getInteractionState().count === 1,
      )),
  );
  await page.waitForFunction(
    () => window.__godsEyeView.tileset?.tilesLoaded === true,
    { timeout: 60000 },
  );
  await page.screenshot({ path: path.join(output, 'rendered.png') });
  fs.writeFileSync(
    path.join(output, 'report.json'),
    JSON.stringify(
      await page.evaluate(() => ({
        tilesSettled: window.__godsEyeView.tileset?.tilesLoaded === true,
      })),
    ),
  );
  await page.evaluate(() => window.__godsEyeView.sceneDirector.stopScene());
  check(
    'Stop releases rendered resources while retaining reusable project bytes',
    await page.evaluate(() => {
      const d = window.__godsEyeView.sceneDirector;
      return (
        d.getDataPackState().count === 0 &&
        d.getSharingState().assets.count === 1
      );
    }),
  );
  await page.evaluate(() =>
    window.__godsEyeView.sceneDirector.seekScene('share', 0),
  );
  check(
    'seek reloads the bundle without a network fallback',
    requests.length === 0 &&
      (await page.evaluate(
        () => window.__godsEyeView.sceneDirector.getDataPackState().count === 1,
      )),
  );
  await click('EDIT DETAILS');
  await page.evaluate(() => {
    window.__godsEyeView.sceneDirector._project.scenes[0].title = 'Newer edit';
  });
  await page.click('[data-director-apply-details]');
  check(
    'stale author draft cannot overwrite a newer edit',
    await page.evaluate(
      () =>
        window.__godsEyeView.sceneDirector._project.scenes[0].title ===
        'Newer edit',
    ),
  );
  await page.keyboard.press('Escape');
  await click('SHARE SCENE');
  await page.setViewport({ width: 390, height: 844 });
  check(
    'modal remains within a narrow viewport',
    await page.$eval('[data-director-dialog]', (n) => {
      const r = n.getBoundingClientRect();
      return (
        r.left >= 0 &&
        r.right <= innerWidth &&
        r.top >= 0 &&
        r.bottom <= innerHeight
      );
    }),
  );
  await page.screenshot({ path: path.join(output, 'narrow.png') });
  await page.keyboard.press('Escape');
  const pending = await page.evaluate(async () => {
    const d = window.__godsEyeView.sceneDirector;
    let finish;
    const work = d._sharing.preview({
      name: 'pending.json',
      text: () => new Promise((r) => (finish = r)),
    });
    d._sharing.close();
    await work;
    finish(JSON.stringify({ version: 6, scenes: [] }));
    return !d.getSharingState().open;
  });
  check(
    'cancel settles a pending file read and suppresses its late completion',
    pending,
  );
  const cancelledApply = await page.evaluate(async () => {
    const d = window.__godsEyeView.sceneDirector;
    const before = JSON.stringify(d._project);
    const saved = JSON.stringify({ ...localStorage });
    let finish;
    const pendingWork = new Promise((resolve) => (finish = resolve));
    d._pendingWork.add(pendingWork);
    const owner = new AbortController();
    const work = d.importProjectFile(
      { name: 'cancelled.json' },
      {
        prepared: { project: { version: 6, scenes: [] }, assets: new Map() },
        expectedProject: JSON.stringify(d._project, null, 2),
        signal: owner.signal,
      },
    );
    owner.abort();
    finish();
    const applied = await work;
    d._pendingWork.delete(pendingWork);
    return (
      applied === false &&
      JSON.stringify(d._project) === before &&
      JSON.stringify({ ...localStorage }) === saved &&
      d.getSharingState().assets.count === 1
    );
  });
  check(
    'cancelling Apply during pending scene cleanup preserves saved project and bundle bytes',
    cancelledApply,
  );
  await click('EDIT DETAILS');
  await page.evaluate(() => {
    const fields = [
      ...document.querySelectorAll('[data-director-dialog] textarea'),
    ];
    const scene = JSON.parse(fields[0].value),
      shot = JSON.parse(fields[1].value);
    scene.dataPacks = [];
    shot.dataPackIds = [];
    shot.interactions = [];
    fields[0].value = JSON.stringify(scene);
    fields[1].value = JSON.stringify(shot);
  });
  await page.click('[data-director-apply-details]');
  await page.waitForFunction(
    () => !document.querySelector('[data-director-dialog]'),
  );
  check(
    'removing a pack through authoring releases its retained bytes',
    await page.evaluate(
      () =>
        window.__godsEyeView.sceneDirector.getSharingState().assets.count === 0,
    ),
  );
  await page.evaluate(
    (text) =>
      window.__godsEyeView.sceneDirector.importProjectFile(
        new File([text], 'again.gevbundle.json'),
      ),
    bundle,
  );
  await page.evaluate(() =>
    window.__godsEyeView.sceneDirector.importProjectFile(
      new File([JSON.stringify({ version: 6, scenes: [] })], 'empty.json'),
    ),
  );
  check(
    'replacement releases stored bundle bytes',
    await page.evaluate(
      () =>
        window.__godsEyeView.sceneDirector.getSharingState().assets.count === 0,
    ),
  );
  await page.evaluate(async () => {
    const d = window.__godsEyeView.sceneDirector;
    void d._sharing.preview({
      name: 'pending.json',
      text: () => new Promise(() => {}),
    });
    await d.destroy();
  });
  check(
    'teardown removes pending dialogs and authoring controls',
    await page.evaluate(
      () =>
        !document.querySelector('[data-director-dialog]') &&
        !document.querySelector('[data-director-authoring]') &&
        !window.__godsEyeView.sceneDirector.getSharingState().open,
    ),
  );
  check('no uncaught browser errors', errors.length === 0);
} finally {
  await browser.close();
}
process.exitCode = failures ? 1 : 0;
