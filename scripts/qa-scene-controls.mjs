#!/usr/bin/env node
/** Exercise installed Scene controls and real project/playback operations. */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const shots = path.resolve('qa-shots/scene-controls');
fs.mkdirSync(shots, { recursive: true });
const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
  ],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
let promptValue = 'QA Scene';
page.on('dialog', async (dialog) => {
  await dialog.accept(dialog.type() === 'prompt' ? promptValue : undefined);
});
let failures = 0;
function check(name, ok) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (!ok) failures++;
}
try {
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(
    `${process.env.QA_BASE_URL || 'http://localhost:4173'}/?welcome=0`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.sceneDirector?._controls &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 60000 },
  );
  await page.evaluate(() => {
    window.__qaSceneState = [];
    window.__godsEyeView.sceneDirector.subscribe((notification) =>
      window.__qaSceneState.push(notification),
    );
  });
  await page.click('[data-collapse-target="scene-panel"]');
  await page.click('#scene-new-btn');
  await page.waitForFunction(
    () =>
      document.querySelector('#scene-select option:checked')?.textContent ===
      'QA Scene',
  );
  check(
    'New creates and selects a persisted empty scene',
    await page.evaluate(() => {
      const director = window.__godsEyeView.sceneDirector;
      const saved = JSON.parse(
        localStorage.getItem('godsEyeView.sceneProject.v2'),
      );
      return (
        director._getSelectedScene().shots.length === 0 &&
        !!document.querySelector('.scene-shot-empty') &&
        saved.scenes.some((scene) => scene.title === 'QA Scene')
      );
    }),
  );
  await page.click('#scene-capture-btn');
  await page.waitForFunction(
    () => document.querySelectorAll('.scene-shot-row').length === 1,
  );
  check(
    'Capture stores the actual camera and visual state',
    await page.evaluate(() => {
      const director = window.__godsEyeView.sceneDirector;
      const shot = director._getSelectedScene().shots[0];
      const current = director.styleManager.getCameraState();
      return (
        Number.isFinite(shot.camera.lat) &&
        Math.abs(shot.camera.lat - current.lat) < 0.01 &&
        shot.visual.style === director.styleManager.getVisualState().style
      );
    }),
  );
  promptValue = '<b>QA shot</b>';
  await page.click('.scene-shot-label', { count: 2 });
  await page.waitForSelector('.scene-shot-rename', { visible: true });
  await page.type('.scene-shot-rename', promptValue);
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () =>
      document.querySelector('.scene-shot-label')?.textContent ===
      '<b>QA shot</b>',
  );
  check(
    'Rename persists literal text without interpreting markup',
    await page.evaluate(
      () =>
        !document.querySelector('.scene-shot-label b') &&
        JSON.parse(
          localStorage.getItem('godsEyeView.sceneProject.v2'),
        ).scenes.some((scene) =>
          scene.shots.some((shot) => shot.title === '<b>QA shot</b>'),
        ),
    ),
  );
  await page.click('#scene-capture-btn');
  await page.waitForFunction(
    () => document.querySelectorAll('.scene-shot-row').length === 2,
  );
  await page.click('.scene-shot-label');
  check(
    'Shot selection and Update use the selected shot',
    await page.evaluate(() => {
      const director = window.__godsEyeView.sceneDirector;
      const scene = director._getSelectedScene();
      const count = scene.shots.length;
      document.getElementById('scene-update-shot-btn').click();
      return (
        director._selectedShotId === scene.shots[0].id &&
        scene.shots.length === count &&
        document.querySelector('.scene-shot-row.active .scene-shot-label')
          .textContent === scene.shots[0].title
      );
    }),
  );
  await page.evaluate(() => {
    window.__sceneExports = [];
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      if (blob.type === 'application/json')
        window.__sceneExports.push(blob.text());
      return create(blob);
    };
  });
  await page.click('#scene-export-btn');
  const exported = await page.evaluate(async () =>
    JSON.parse(await window.__sceneExports[0]),
  );
  check(
    'Export produces the current project JSON',
    exported.scenes.some(
      (scene) => scene.title === 'QA Scene' && scene.shots.length === 2,
    ),
  );
  // Keep real camera/style playback while isolating this control check from
  // live provider availability. Layer transactions are covered by their suites.
  const scene = exported.scenes.find((item) => item.title === 'QA Scene');
  scene.shots = scene.shots
    .slice(0, 1)
    .map((shot) => ({ ...shot, durationSec: 0.4, holdSec: 10, layers: {} }));
  const fixture = { ...exported, scenes: [scene] };
  const projectFile = path.join(shots, 'project.json');
  fs.writeFileSync(projectFile, JSON.stringify(fixture));
  const input = await page.$('#scene-import-file');
  const beforePreview = await page.evaluate(() =>
    JSON.stringify(window.__godsEyeView.sceneDirector._project),
  );
  await input.uploadFile(projectFile);
  await page.waitForSelector('[data-director-apply-import]');
  check(
    'Import preview leaves the current project untouched',
    await page.evaluate(
      (saved) =>
        JSON.stringify(window.__godsEyeView.sceneDirector._project) === saved,
      beforePreview,
    ),
  );
  await page.click('[data-director-apply-import]');
  await page.waitForFunction(
    () =>
      document.getElementById('scene-status').textContent ===
      'Imported project.json',
  );
  check(
    'Import replaces the project and clears the file input',
    await page.evaluate(
      () =>
        window.__godsEyeView.sceneDirector._project.scenes.length === 1 &&
        document.querySelectorAll('.scene-shot-row').length === 1 &&
        document.getElementById('scene-import-file').value === '',
    ),
  );
  await page.click('.scene-shot-btn');
  await page.waitForFunction(
    () =>
      document.getElementById('scene-status').textContent.startsWith('Loaded:'),
    { timeout: 30000 },
  );
  check(
    'LOAD completes the real visual and camera operation',
    await page.evaluate(
      () =>
        !window.__godsEyeView.sceneDirector.running &&
        document
          .getElementById('scene-status')
          .textContent.includes('<b>QA shot</b>'),
    ),
  );
  await page.click('#scene-start-btn');
  await page.waitForFunction(
    () =>
      window.__godsEyeView.sceneDirector.running &&
      document.body.classList.contains('scene-playback-mode'),
  );
  check(
    'Playback enters recording presentation and disables editing',
    await page.evaluate(
      () =>
        document.getElementById('scene-capture-btn').disabled &&
        document.getElementById('scene-start-btn').disabled &&
        !document.getElementById('scene-stop-btn').disabled &&
        window.__godsEyeView.styleManager.getControlState().recording,
    ),
  );
  // A focused panel owns Escape to collapse one level. Release panel focus
  // before testing the global playback shortcut; the canvas is not tabbable.
  await page.evaluate(() => document.activeElement?.blur());
  check(
    'global playback shortcut has document focus',
    await page.evaluate(() => document.activeElement === document.body),
  );
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () =>
      !window.__godsEyeView.sceneDirector.running &&
      !document.body.classList.contains('scene-playback-mode'),
  );
  check(
    'Escape ends playback and restores idle/recording controls',
    await page.evaluate(
      () =>
        !document.getElementById('scene-start-btn').disabled &&
        document.getElementById('scene-stop-btn').disabled &&
        !document.getElementById('scene-download-btn').disabled &&
        !window.__godsEyeView.styleManager.getControlState().recording,
    ),
  );
  // Escape can also collapse the Scene accordion. Reopen it through its
  // installed disclosure before testing the next visible user action.
  if (
    await page.$eval('#scene-panel', (panel) =>
      panel.classList.contains('collapsed'),
    )
  )
    await page.click('[data-collapse-target="scene-panel"]');
  await page.waitForSelector('#scene-download-btn', { visible: true });
  await page.click('#scene-download-btn');
  const metadata = await page.evaluate(async () =>
    JSON.parse(await window.__sceneExports.at(-1)),
  );
  check(
    'Run download contains the completed cancelled run',
    Boolean(
      metadata.endedAt &&
      metadata.wasCancelled &&
      Array.isArray(metadata.events),
    ),
  );
  await page.click('#scene-start-btn');
  await page.waitForFunction(() => window.__godsEyeView.sceneDirector.running);
  await page.$eval('#scene-stop-btn', (button) => button.click());
  await page.waitForFunction(() => !window.__godsEyeView.sceneDirector.running);
  check(
    'The installed Stop control also completes playback cleanup',
    await page.evaluate(
      () =>
        !document.body.classList.contains('scene-playback-mode') &&
        !document.getElementById('scene-start-btn').disabled,
    ),
  );
  const badFile = path.join(shots, 'invalid.json');
  fs.writeFileSync(badFile, '{invalid');
  await input.uploadFile(badFile);
  await page.waitForFunction(() =>
    document
      .querySelector('[data-director-dialog] [role=status]')
      ?.textContent.includes('invalid JSON'),
  );
  check(
    'Invalid import reports failure and preserves the current project',
    await page.evaluate(
      () =>
        window.__godsEyeView.sceneDirector._project.scenes.length === 1 &&
        window.__godsEyeView.sceneDirector._getSelectedScene().title ===
          'QA Scene',
    ),
  );
  const savedBefore = await page.evaluate(() =>
    localStorage.getItem('godsEyeView.sceneProject.v2'),
  );
  const futureFile = path.join(shots, 'future.json');
  fs.writeFileSync(futureFile, JSON.stringify({ version: 99, scenes: [] }));
  await input.uploadFile(futureFile);
  await page.waitForFunction(() =>
    document
      .querySelector('[data-director-dialog] [role=status]')
      ?.textContent.includes('$.version'),
  );
  check(
    'Unsupported versions leave authored state and saved bytes unchanged',
    await page.evaluate(
      (saved) =>
        localStorage.getItem('godsEyeView.sceneProject.v2') === saved &&
        window.__godsEyeView.sceneDirector._getSelectedScene().title ===
          'QA Scene',
      savedBefore,
    ),
  );
  const malformed = structuredClone(fixture);
  malformed.scenes[0].shots[0].camera.lat = 91;
  const malformedFile = path.join(shots, 'malformed.json');
  fs.writeFileSync(malformedFile, JSON.stringify(malformed));
  await input.uploadFile(malformedFile);
  await page.waitForFunction(() =>
    document
      .querySelector('[data-director-dialog] [role=status]')
      ?.textContent.includes('camera.lat'),
  );
  check(
    'Invalid camera field identifies its path without replacing the project',
    await page.evaluate(
      (saved) => localStorage.getItem('godsEyeView.sceneProject.v2') === saved,
      savedBefore,
    ),
  );
  await page.keyboard.press('Escape');
  await page.screenshot({ path: path.join(shots, 'desktop.png') });
  await page.setViewport({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(shots, 'narrow.png') });
  check(
    'Scene controls stay inside the narrow viewport',
    await page.$eval('#scene-select', (element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth;
    }),
  );
  await page.setViewport({ width: 1440, height: 900 });
  await page.click('.scene-shot-danger');
  await page.waitForFunction(
    () => !!document.querySelector('.scene-shot-empty'),
  );
  check(
    'Delete shot leaves the empty-state presentation',
    await page.evaluate(
      () =>
        window.__godsEyeView.sceneDirector._getSelectedScene().shots.length ===
        0,
    ),
  );
  await page.click('#scene-delete-btn');
  await page.waitForFunction(
    () =>
      !window.__godsEyeView.sceneDirector._project.scenes.some(
        (item) => item.title === 'QA Scene',
      ),
  );
  check(
    'Deleting the final scene restores the built-in recipes',
    await page.evaluate(
      () =>
        window.__godsEyeView.sceneDirector._project.scenes.length > 0 &&
        document.querySelectorAll('#scene-select option').length > 0,
    ),
  );
  check(
    'Scene subscriptions include current state and the completed native editing actions',
    await page.evaluate(() => {
      const seen = window.__qaSceneState;
      const types = new Set(seen.map(({ change }) => change?.type));
      return (
        seen[0].initial &&
        Object.isFrozen(seen[0].state) &&
        [
          'scene-created',
          'shot-captured',
          'shot-renamed',
          'shot-updated',
          'project-exported',
          'project-imported',
          'shot-deleted',
          'scene-deleted',
          'run-event',
        ].every((type) => types.has(type)) &&
        seen
          .filter(({ change }) => change?.shot)
          .every(({ change }) => Object.isFrozen(change.shot))
      );
    }),
  );
  const teardown = await page.evaluate(async () => {
    const director = window.__godsEyeView.sceneDirector;
    const controls = director._controls;
    const previousStatus = document.getElementById('scene-status').textContent;
    const project = director._project;
    let finish;
    const gate = new Promise((resolve) => {
      finish = resolve;
    });
    const pending = controls.run('import', {
      name: 'late.json',
      text: async () => {
        await gate;
        return '{"scenes":[]}';
      },
    });
    const stopping = director.destroy();
    const notificationsAtStop = window.__qaSceneState.length;
    const stoppedSynchronously =
      controls.destroyed &&
      controls.removers.length === 0 &&
      controls.rowRemovers.length === 0;
    document.getElementById('scene-new-btn').click();
    controls.run('capture');
    finish();
    await pending;
    await stopping;
    await director.destroy();
    return {
      stoppedSynchronously,
      stateStopped: window.__qaSceneState.length === notificationsAtStop,
      sameProject: director._project === project,
      noLateStatus:
        document.getElementById('scene-status').textContent === previousStatus,
      rowsGone: !document.querySelector('.scene-shot-row'),
    };
  });
  check(
    'Disposal revokes fixed and row actions before waiting for scene work',
    teardown.stoppedSynchronously && teardown.rowsGone,
  );
  check(
    'Late import completion cannot replace the disposed project or status',
    teardown.sameProject && teardown.noLateStatus,
  );
  check(
    'Scene subscriptions stop before late imports settle',
    teardown.stateStopped,
  );
  check(
    'Scene control interaction produces no uncaught browser errors',
    errors.length === 0,
  );
} finally {
  await browser.close();
}
if (failures) process.exitCode = 1;
