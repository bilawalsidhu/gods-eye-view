/**
 * qa-journey-recorder.mjs — shared support for journey QA gates (not a gate).
 *
 * - `createScreencast(page, dir)` records CDP `Page.startScreencast` frames
 *   (every compositor frame) with their real timestamps and builds
 *   `<dir>/clip.mp4` through ffmpeg's concat demuxer with per-frame
 *   durations, so held frames last as long as they did on screen.
 * - `installFrameProbe(page)` measures every animation frame in the page:
 *   the requestAnimationFrame interval and, for frames Cesium rendered, the
 *   CPU time between `scene.preUpdate` and `scene.postRender`.
 * - `frameStats(frames)` reduces a probe window to count / mean / p50 / p95.
 * - `moveCamera(page, view, seconds)` eases the camera like a drag or wheel
 *   zoom rather than teleporting it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Percentile of a numeric list (nearest rank); NaN for an empty list. */
export function percentile(values, p) {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ];
}

/** Summarize probe frames: rAF interval and Cesium render CPU time (ms). */
export function frameStats(frames) {
  const intervals = frames.map((f) => f.dt).filter(Number.isFinite);
  const renders = frames.map((f) => f.renderMs).filter(Number.isFinite);
  const round = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
  const mean = (list) =>
    list.length ? list.reduce((a, b) => a + b, 0) / list.length : Number.NaN;
  return {
    frames: intervals.length,
    frameMean: round(mean(intervals)),
    frameP50: round(percentile(intervals, 50)),
    frameP95: round(percentile(intervals, 95)),
    longFrames: intervals.filter((v) => v > 50).length,
    renderedFrames: renders.length,
    renderMean: round(mean(renders)),
    renderP50: round(percentile(renders, 50)),
    renderP95: round(percentile(renders, 95)),
  };
}

/** Install the in-page frame probe once per document; returns nothing. */
export async function installFrameProbe(page) {
  await page.evaluate(() => {
    if (window.__gevFrameProbe) return;
    const { viewer } = window.__godsEyeView;
    const probe = { frames: [], started: 0 };
    window.__gevFrameProbe = probe;
    let last = performance.now();
    let renderStart = null;
    let pendingRender = null;
    viewer.scene.preUpdate.addEventListener(() => {
      renderStart = performance.now();
    });
    viewer.scene.postRender.addEventListener(() => {
      if (renderStart !== null) pendingRender = performance.now() - renderStart;
      renderStart = null;
    });
    const tick = (now) => {
      probe.frames.push({ t: now, dt: now - last, renderMs: pendingRender });
      if (probe.frames.length > 40_000) probe.frames.splice(0, 10_000);
      pendingRender = null;
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Read probe frames with t in [t0, t1) (page performance.now() times). */
export async function readFrames(page, t0, t1 = Infinity) {
  return page.evaluate(
    (a, b) =>
      window.__gevFrameProbe.frames.filter(
        (f) => f.t >= a && f.t < (b ?? Infinity),
      ),
    t0,
    Number.isFinite(t1) ? t1 : null,
  );
}

/** Page clock in ms (performance.now()). */
export function pageNow(page) {
  return page.evaluate(() => performance.now());
}

/**
 * Ease the camera to a view over `seconds`, resolving when it lands.
 * @param {import('puppeteer').Page} page Page.
 * @param {{lat:number, lon:number, height:number, heading?:number, pitch?:number}} view
 *   Destination (degrees, metres).
 * @param {number} seconds Flight duration; 0 jumps.
 */
export async function moveCamera(page, view, seconds) {
  await page.evaluate(
    (v, duration) =>
      new Promise((resolve) => {
        const { viewer } = window.__godsEyeView;
        const C = viewer.camera;
        C.cancelFlight();
        C.flyTo({
          destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({
            latitude: (v.lat * Math.PI) / 180,
            longitude: (v.lon * Math.PI) / 180,
            height: v.height,
          }),
          orientation: {
            heading: ((v.heading ?? 0) * Math.PI) / 180,
            pitch: ((v.pitch ?? -45) * Math.PI) / 180,
            roll: 0,
          },
          duration,
          // Straight, eased motion like a drag or wheel zoom, not an arc.
          maximumHeight: Math.max(v.height, C.positionCartographic.height),
          complete: resolve,
          cancel: resolve,
        });
      }),
    view,
    seconds,
  );
}

/**
 * Record the page with CDP screencast frames and real per-frame timing.
 * @param {import('puppeteer').Page} page Page to record.
 * @param {string} dir Output directory (frames + clip.mp4).
 * @param {{maxWidth?: number, maxHeight?: number, quality?: number, fps?: number|null}} [options]
 */
export async function createScreencast(page, dir, options = {}) {
  const {
    maxWidth = 1280,
    maxHeight = 800,
    quality = 70,
    fps = null,
  } = options;
  const framesDir = path.join(dir, 'frames');
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });
  const cdp = await page.createCDPSession();
  const frames = [];
  let recording = false;
  cdp.on('Page.screencastFrame', async (frame) => {
    const file = path.join(
      framesDir,
      `f${String(frames.length).padStart(5, '0')}.jpg`,
    );
    if (recording) {
      fs.writeFileSync(file, Buffer.from(frame.data, 'base64'));
      frames.push({ file, timestamp: frame.metadata.timestamp });
    }
    await cdp
      .send('Page.screencastFrameAck', { sessionId: frame.sessionId })
      .catch(() => {});
  });
  return {
    frames,
    async start() {
      recording = true;
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality,
        maxWidth,
        maxHeight,
        everyNthFrame: 1,
      });
    },
    /** Stop, encode with real timing, and return clip facts. */
    async stop() {
      recording = false;
      await cdp.send('Page.stopScreencast').catch(() => {});
      await cdp.detach().catch(() => {});
      if (frames.length < 2) return { clip: null, frames: frames.length };
      const lines = [];
      for (let i = 0; i < frames.length; i++) {
        const next = frames[i + 1]?.timestamp;
        const duration = next
          ? Math.min(2, Math.max(0.001, next - frames[i].timestamp))
          : 0.05;
        lines.push(`file '${path.resolve(frames[i].file)}'`);
        lines.push(`duration ${duration.toFixed(4)}`);
      }
      // The concat demuxer ignores the last duration unless the file repeats.
      lines.push(`file '${path.resolve(frames.at(-1).file)}'`);
      const list = path.join(dir, 'frames.txt');
      fs.writeFileSync(list, `${lines.join('\n')}\n`);
      const clip = path.join(dir, 'clip.mp4');
      execFileSync('ffmpeg', [
        '-y',
        '-loglevel',
        'error',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        list,
        '-fps_mode',
        fps ? 'cfr' : 'vfr',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-vf',
        `scale=trunc(iw/2)*2:trunc(ih/2)*2${fps ? `,fps=${fps}` : ''}`,
        clip,
      ]);
      const seconds = frames.at(-1).timestamp - frames[0].timestamp;
      return {
        clip,
        frames: frames.length,
        seconds: Math.round(seconds * 10) / 10,
        fps: Math.round((frames.length / Math.max(seconds, 0.001)) * 10) / 10,
      };
    },
  };
}
