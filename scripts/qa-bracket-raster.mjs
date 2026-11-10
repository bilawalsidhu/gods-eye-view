import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { DetectionBracketRaster } from '../src/data/detectionBracketRaster.js';
const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : []),
  ],
});
try {
  const page = await browser.newPage();
  const results = await page.evaluate((source) => {
    const Raster = new Function(`return (${source})`)();
    const results = [];
    for (const dpr of [1, 1.5, 2])
      for (const alpha of [1, 0.37]) {
        const frame = { width: 321, height: 181, dpr };
        const make = () => {
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(frame.width * dpr);
          canvas.height = Math.round(frame.height * dpr);
          const ctx = canvas.getContext('2d');
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.fillStyle = '#18394b';
          ctx.fillRect(0, 0, frame.width, frame.height);
          return { canvas, ctx };
        };
        const original = make(),
          cached = make(),
          paths = new Map();
        for (const color of ['#00ffff', '#ffb800', '#ffffff']) {
          const bands = [];
          for (let band = 1; band <= 4; band++) {
            const path = new Path2D();
            for (let i = 0; i < 70; i++)
              path.rect(
                ((i * 13 + band * 3) % 330) - 8,
                ((i * 17 + band * 3) % 190) - 8,
                8.25,
                11.75,
              );
            bands.push({ color, alpha: band / 4, path });
          }
          paths.set(color, bands);
        }
        for (const bands of paths.values())
          for (const entry of bands) {
            original.ctx.lineWidth = 1.25;
            original.ctx.strokeStyle = entry.color;
            original.ctx.globalAlpha = alpha * entry.alpha;
            original.ctx.stroke(entry.path);
          }
        const raster = new Raster();
        const used = raster.draw(
          cached.ctx,
          { count: 10000, paths },
          frame,
          1.25,
          alpha,
        );
        const a = original.ctx.getImageData(
            0,
            0,
            original.canvas.width,
            original.canvas.height,
          ).data,
          b = cached.ctx.getImageData(
            0,
            0,
            cached.canvas.width,
            cached.canvas.height,
          ).data;
        let max = 0,
          total = 0;
        for (let i = 0; i < a.length; i++) {
          const diff = Math.abs(a[i] - b[i]);
          max = Math.max(max, diff);
          total += diff;
        }
        results.push({
          dpr,
          alpha,
          used,
          maxChannelDifference: max,
          meanChannelDifference: total / a.length,
        });
        raster.clear();
      }
    return results;
  }, DetectionBracketRaster.toString());
  console.log(JSON.stringify(results, null, 2));
  assert.ok(
    results.every(
      (r) =>
        r.used && r.maxChannelDifference <= 2 && r.meanChannelDifference < 0.1,
    ),
    'Raster compositing must preserve bracket appearance',
  );
} finally {
  await browser.close();
}
