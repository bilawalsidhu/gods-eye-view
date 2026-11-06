/**
 * The conformance page: runs the logic suite in the browser, and draws the
 * reference scenes on a renderer to check them against the stored
 * references (or record new ones). Driven by hand or through the
 * chrome-devtools MCP; `window.conformance` exposes the same actions.
 */
import {
  DEFAULT_TOLERANCE,
  runConformance,
} from '../../src/render/conformance/index.js';
import {
  REFERENCE_SCENES,
  sceneSupport,
} from '../../src/render/conformance/scenes.js';
import {
  compareImages,
  drawScene,
  referenceName,
} from '../../src/render/conformance/visual.js';
import { createStubHarness } from '../../src/render/stub/harness.js';
import { toEcef } from '../../src/render/stub/math.js';
import { createCesiumSceneRenderer } from '../../src/render/cesium/sceneRenderer.js';
import {
  CESIUM_CHECKS,
  createCesiumHarness,
} from '../../src/render/cesium/harness.js';

const REFERENCES = '/src/render/conformance/goldens/visual/';
const SAVE = '/__conformance/references/';
const ctx = { toEcef, assets: { model: '/models/c172.glb' } };
const $ = (id) => document.getElementById(id);
const status = (text) => ($('status').textContent = text);

const RENDERERS = {
  cesium: () => createCesiumSceneRenderer({ container: $('stage') }),
};

const HARNESSES = {
  stub: () => [createStubHarness('stub (browser)'), {}],
  cesium: () => [
    createCesiumHarness({ model: ctx.assets.model }),
    { only: (id) => CESIUM_CHECKS.has(id) },
  ],
};

/** Runs the logic suite on `which`; `all` runs every check, listed or not. */
async function runLogic(which = 'stub', { all = false } = {}) {
  status(`running the logic suite on ${which}…`);
  const [harness, options] = HARNESSES[which]();
  const report = await runConformance(harness, all ? {} : options);
  $('logicResults').innerHTML =
    `<p>${report.harness}: <b class="pass">${report.passed} passed</b>, <b class="fail">${report.failed} failed</b>, ${report.skipped} skipped</p>
    <table>${report.results
      .filter((r) => r.status !== 'pass')
      .map(
        (r) =>
          `<tr><td class="${r.status}">${r.status}</td><td>${r.id}</td><td>${escape(r.detail ?? '')}</td></tr>`,
      )
      .join('')}</table>`;
  status('');
  return {
    passed: report.passed,
    failed: report.failed,
    skipped: report.skipped,
    failures: report.results.filter((r) => r.status === 'fail'),
  };
}

const escape = (s) =>
  s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

async function pixels(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const g = canvas.getContext('2d');
  g.drawImage(bitmap, 0, 0);
  return g.getImageData(0, 0, bitmap.width, bitmap.height);
}

// Object URLs shown for the current run, revoked when the next one starts.
let objectUrls = [];
function objectUrl(blob) {
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  return url;
}

async function toUrl(imageData) {
  const canvas = new OffscreenCanvas(imageData.width, imageData.height);
  canvas.getContext('2d').putImageData(imageData, 0, 0);
  return objectUrl(await canvas.convertToBlob());
}

/** The views the stored manifest lists, or none. */
async function storedViews() {
  try {
    const res = await fetch(REFERENCES + 'manifest.json', {
      cache: 'no-store',
    });
    return res.ok ? ((await res.json()).views ?? []) : [];
  } catch {
    return [];
  }
}

async function reference(name) {
  const res = await fetch(REFERENCES + name, { cache: 'no-store' });
  return res.ok && res.headers.get('content-type')?.startsWith('image/')
    ? res.blob()
    : null;
}

