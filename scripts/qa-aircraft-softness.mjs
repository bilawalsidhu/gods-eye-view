import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import sharp from 'sharp';
const out = process.argv[3] || 'qa-artifacts/native-softness';
await fs.mkdir(out, { recursive: true });
const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 860, deviceScaleFactor: 2 });
  await page.evaluateOnNewDocument(() => {
    const fetchOriginal = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : input.url,
        location.href,
      );
      const json = (value) =>
        Promise.resolve(
          new Response(JSON.stringify(value), {
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      if (url.pathname === '/api/flights') {
        const now = Math.floor(Date.now() / 1000);
        return json({
          time: now,
          states: Array.from({ length: 500 }, (_, i) => [
            (0xc00000 + i).toString(16),
            `TEST${i}`,
            'Fixture',
            now,
            now,
            -123 + (i % 25) * 0.1,
            37 + Math.floor(i / 25) * 0.15,
            10000,
            false,
            0,
            i % 360,
            0,
            null,
            10000,
            null,
            false,
            0,
          ]),
        });
      }
      if (url.pathname === '/api/military') return json({ ac: [] });
      if (/^\/api\/adsbdb\//.test(url.pathname)) return json({});
      return fetchOriginal(input, init);
    };
  });
  await page.goto(
    `${process.argv[2] || 'http://127.0.0.1:4180'}/?welcome=0#v=2&lat=38.6754&lon=-121.9409&alt=534030&heading=328&pitch=-90&roll=0&style=normal&bloom=0&sharpen=1&si=49&dm=DENSE&map=esri-imagery&l=f`,
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 90000 },
  );
  await new Promise((r) => setTimeout(r, 12000));
  console.log(
    JSON.stringify(
      await page.evaluate(() => {
        const app = window.__godsEyeView,
          v = app.viewer,
          scene = v.scene,
          rows = [];
        const visit = (c) => {
          for (let i = 0; i < c.length; i++) {
            const p = c.get(i);
            if (Number.isFinite(p.renderedCount)) {
              for (let j = 0; j < p.length; j++) {
                const b = p.get(j);
                if (!b.viewportVisible || !b.show) continue;
                const d = Cesium.Cartesian3.distance(
                    v.camera.positionWC,
                    b.position,
                  ),
                  s = b.scaleByDistance;
                const t = s
                  ? Math.pow(
                      Math.max(
                        0,
                        Math.min(
                          1,
                          (d * d - s.near * s.near) /
                            (s.far * s.far - s.near * s.near),
                        ),
                      ),
                      0.2,
                    )
                  : 0;
                const ds = s ? s.nearValue + (s.farValue - s.nearValue) * t : 1;
                const xy = Cesium.SceneTransforms.worldToWindowCoordinates(
                  scene,
                  b.position,
                );
                rows.push({
                  id: b.id,
                  width: b.width,
                  scale: b.scale,
                  distanceScale: ds,
                  css: b.width * b.scale * ds,
                  raster: b._gevIconPx,
                  svg: b.image?.slice(0, 40),
                  xy,
                });
              }
            } else if (
              typeof p.get === 'function' &&
              Number.isInteger(p.length)
            )
              visit(p);
          }
        };
        visit(scene.primitives);
        rows.sort((a, b) => b.css - a.css);
        return {
          ratio: scene.drawingBufferWidth / scene.canvas.clientWidth,
          dpr: devicePixelRatio,
          fxaa: scene.postProcessStages.fxaa.enabled,
          stages: Array.from(
            { length: scene.postProcessStages.length },
            (_, i) => ({
              name: scene.postProcessStages.get(i).name,
              enabled: scene.postProcessStages.get(i).enabled,
            }),
          ),
          params: app.dataManager.layers.get('flights').module.getParams?.(),
          rows: rows.slice(0, 25),
        };
      }),
      null,
      2,
    ),
  );
  for (const [label, ratio, msaa] of [
    ['before', 1.5, 4],
    ['retina', 2, 2],
    ['supersampled', 1.5, 4],
    ['retina-supersampled', 2, 2],
  ]) {
    await page.evaluate(
      ({ ratio, msaa }) => {
        const v = window.__godsEyeView.viewer;
        v.resolutionScale = ratio;
        v.scene.msaaSamples = msaa;
        v.resize();
        v.scene.requestRender();
      },
      { ratio, msaa },
    );
    await new Promise((r) => setTimeout(r, 1500));
    if (label.includes('supersampled')) {
      await page.evaluate(() => {
        const scene = window.__godsEyeView.viewer.scene;
        const visit = (c) => {
          for (let i = 0; i < c.length; i++) {
            const p = c.get(i);
            if (Number.isFinite(p.renderedCount)) {
              for (let j = 0; j < p.length; j++) {
                const b = p.get(j);
                if (!b.image?.startsWith('data:image/svg+xml;base64,'))
                  continue;
                const svg = atob(b.image.split(',')[1]).replace(
                  /width="\d+" height="\d+"/,
                  'width="192" height="192"',
                );
                b.image = 'data:image/svg+xml;base64,' + btoa(svg);
              }
            } else if (
              typeof p.get === 'function' &&
              Number.isInteger(p.length)
            )
              visit(p);
          }
        };
        visit(scene.primitives);
        scene.requestRender();
      });
      await new Promise((r) => setTimeout(r, 1500));
    }
    await page.screenshot({ path: `${out}/${label}.png` });
    await sharp(`${out}/${label}.png`)
      .extract({ left: 900, top: 400, width: 800, height: 800 })
      .toFile(`${out}/${label}-crop.png`);
  }
} finally {
  await browser.close();
}
