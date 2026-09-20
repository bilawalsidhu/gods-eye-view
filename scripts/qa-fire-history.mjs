#!/usr/bin/env node
/**
 * Browser proof for the Historic Fires layer against a RUNNING dev server
 * (default http://localhost:4173; override with QA_BASE_URL). Requires a
 * configured FIRMS_MAP_KEY — the archive loads are real. Screenshots land in
 * QA_OUT (default qa-shots/fire-history, gitignored).
 *
 * Covers: enable + first load frames the event; row chips switch events by
 * layer params; the Context-panel section (roster, card, chart, seek, speed,
 * reset); the NIFC perimeter; the spread replay clock vs. visible points;
 * disable clears the scene; no page errors.
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer';
const BASE = process.env.QA_BASE_URL || 'http://localhost:4173';
const OUT = process.env.QA_OUT || 'qa-shots/fire-history';
const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu'],
  defaultViewport: { width: 1500, height: 1000 },
});
fs.mkdirSync(OUT, { recursive: true });
const page = await browser.newPage();
const errors = [];
const consoleErrors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  await page.goto(`${BASE}/?welcome=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__godsEyeView?.dataManager?.getAll?.().length > 10,
    { timeout: 90000 },
  );
  // Let the startup flight settle first (a person toggles layers after
  // arrival): wait until the camera has not moved for 2 s.
  await page.evaluate(async () => {
    const cam = window.__godsEyeView.viewer.camera;
    let last = { ...cam.positionWC };
    let stillFor = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 40000 && stillFor < 2000) {
      await new Promise((r) => setTimeout(r, 250));
      const now = { ...cam.positionWC };
      if (Math.hypot(now.x - last.x, now.y - last.y, now.z - last.z) < 0.5)
        stillFor += 250;
      else stillFor = 0;
      last = now;
    }
  });
  const camBefore = await page.evaluate(
    () => window.__godsEyeView.viewer.camera.positionCartographic.height,
  );
  const state1 = await page.evaluate(async () => {
    const m = window.__godsEyeView.dataManager;
    await m.setEnabled('fire-history', true);
    const layer = m.layers.get('fire-history').module;
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      const s = layer.getStats();
      if (!s.loading && (s.count > 0 || s.error)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const row = document.querySelector('[data-layer-id="fire-history"]');
    return {
      stats: layer.getStats(),
      event: layer.getEventState().event?.name,
      timelineDays: layer.getEventState().timeline.length,
      chips: [...row.querySelectorAll('.data-toggle-chip')].map((b) => [
        b.textContent,
        b.classList.contains('active'),
      ]),
      legend: [...row.querySelectorAll('.data-toggle-legend-item')].map(
        (n) => n.textContent,
      ),
      rowText: row.innerText.replace(/\s+/g, ' ').slice(0, 200),
      analyst: layer.getAnalystRecords(2)[0],
    };
  });
  console.log(JSON.stringify(state1, null, 1));
  await wait(4500); // camera flight + tiles
  const camAfter = await page.evaluate(() => {
    const c = window.__godsEyeView.viewer.camera.positionCartographic;
    return {
      lat: ((c.latitude * 180) / Math.PI).toFixed(2),
      lon: ((c.longitude * 180) / Math.PI).toFixed(2),
      h: Math.round(c.height),
    };
  });
  console.log(
    'camera before h=',
    Math.round(camBefore),
    'after',
    JSON.stringify(camAfter),
  );
  await page.screenshot({ path: `${OUT}/fire-history-camp.png` });
  // Context panel: expand the Context panel if collapsed, check the section, drive it
  const panelState = await page.evaluate(async () => {
    const ctx = document.getElementById('global-context-panel');
    if (ctx?.classList.contains('collapsed'))
      document
        .querySelector('[data-collapse-target="global-context-panel"]')
        ?.click();
    await new Promise((r) => setTimeout(r, 400));
    const panel = document.getElementById('fire-history-panel');
    if (!panel) return { missing: true };
    const layer =
      window.__godsEyeView.dataManager.layers.get('fire-history').module;
    const roster = [...panel.querySelectorAll('.fire-history-roster-item')].map(
      (b) => [
        b.textContent.trim().slice(0, 24),
        b.classList.contains('active'),
      ],
    );
    const bars = panel.querySelectorAll('.fire-history-chart rect').length;
    // seek to 40% through the panel slider
    const seek = panel.querySelector('[data-role="seek"]');
    seek.value = '400';
    seek.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    const afterSeek = layer.getReplayState();
    const cursorLine = panel.querySelectorAll(
      '.fire-history-chart-cursor',
    ).length;
    const clock = panel.querySelector('[data-role="clock"]').textContent;
    // speed slider → 4×
    const speed = panel.querySelector('[data-role="speed"]');
    speed.value = '3';
    speed.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    const speedOut = panel.querySelector('[data-role="speed-out"]').textContent;
    // reset via panel button
    panel.querySelector('[data-role="reset"]').click();
    await new Promise((r) => setTimeout(r, 100));
    const afterReset = layer.getReplayState().status;
    return {
      hidden: panel.hidden,
      ctxCollapsed: ctx?.classList.contains('collapsed'),
      roster,
      bars,
      afterSeek: { status: afterSeek.status, shown: afterSeek.shown },
      cursorLine,
      clock,
      speedOut,
      afterReset,
      title: panel.querySelector('[data-role="title"]').textContent,
      burned: panel.querySelector('[data-role="burned"]').textContent,
      refs: panel.querySelectorAll('.fire-history-refs a').length,
    };
  });
  console.log('PANEL', JSON.stringify(panelState, null, 1));
  const perim = await page.evaluate(async () => {
    const layer =
      window.__godsEyeView.dataManager.layers.get('fire-history').module;
    const t0 = Date.now();
    while (Date.now() - t0 < 30000 && !layer.getEventState().perimeter)
      await new Promise((r) => setTimeout(r, 200));
    const ds = window.__godsEyeView.viewer.dataSources;
    let n = 0,
      shown = null;
    for (let i = 0; i < ds.length; i++) {
      const d = ds.get(i);
      if (d.name === 'fire-history-perimeter') {
        n = d.entities.values.length;
        shown = d.show;
      }
    }
    const panel = document.getElementById('fire-history-panel');
    return {
      perimeter: layer.getEventState().perimeter,
      rings: n,
      shown,
      text: panel.querySelector('[data-role="perimeter"]').textContent,
      nifcLink: panel.querySelectorAll('.fire-history-refs a').length,
    };
  });
  console.log('PERIMETER', JSON.stringify(perim));
  await page.screenshot({ path: `${OUT}/fire-history-panel.png` });
  // Seek again so the chart cursor is visible, scroll the section into view, screenshot
  await page.evaluate(async () => {
    const panel = document.getElementById('fire-history-panel');
    const seek = panel.querySelector('[data-role="seek"]');
    seek.value = '550';
    seek.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    panel
      .querySelector('.fire-history-chart')
      .scrollIntoView({ block: 'start' });
  });
  await wait(600);
  await page.screenshot({ path: `${OUT}/fire-history-panel-chart.png` });
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('fire-history')
      .module.resetReplay(),
  );
  // put speed back to 2× for the replay step below (the chip cycles from the current speed)
  await page.evaluate(() => {
    const l =
      window.__godsEyeView.dataManager.layers.get('fire-history').module;
    l.setReplaySpeed(1);
  });
  // Replay: press the transport chip, let the clock run, inspect state
  const replay = await page.evaluate(async () => {
    const row = document.querySelector('[data-layer-id="fire-history"]');
    const chip = (re) =>
      [...row.querySelectorAll('.data-toggle-chip')].find((b) =>
        re.test(b.textContent),
      );
    const layer =
      window.__godsEyeView.dataManager.layers.get('fire-history').module;
    chip(/2×|1×|0.5×|4×/).click(); // cycle 1× → 2×
    chip(/REPLAY/).click();
    await new Promise((r) => setTimeout(r, 4000)); // ≈48 event-hours at 2×
    const mid = layer.getReplayState();
    const statsMid = layer.getStats();
    const shownMid = [...row.querySelectorAll('.data-toggle-chip')].map(
      (b) => b.textContent,
    );
    chip(/PAUSE/).click();
    await new Promise((r) => setTimeout(r, 300));
    const paused = layer.getReplayState();
    const visible = (() => {
      let n = 0;
      const col = window.__godsEyeView.viewer.scene.primitives;
      for (let i = 0; i < col.length; i++) {
        const p = col.get(i);
        if (
          p &&
          p.length !== undefined &&
          p.get &&
          p.get(0)?.id?.startsWith?.('fire-history:')
        ) {
          for (let k = 0; k < p.length; k++) if (p.get(k).show) n++;
        }
      }
      return n;
    })();
    return {
      mid: {
        status: mid.status,
        speed: mid.speed,
        shown: mid.shown,
        active: mid.active,
        total: mid.total,
      },
      statsMid: {
        countLabel: statsMid.countLabel,
        loadingLabel: statsMid.loadingLabel,
      },
      chipsMid: shownMid,
      paused: { status: paused.status, shown: paused.shown },
      visiblePoints: visible,
      rowLabel: row.innerText.replace(/\s+/g, ' ').slice(0, 160),
    };
  });
  console.log('REPLAY', JSON.stringify(replay, null, 1));
  await wait(800);
  await page.screenshot({ path: `${OUT}/fire-history-replay.png` });
  await page.evaluate(() => {
    const row = document.querySelector('[data-layer-id="fire-history"]');
    [...row.querySelectorAll('.data-toggle-chip')]
      .find((b) => /ALL/.test(b.textContent))
      .click();
  });
  const afterReset = await page.evaluate(() => {
    const l =
      window.__godsEyeView.dataManager.layers.get('fire-history').module;
    return {
      status: l.getReplayState().status,
      label: l.getStats().loadingLabel,
      countLabel: l.getStats().countLabel,
    };
  });
  console.log('RESET', JSON.stringify(afterReset));
  // Switch event through the real chip click
  await page.evaluate(() => {
    const row = document.querySelector('[data-layer-id="fire-history"]');
    [...row.querySelectorAll('.data-toggle-chip')]
      .find((b) => /Lahaina/.test(b.textContent))
      .click();
  });
  const state2 = await page.evaluate(async () => {
    const layer =
      window.__godsEyeView.dataManager.layers.get('fire-history').module;
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      const s = layer.getStats();
      if (!s.loading && s.count === 151) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const row = document.querySelector('[data-layer-id="fire-history"]');
    return {
      stats: layer.getStats(),
      event: layer.getEventState().event?.name,
      chips: [...row.querySelectorAll('.data-toggle-chip')].map((b) => [
        b.textContent,
        b.classList.contains('active'),
      ]),
    };
  });
  console.log(JSON.stringify(state2, null, 1));
  await wait(5000);
  await page.screenshot({ path: `${OUT}/fire-history-lahaina.png` });
  // Disable → points hidden, overlay cleared, no errors
  const after = await page.evaluate(async () => {
    const m = window.__godsEyeView.dataManager;
    await m.setEnabled('fire-history', false);
    return {
      enabled: m.isEnabled('fire-history'),
      primitives: window.__godsEyeView.viewer.scene.primitives.length,
    };
  });
  console.log('after disable', JSON.stringify(after));
} finally {
  console.log('pageerrors', JSON.stringify(errors));
  console.log('console errors', JSON.stringify(consoleErrors.slice(0, 8)));
  await browser.close();
  process.exitCode = errors.length ? 1 : 0;
}