/** Draws every scene; records references or compares against them. */
async function runScenes({ record = false, only } = {}) {
  const which = $('renderer').value;
  const renderer = await RENDERERS[which]();
  const results = [];
  $('views').innerHTML = '';
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls = [];
  try {
    for (const scene of REFERENCE_SCENES) {
      if (only && !only.includes(scene.id)) continue;
      const unsupported = sceneSupport(scene, renderer, ctx);
      if (unsupported) {
        results.push({ scene: scene.id, status: 'skip', detail: unsupported });
        continue;
      }
      status(`${scene.id}…`);
      await drawScene(renderer, scene, ctx, async (view, capture, settle) => {
        const name = referenceName(scene.id, view.name);
        const figure = document.createElement('figure');
        $('views').append(figure);
        if (settle.state !== 'settled') {
          const detail = `${settle.state}: ${settle.blockers.join(', ')}`;
          results.push({
            scene: scene.id,
            view: view.name,
            status: 'fail',
            detail,
          });
          figure.innerHTML = `<img src="${objectUrl(capture)}"><figcaption class="fail">${name}: ${escape(detail)}</figcaption>`;
          return;
        }
        if (record) {
          const res = await fetch(SAVE + name, {
            method: 'PUT',
            body: capture,
          });
          results.push({
            scene: scene.id,
            view: view.name,
            status: res.ok ? 'recorded' : 'fail',
            detail: res.ok ? undefined : `save ${res.status}`,
          });
          figure.innerHTML = `<img src="${objectUrl(capture)}"><figcaption>${name}: recorded</figcaption>`;
          return;
        }
        const refBlob = await reference(name);
        if (!refBlob) {
          results.push({
            scene: scene.id,
            view: view.name,
            status: 'fail',
            detail: 'no reference',
          });
          figure.innerHTML = `<img src="${objectUrl(capture)}"><figcaption class="fail">${name}: no reference</figcaption>`;
          return;
        }
        const [actual, expected] = await Promise.all([
          pixels(capture),
          pixels(refBlob),
        ]);
        const diff = new Uint8ClampedArray(actual.data.length);
        const outcome = compareImages(actual, expected, { diff });
        results.push({
          scene: scene.id,
          view: view.name,
          status: outcome.match ? 'pass' : 'fail',
          diffFraction: outcome.diffFraction,
          solidPixels: outcome.solidPixels,
          mismatchedPixels: outcome.mismatchedPixels,
          ...(outcome.reason ? { detail: outcome.reason } : {}),
        });
        const diffUrl = outcome.reason
          ? ''
          : await toUrl(new ImageData(diff, actual.width, actual.height));
        figure.innerHTML = `<div class="row"><img src="${objectUrl(capture)}" title="${which}"><img src="${objectUrl(refBlob)}" title="reference"><img src="${diffUrl}" title="difference"></div>
          <figcaption class="${outcome.match ? 'pass' : 'fail'}">${name}: ${outcome.solidPixels} solid, ${outcome.mismatchedPixels} unexcused, ${(outcome.diffFraction * 100).toFixed(3)}% differ ${outcome.reason ?? ''}</figcaption>`;
      });
    }
    if (record) {
      // A partial recording keeps the other scenes' entries.
      const kept = only
        ? (await storedViews()).filter(
            (view) => !only.some((id) => view.startsWith(`${id}-`)),
          )
        : [];
      const recorded = results
        .filter((r) => r.status === 'recorded')
        .map((r) => referenceName(r.scene, r.view));
      await fetch(SAVE + 'manifest.json', {
        method: 'PUT',
        body:
          JSON.stringify(
            {
              renderer: which,
              size: {
                width: renderer.canvas.width,
                height: renderer.canvas.height,
              },
              views: [...kept, ...recorded],
            },
            null,
            2,
          ) + '\n',
      });
    }
  } finally {
    renderer.destroy();
    status('');
  }
  return results;
}

$('logic').onclick = () => runLogic('stub');
$('logicCesium').onclick = () => runLogic('cesium');
$('check').onclick = () => runScenes();
$('record').onclick = () => runScenes({ record: true });
window.conformance = { runLogic, runScenes };
