#!/usr/bin/env node
/**
 * Sky view pass-selection scroll QA, headless Chromium against a
 * running GEV dev server (live /api/celestrak/<group>; no RCS source, so brightness
 * falls back to the satellite class):
 *
 *   node scripts/qa-sky-passscroll.mjs --url http://127.0.0.1:4381 --out <dir>
 *        [--sizes 500x757,960x757,960x400,844x390]
 *
 * At each size, with real mouse clicks:
 *  A. nothing selected, panel body scrolled to the bottom, tap the first
 *     "Next passes" row: the tapped row and "Go to peak time" are fully in
 *     the body's scrollport and hit-testable (the object card appears ABOVE
 *     the passes block and must not push them out).
 *  B. nothing selected, body at the top, row scrolled in with block:nearest,
 *     tap: same checks.
 *  C. with a pass selected, tap a different row: same checks.
 *  In A-C "Go to peak time" must be fully in the body's scrollport and
 *  hit-testable at every size (no allowance for an action below the panel)
 *  and must not cover the selected row.
 *  G. with a pass selected, sweep the body scroll: wherever the selected row
 *     is in view, Go to peak is fully in view and hit-testable too.
 *  D. tap "Go to peak time": selection unchanged, Sky time = pass peak.
 *  E. "Next ISS pass" from the bottom (nothing selected): that button stays
 *     in view (it is the anchor).
 *  F. background clicks (body padding, passes title/status, synthetic clicks
 *     on the <ul>/<li> containers) change neither selection nor scroll.
 * Every host but the dev server fails DNS (no outbound network). Writes results.json and a
 * screenshot per step. Exit 1 on any failure.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg('--url', 'http://127.0.0.1:4381');
const OUT = path.resolve(arg('--out', 'qa-sky-passscroll'));
const SIZES = arg('--sizes', '500x757,960x757,960x400,844x390')
  .split(',')
  .map((s) => s.split('x').map(Number));
const T = '2026-10-14T10:40:00Z';
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const results = {};
const check = (tag, ok, what, detail) => {
  const line = `${ok ? 'PASS' : 'FAIL'} ${tag} ${what}${detail ? ' ' + JSON.stringify(detail) : ''}`;
  console.log(line);
  if (!ok) failures.push(line);
};

// in-page: is `sel` fully inside the body scrollport and hit-testable?
const REACH = (sel) => {
  const body = document.querySelector('[data-sky=sats-body]');
  const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
  if (!el || el.hidden) return { ok: false, why: 'missing' };
  const b = body.getBoundingClientRect();
  const e = el.getBoundingClientRect();
  // a row also has to be inside its nested passes-list box
  const nest = el.closest('[data-sky=passes-list]')?.getBoundingClientRect();
  const lo = Math.max(b.top, nest ? nest.top : -1e9);
  const hi = Math.min(b.bottom, nest ? nest.bottom : 1e9);
  const inView = e.top >= lo - 0.5 && e.bottom <= hi + 0.5;
  const hit = document.elementFromPoint(
    e.left + e.width / 2,
    e.top + e.height / 2,
  );
  return {
    ok: inView && !!hit && (hit === el || el.contains(hit)),
    inView,
    top: Math.round(e.top),
    bottom: Math.round(e.bottom),
    bodyTop: Math.round(b.top),
    bodyBottom: Math.round(b.bottom),
  };
};

const STATE = () => {
  const q = (s) => document.querySelector(s);
  const body = q('[data-sky=sats-body]');
  const cur = q('[data-sky=passes-list] button[aria-current=true]');
  return {
    scrollTop: Math.round(body.scrollTop),
    maxScroll: body.scrollHeight - body.clientHeight,
    cardHidden: q('[data-sky=sats-card]').hidden,
    cardTitle: q('[data-sky=sats-card-title]').textContent,
    selectedKey: cur ? cur.getAttribute('data-pass') : null,
    goDisabled: q('[data-sky=pass-go]').disabled,
    time: q('[data-sky=time]')?.value ?? null,
  };
};

for (const [w, h] of SIZES) {
  const tag = `${w}x${h}`;
  const res = (results[tag] = { errors: [], steps: {} });
  const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 900000,
    args: [
      '--no-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      // no outbound network: every host but the dev server fails DNS (request
      // interception would also stall module-worker imports in Chromium)
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h });
  page.on('pageerror', (e) => res.errors.push(String(e).slice(0, 300)));
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
    } catch {}
  });
  const snap = (name) =>
    page.screenshot({ path: path.join(OUT, `${tag}-${name}.png`) });
  await page.goto(`${BASE}/?sv=29.7604,-95.3698,200,40,90,${T}`, {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  });
  await page.waitForFunction(() => window.__godsEyeView?.viewer, {
    timeout: 120000,
  });
  // A cold dev-server load sometimes never leaves "Loading satellites..."
  // under heavy host load (seen on slow hosts, also without this change): reload,
  // up to 3 attempts, and record how many were needed.
  res.loadAttempts = 0;
  let loaded = false;
  for (let attempt = 1; attempt <= 3 && !loaded; attempt++) {
    res.loadAttempts = attempt;
    if (attempt > 1) await page.reload({ waitUntil: 'domcontentloaded' });
    loaded = await page
      .waitForFunction(
        () =>
          document.querySelector('[data-sky=passes-list]')?.children.length >
            3 && !document.querySelector('.gev-sky-sats')?.hidden,
        { timeout: 150000, polling: 1000 },
      )
      .then(() => true)
      .catch(() => false);
  }
  if (!loaded) {
    res.loadDiag = await page
      .evaluate(() => ({
        sats: document.querySelector('.gev-sky-sats')?.hidden,
        rows: document.querySelector('[data-sky=passes-list]')?.children.length,
        status: document.querySelector('[data-sky=passes-status]')?.textContent,
        banner: document.querySelector('[data-sky=sats-banner]')?.textContent,
      }))
      .catch((e) => String(e));
    await snap('0-load-timeout').catch(() => {});
    check(tag, false, 'Sky view + Next passes loaded', res.loadDiag);
    await browser.close();
    continue;
  }
  await sleep(3000);

  const setBody = (v) =>
    page.evaluate((x) => {
      document.querySelector('[data-sky=sats-body]').scrollTop = x;
    }, v);
  const state = () => page.evaluate(STATE);
  const reach = (sel) => page.evaluate(REACH, sel);
  const reachSelectedRow = () =>
    reach('[data-sky=passes-list] button[aria-current=true]');
  const clickEl = async (handleFn) => {
    const pt = await page.evaluate(handleFn);
    await page.mouse.click(pt.x, pt.y);
    return pt;
  };
  const clear = async () => {
    await page.evaluate(() => {
      const c = document.querySelector('[data-sky=sats-clear]');
      if (!document.querySelector('[data-sky=sats-card]').hidden)
        c.scrollIntoView({ block: 'nearest' });
    });
    if (!(await state()).cardHidden) {
      await page.click('[data-sky=sats-clear]');
      await sleep(500);
    }
  };
  // centre of the n-th pass row that is hit-testable right now; with `other`,
  // only rows that are not selected and whose peak is not the start time (so
  // "Go to peak" in step D visibly moves the clock)
  const T_MS = Date.parse(T);
  const rowPt = (n, other = false) =>
    page.evaluate(
      (k, oth, tMs) => {
        const body = document
          .querySelector('[data-sky=sats-body]')
          .getBoundingClientRect();
        const list = document.querySelector('[data-sky=passes-list]');
        const lb = list.getBoundingClientRect();
        const hitOk = (b) => {
          if (
            oth &&
            (b.getAttribute('aria-current') === 'true' ||
              Math.abs(
                Number(b.getAttribute('data-pass').split('@')[1]) - tMs,
              ) < 120000)
          )
            return false;
          const e = b.getBoundingClientRect();
          const h = document.elementFromPoint(
            e.left + e.width / 2,
            e.top + e.height / 2,
          );
          return !!h && (h === b || b.contains(h)); // not under Go to peak
        };
        const ok = [...list.querySelectorAll('button[data-pass]')].filter(
          (b) => {
            const e = b.getBoundingClientRect();
            return (
              e.top >= Math.max(body.top, lb.top) - 0.5 &&
              e.bottom <= Math.min(body.bottom, lb.bottom) + 0.5 &&
              hitOk(b)
            );
          },
        );
        // a short panel may clip every row a little: fall back to rows whose
        // centre is inside both boxes (still a real, hit-testable tap target)
        const pool = ok.length
          ? ok
          : [...list.querySelectorAll('button[data-pass]')].filter((b) => {
              const e = b.getBoundingClientRect();
              const c = e.top + e.height / 2;
              return (
                c > Math.max(body.top, lb.top) &&
                c < Math.min(body.bottom, lb.bottom) &&
                hitOk(b)
              );
            });
        const b = pool[Math.min(k, pool.length - 1)];
        if (!b) return null;
        const e = b.getBoundingClientRect();
        return {
          x: e.left + e.width / 2,
          y: e.top + e.height / 2,
          key: b.getAttribute('data-pass'),
        };
      },
      n,
      other,
      T_MS,
    );
  const afterTap = async (name, key) => {
    await sleep(1500);
    const s = await state();
    const row = await reachSelectedRow();
    const go = await reach('[data-sky=pass-go]');
    // can the row and Go to peak both fit? (best case: the row slid to the
    // bottom of the nested list, as far as the list's own scroll allows)
    const fit = await page.evaluate(() => {
      const q = (x) => document.querySelector(x);
      const body = q('[data-sky=sats-body]').getBoundingClientRect();
      const pl = q('[data-sky=passes-list]');
      const l = pl.getBoundingClientRect();
      const r = q(
        '[data-sky=passes-list] button[aria-current=true]',
      ).getBoundingClientRect();
      const g = q('[data-sky=pass-go]').getBoundingClientRect();
      const lowest =
        r.top + Math.min(pl.scrollTop, Math.max(0, l.bottom - r.bottom));
      return {
        span: Math.round(g.bottom - lowest),
        bodyH: Math.round(body.height),
      };
    });
    const goHit = await page.evaluate(() => {
      const g = document.querySelector('[data-sky=pass-go]');
      const body = document
        .querySelector('[data-sky=sats-body]')
        .getBoundingClientRect();
      const e = g.getBoundingClientRect();
      const cy = e.top + e.height / 2;
      const hit = document.elementFromPoint(e.left + e.width / 2, cy);
      return cy > body.top && cy < body.bottom && hit === g;
    });
    const canFit = fit.span <= fit.bodyH + 0.5;
    // the action must not cover the selected row (it sticks to the body
    // bottom and may overlay list rows below the selection)
    const clear = row.bottom <= go.top + 0.5 || row.top >= go.bottom - 0.5;
    res.steps[name] = { state: s, row, go, fit, goHit, canFit, clear };
    await snap(name);
    check(
      tag,
      s.selectedKey === key && !s.cardHidden,
      `${name}: tapped pass selected, card shown`,
      { key, sel: s.selectedKey },
    );
    check(tag, row.ok, `${name}: tapped row fully in view + hit-testable`, row);
    // review round 1: no allowance for an action below the panel, whatever
    // the list length or panel height (canFit is recorded for information)
    check(
      tag,
      !s.goDisabled && go.ok && goHit,
      `${name}: Go to peak fully in view + hit-testable`,
      { go, fit },
    );
    check(tag, clear, `${name}: Go to peak does not cover the selected row`, {
      row,
      go,
    });
  };

  // G. with a pass selected, scroll the body through every position where the
  // selected row is fully visible: Go to peak stays fully visible and
  // hit-testable at each one (the user can always see the action next to
  // the row), and never covers the row.
  const sweep = async (name) => {
    const max = (await state()).maxScroll;
    const seen = [];
    let bad = null;
    for (let y = 0; y <= max + 8; y += 8) {
      await setBody(Math.min(y, max));
      await sleep(40);
      const row = await reachSelectedRow();
      if (!row.inView) continue;
      const go = await reach('[data-sky=pass-go]');
      const covered = !(
        row.bottom <= go.top + 0.5 || row.top >= go.bottom - 0.5
      );
      seen.push([Math.min(y, max), go.ok, covered]);
      if (!go.ok && !bad) bad = { y, row, go };
    }
    // while the user scrolls, the sticky action may pass over the row at the
    // bottom edge (recorded, not a failure); it must never be out of view
    res.steps[name] = {
      positions: seen.length,
      covered: seen.filter((p) => p[2]).length,
      bad,
    };
    check(
      tag,
      seen.length > 0 && !bad,
      `${name}: Go to peak visible + hit-testable at every scroll position showing the selected row`,
      { positions: seen.length, bad },
    );
  };

  try {
    // A. bottom, nothing selected
    await setBody(1e6);
    await sleep(300);
    let pt = await rowPt(0);
    res.steps.A_before = await state();
    await page.mouse.click(pt.x, pt.y);
    await afterTap('A-bottom-nosel', pt.key);

    // B. top, nothing selected, row scrolled in with block:nearest
    await clear();
    await setBody(0);
    await page.evaluate(() =>
      document
        .querySelector('[data-sky=passes-list] button[data-pass]')
        .scrollIntoView({ block: 'nearest' }),
    );
    await sleep(300);
    pt = await rowPt(0);
    await page.mouse.click(pt.x, pt.y);
    await afterTap('B-nearest-nosel', pt.key);

    // C. switch to another row while a pass is selected
    // (rows under the sticky action are not tappable: slide the nested list
    // until another, later-peaking row is)
    pt = await rowPt(0, true);
    for (let i = 0; !pt && i < 15; i++) {
      await page.evaluate(() => {
        document.querySelector('[data-sky=passes-list]').scrollTop += 34;
      });
      await sleep(150);
      pt = await rowPt(0, true);
    }
    await page.mouse.click(pt.x, pt.y);
    await afterTap('C-switch', pt.key);
    await sweep('G-sweep');

    // D. Go to peak time: same selection, time = that pass peak
    const before = await state();
    await page.click('[data-sky=pass-go]');
    await sleep(1500);
    const afterGo = await state();
    const go = await reach('[data-sky=pass-go]');
    res.steps.D = { before, after: afterGo, go };
    await snap('D-go-to-peak');
    check(
      tag,
      afterGo.selectedKey === before.selectedKey ||
        afterGo.cardTitle === before.cardTitle,
      'D: Go to peak keeps the selection',
      { before: before.cardTitle, after: afterGo.cardTitle },
    );
    check(
      tag,
      afterGo.time !== before.time,
      'D: Go to peak moved the Sky time',
      { before: before.time, after: afterGo.time },
    );
    check(tag, go.ok, 'D: Go to peak still in view', go);

    // F. background clicks are inert (selection and scroll)
    const bg = await state();
    await clickEl(() => {
      const e = document
        .querySelector('[data-sky=sats-body]')
        .getBoundingClientRect();
      return { x: e.left + 3, y: e.top + e.height / 2 };
    });
    await sleep(300);
    res.bgTargets = [];
    for (const sel of ['[data-sky=passes-title]', '[data-sky=passes-status]']) {
      // only click where the element itself is hit (not something under a
      // clipped part, e.g. the card's Clear button)
      const r = await page.evaluate((s) => {
        const e = document.querySelector(s);
        const b = e.getBoundingClientRect();
        const pt = { x: b.left + 4, y: b.top + b.height / 2 };
        const hit = b.height > 0 && document.elementFromPoint(pt.x, pt.y);
        return hit && (hit === e || e.contains(hit)) ? pt : null;
      }, sel);
      res.bgTargets.push([sel, !!r]);
      if (r) await page.mouse.click(r.x, r.y);
      await sleep(300);
    }
    const synth = await page.evaluate(() => {
      const ev = (t) =>
        t?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        );
      const pl = document.querySelector('[data-sky=passes-list]');
      const ml = document.querySelector('[data-sky=sats-list]');
      ev(pl);
      ev(pl.querySelector('li'));
      ev(ml);
      ev(ml.querySelector('li'));
      return true;
    });
    await sleep(500);
    const bgAfter = await state();
    res.steps.F = { before: bg, after: bgAfter, synth };
    check(
      tag,
      bgAfter.selectedKey === bg.selectedKey &&
        bgAfter.cardTitle === bg.cardTitle,
      'F: background clicks leave the selection',
      { before: bg.cardTitle, after: bgAfter.cardTitle },
    );
    check(
      tag,
      Math.abs(bgAfter.scrollTop - bg.scrollTop) <= 1,
      'F: background clicks leave the scroll',
      { before: bg.scrollTop, after: bgAfter.scrollTop },
    );

    // E. Next ISS pass from the bottom, nothing selected: the button stays put
    await clear();
    await setBody(1e6);
    await page.evaluate(() =>
      document
        .querySelector('[data-sky=next-iss]')
        .scrollIntoView({ block: 'nearest' }),
    );
    await sleep(300);
    const issBefore = await reach('[data-sky=next-iss]');
    await page.click('[data-sky=next-iss]');
    await sleep(1500);
    const issAfter = await reach('[data-sky=next-iss]');
    const issState = await state();
    res.steps.E = { issBefore, issAfter, state: issState };
    await snap('E-next-iss');
    check(
      tag,
      issAfter.ok && Math.abs(issAfter.top - issBefore.top) <= 2,
      'E: Next ISS pass button stays in place',
      { issBefore, issAfter },
    );
    check(tag, /ISS|ZARYA/i.test(issState.cardTitle), 'E: ISS selected', {
      title: issState.cardTitle,
    });
  } catch (err) {
    // e.g. no tappable row left after a broken selection: record, go on
    check(tag, false, 'probe step error', String(err).slice(0, 200));
  }
  check(tag, res.errors.length === 0, 'no page errors', res.errors);
  await browser.close();
  writeFileSync(
    path.join(OUT, 'results.json'),
    JSON.stringify({ results, failures }, null, 1),
  );
}
writeFileSync(
  path.join(OUT, 'results.json'),
  JSON.stringify({ results, failures }, null, 1),
);
console.log(failures.length ? `FAILURES ${failures.length}` : 'ALL PASS');
process.exit(failures.length ? 1 : 0);
