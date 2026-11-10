import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu'],
});
try {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (request) =>
    request.isNavigationRequest()
      ? request.respond({
          status: 200,
          contentType: 'text/html',
          body: '<!doctype html><title>Aircraft artwork verification</title>',
        })
      : request.continue(),
  );
  await page.goto(process.argv[2] || 'http://127.0.0.1:4190/');
  const report = await page.evaluate(async () => {
    const { compileAircraftArtwork } =
      await import('/src/data/aircraftSurface.js');
    const { aircraftIcon } = await import('/src/data/aircraftIcons.js');
    const { CLASS_SCALE_2D } = await import('/src/data/aircraftClass.js');
    const results = [];
    for (const kind of Object.keys(CLASS_SCALE_2D)) {
      const parts = compileAircraftArtwork(kind),
        canvas = document.createElement('canvas'),
        ref = document.createElement('canvas');
      canvas.width = canvas.height = ref.width = ref.height = 512;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(512 / 96, 0, 0, 512 / 96, 256, 256);
      ctx.fillStyle = 'white';
      for (const p of parts) {
        ctx.globalAlpha = p.opacity;
        ctx.fill(p.path);
        if (p.stroke) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = p.stroke;
          ctx.lineWidth = p.lineWidth;
          ctx.lineJoin = 'round';
          ctx.stroke(p.path);
        }
      }
      const image = new Image();
      image.src = aircraftIcon(kind, 512);
      await image.decode();
      const rc = ref.getContext('2d');
      rc.drawImage(image, 0, 0);
      const a = ctx.getImageData(0, 0, 512, 512).data,
        b = rc.getImageData(0, 0, 512, 512).data;
      let alphaError = 0,
        pixels = 0;
      for (let i = 3; i < a.length; i += 4) {
        alphaError += Math.abs(a[i] - b[i]);
        if (a[i]) pixels++;
      }
      results.push({
        kind,
        parts: parts.length,
        pixels,
        meanAlphaError: alphaError / (512 * 512),
      });
      canvas.width = canvas.height = ref.width = ref.height = 1;
    }
    return {
      results,
      specialGlyphsStayNative:
        compileAircraftArtwork('tr3b') === null &&
        compileAircraftArtwork('tr3b-hot') === null,
    };
  });
  await fs.writeFile(
    'qa-artifacts/aircraft-surface/artwork.json',
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  for (const r of report.results) {
    assert.ok(r.parts > 0 && r.pixels > 0, r.kind);
    assert.ok(r.meanAlphaError < 2, `${r.kind}: vector/SVG alpha mismatch`);
  }
  assert.ok(report.specialGlyphsStayNative);
} finally {
  await browser.close();
}
