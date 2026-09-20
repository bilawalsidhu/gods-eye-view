#!/usr/bin/env node
/** Browser acceptance for application shortcuts and generated parameter controls. */
import fs from 'node:fs';
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
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
let failures = 0;
const check = (name, passed) => {
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${name}`);
  if (!passed) failures += 1;
};
try {
  await page.setViewport({ width: 1440, height: 900 });
  const url = new URL(process.env.QA_BASE_URL || 'http://127.0.0.1:4173');
  url.searchParams.set('welcome', '0');
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__godsEyeView?.styleManager?._applicationShortcuts,
    { timeout: 60_000 },
  );
  await page.waitForFunction(
    () => {
      const cover = document.getElementById('loading-screen');
      return (
        cover?.classList.contains('hidden') &&
        Number(getComputedStyle(cover).opacity) === 0
      );
    },
    { timeout: 60_000 },
  );
  await page.evaluate(() => {
    const manager = window.__godsEyeView.styleManager;
    manager.setStyle('normal');
    document.activeElement?.blur();
  });
  await page.keyboard.press('2');
  check(
    'native number shortcut selects CRT',
    await page.evaluate(
      () => window.__godsEyeView.styleManager.activeStyle === 'retro',
    ),
  );
  const initial = await page.evaluate(() => {
    const manager = window.__godsEyeView.styleManager;
    manager.setPanelCollapsed('pp-toggles', false, {
      persist: false,
      syncShare: false,
    });
    manager._sliderPanel.classList.remove('collapsed');
    const slider = manager._sliderContainer.querySelector('input');
    window.__qaOldSlider = slider;
    const name = 'pixelation';
    window.__qaParameter = {
      name,
      before: manager.stages.retro.uniforms[name],
    };
    slider.focus();
    return {
      before: Number(slider.value),
      step: Number(slider.step),
      label: slider.getAttribute('aria-label'),
    };
  });
  check(
    'generated range has an accessible label and a numeric step',
    initial.label === 'Pixelation' && initial.step > 0,
  );
  await page.keyboard.press('ArrowRight');
  const changed = await page.evaluate(() => {
    const slider = window.__qaOldSlider;
    const manager = window.__godsEyeView.styleManager;
    return {
      value: Number(slider.value),
      readout: slider.nextElementSibling.textContent,
      uniform: manager.stages.retro.uniforms[window.__qaParameter.name],
    };
  });
  check(
    'native range input changes the shader and formatted readout',
    changed.value > initial.before &&
      changed.uniform === changed.value &&
      Number(changed.readout) === changed.value,
  );
  await page.keyboard.press('3');
  check(
    'focused range retains native input instead of changing style',
    await page.evaluate(
      () => window.__godsEyeView.styleManager.activeStyle === 'retro',
    ),
  );
  check(
    'replacing a style revokes its detached slider',
    await page.evaluate(() => {
      const manager = window.__godsEyeView.styleManager;
      const before = manager.stages.retro.uniforms[window.__qaParameter.name];
      manager.setStyle('thermal');
      window.__qaOldSlider.value = '0';
      window.__qaOldSlider.dispatchEvent(new Event('input', { bubbles: true }));
      return (
        manager.stages.retro.uniforms[window.__qaParameter.name] === before
      );
    }),
  );
  check(
    'normal style clears rows; reopening restores current shader values',
    await page.evaluate(() => {
      const manager = window.__godsEyeView.styleManager;
      manager.setStyle('normal');
      const cleared = manager._sliderContainer.children.length === 0;
      manager.setStyle('retro');
      return (
        cleared &&
        Number(manager._sliderContainer.querySelector('input').value) ===
          manager.stages.retro.uniforms[window.__qaParameter.name]
      );
    }),
  );
  const hudBefore = await page.evaluate(() => {
    document.getElementById('hud-layout-select').focus();
    return window.__godsEyeView.styleManager.hud.visible;
  });
  await page.keyboard.press('h');
  check(
    'HUD select keeps its native typing and selection',
    await page.evaluate(
      (visible) =>
        document.activeElement?.id === 'hud-layout-select' &&
        window.__godsEyeView.styleManager.hud.visible === visible,
      hudBefore,
    ),
  );
  const displayBefore = await page.evaluate(() => {
    const manager = window.__godsEyeView.styleManager;
    manager._setBloomEnabled(true);
    manager._bloomSlider.value = '80';
    manager._bloomSlider.dispatchEvent(new Event('input', { bubbles: true }));
    manager._bloomSlider.focus();
    return {
      value: Number(manager._bloomSlider.value),
      contrast: manager._bloomStage.uniforms.contrast,
    };
  });
  await page.keyboard.press('ArrowRight');
  check(
    'native Display slider updates effect state',
    await page.evaluate((before) => {
      const manager = window.__godsEyeView.styleManager;
      return (
        Number(manager._bloomSlider.value) > before.value &&
        manager._bloomStage.uniforms.contrast < before.contrast
      );
    }, displayBefore),
  );
  check(
    'Display buttons toggle current state once',
    await page.evaluate(() => {
      const manager = window.__godsEyeView.styleManager;
      const before = manager.bloomEnabled;
      manager._bloomBtn.click();
      const changed = manager.bloomEnabled !== before;
      manager._bloomBtn.click();
      return changed && manager.bloomEnabled === before;
    }),
  );
  check(
    'Display rebind removes old listeners',
    await page.evaluate(() => {
      const manager = window.__godsEyeView.styleManager;
      manager._initUI();
      const before = manager.bloomEnabled;
      manager._bloomBtn.click();
      return manager.bloomEnabled !== before;
    }),
  );
  fs.mkdirSync('qa-shots/visual-input', { recursive: true });
  await page.screenshot({ path: 'qa-shots/visual-input/desktop.png' });
  await page.setViewport({ width: 620, height: 900 });
  await page.waitForFunction(
    () =>
      document.getElementById('left-panel-stack')?.dataset.layoutMode ===
      'mobile',
  );
  await page.evaluate(() => {
    const slider =
      window.__godsEyeView.styleManager._sliderContainer.querySelector('input');
    slider.focus();
    slider.scrollIntoView({ block: 'center', behavior: 'instant' });
  });
  await page.screenshot({ path: 'qa-shots/visual-input/narrow.png' });
  await page.evaluate(() => {
    const manager = window.__godsEyeView.styleManager;
    window.__qaCurrentSlider = manager._sliderContainer.querySelector('input');
    manager._applicationShortcuts.destroy();
    manager._styleParameters.destroy();
    document.activeElement?.blur();
  });
  await page.keyboard.press('3');
  check(
    'destroyed application shortcuts cannot change the selected style',
    await page.evaluate(
      () => window.__godsEyeView.styleManager.activeStyle === 'retro',
    ),
  );
  check(
    'destroyed parameter controls cannot write through a retained element',
    await page.evaluate(() => {
      const manager = window.__godsEyeView.styleManager;
      const before = manager.stages.retro.uniforms[window.__qaParameter.name];
      window.__qaCurrentSlider.value = '0';
      window.__qaCurrentSlider.dispatchEvent(
        new Event('input', { bubbles: true }),
      );
      return (
        manager._sliderContainer.children.length === 0 &&
        manager.stages.retro.uniforms[window.__qaParameter.name] === before
      );
    }),
  );
  check(
    'destroyed Display controls cannot change settings',
    await page.evaluate(() => {
      const manager = window.__godsEyeView.styleManager;
      manager._displayControls.destroy();
      const before = manager.bloomEnabled;
      const contrast = manager._bloomStage.uniforms.contrast;
      manager._bloomBtn.click();
      manager._bloomSlider.value = '15';
      manager._bloomSlider.dispatchEvent(new Event('input', { bubbles: true }));
      return (
        manager.bloomEnabled === before &&
        manager._bloomStage.uniforms.contrast === contrast
      );
    }),
  );
  check('runtime has no uncaught browser errors', errors.length === 0);
} finally {
  await browser.close();
}
console.log(`RESULT: ${failures} failures`);
process.exitCode = failures ? 1 : 0;
