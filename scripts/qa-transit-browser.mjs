/** Bound page promises as well as CDP itself; labels identify a stalled section. */
export function boundPageEvaluations(page, defaultTimeoutMs = 30000) {
  const evaluate = page.evaluate.bind(page);
  page.evaluate = (fn, ...args) => {
    // The two long trace collectors pass their duration explicitly.
    const duration =
      args.find((v) => typeof v === 'number' && v >= 6000 && v <= 120000) || 0;
    const timeoutMs = Math.max(
      defaultTimeoutMs,
      duration ? duration + 5000 : 0,
    );
    const label = String(fn).slice(0, 120).replace(/\s+/g, ' ');
    return evaluate(
      async (source, values, timeoutMs, label) => {
        let timer;
        try {
          return await Promise.race([
            // Puppeteer callbacks are standalone functions, just as in evaluate.
            Promise.resolve().then(() => (0, eval)(`(${source})`)(...values)),
            new Promise((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error(
                      `Transit QA page wait timed out after ${timeoutMs} ms: ${label}`,
                    ),
                  ),
                timeoutMs,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      },
      String(fn),
      args,
      timeoutMs,
      label,
    );
  };
}

export async function reportTransitVisibility(page, label) {
  const result = await page.evaluate(() => {
    const app = window.__godsEyeView;
    const layer = app.dataManager.layers.get('transit').module;
    const state = layer._transitStateForTest();
    return {
      total: state._vehicles.size,
      visible: state._visible.size,
      moving: state._moving.size,
      held: state._renderHeld,
      requestRenderMode: app.viewer.scene.requestRenderMode,
      renderLoop: app.viewer.useDefaultRenderLoop,
      renderErrors: window.__transitRenderErrors || [],
      bounds: state._viewBounds,
      hidden: layer._transitVisibilityForTest().filter((e) => !e.shown),
    };
  });
  console.log(`  ${label}: ${JSON.stringify(result)}`);
  if (result.renderLoop === false || result.renderErrors.length)
    throw new Error(
      `${label}: Cesium render loop stopped or raised an error: ${JSON.stringify(result.renderErrors)}`,
    );
  return result;
}

/** Intersect primed histories with the new snapshot; disappearance is availability. */
export async function restoreRetainedTransit(retained) {
  if (!retained.length)
    return {
      error: 'No multi-fix history observed during the probe',
      unexercised: true,
    };
  const app = window.__godsEyeView;
  await app.dataManager.setEnabled('transit', true, { source: 'qa' });
  const layer = app.dataManager.layers.get('transit').module;
  const state = layer._transitStateForTest();
  // enable() schedules proximity discovery; an empty pre-discovery map is not
  // evidence that every primed vehicle departed. Wait for this feed's poll.
  const deadline = Date.now() + 12000;
  while (state._activeFeeds && !state._vehicles.size && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 100));
  await layer.update();
  if (
    retained[0]?.primedAt &&
    Math.floor(Date.now() / 60000) !== Math.floor(retained[0].primedAt / 60000)
  )
    return {
      error: 'Reload crossed the priming minute; same-minute proof unavailable',
      unexercised: true,
    };
  const history = retained.find((h) =>
    state._vehicles.has(`${h.feedId || 'mbta'}:${h.vehicleId}`),
  );
  if (!history)
    return {
      error: `All ${retained.length} primed vehicles left the current snapshot`,
      unexercised: true,
    };
  const entry = state._vehicles.get(
    `${history.feedId || 'mbta'}:${history.vehicleId}`,
  );
  const camera = app.viewer.camera,
    C = camera.positionCartographic.constructor;
  camera.setView({
    destination: C.toCartesian(
      C.fromDegrees(entry.record.lon, entry.record.lat, 600),
    ),
    orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
  });
  layer._transitPartsForTest().selection.selectVehicle(entry.key);
  return { key: entry.key, oldest: history.oldestT };
}

export async function sampleTransitPixels(page, palette) {
  return page.evaluate(async (palette) => {
    const app = window.__godsEyeView;
    const state = app.dataManager.layers
      .get('transit')
      .module._transitStateForTest();
    // Decode the actual billboard rasters before the paint being judged.
    const overlay = window.location
      ? await import('/src/overlays/worldOverlay.js')
      : null;
    const rasters = new Map();
    await Promise.all(
      [
        ...new Set(
          [...state._vehicles.values()]
            .map((e) => e.marker?.image)
            .filter(Boolean),
        ),
      ].map(async (url) => {
        const img = new Image();
        img.src = url;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        rasters.set(url, {
          width: c.width,
          height: c.height,
          data: ctx.getImageData(0, 0, c.width, c.height).data,
        });
      }),
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        remove();
        reject(
          new Error('Transit pixel readback: no postRender within 5000 ms'),
        );
      }, 5000);
      const remove =
        window.__godsEyeView.viewer.scene.postRender.addEventListener(() => {
          const app = window.__godsEyeView;
          const layer = app.dataManager.layers.get('transit').module;
          const state = layer._transitStateForTest();
          const scene = app.viewer.scene;
          const canvas = scene.canvas;
          const view = scene.camera.viewMatrix;
          const proj = scene.camera.frustum.projectionMatrix;
          const mul = (m, v) => [
            m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
            m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
            m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
            m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
          ];
          const width = canvas.clientWidth;
          const height = canvas.clientHeight;
          const sprites = [];
          const intersects = (a, b) =>
            a.x < b.x + b.w &&
            a.x + a.w > b.x &&
            a.y < b.y + b.h &&
            a.y + a.h > b.y;
          const plates =
            app.styleManager
              ?.getDetectionDiagnostics?.()
              ?.calloutRects?.filter((r) => r.alpha > 0.01) || [];
          if (state._selectedKey) {
            const card = overlay?.getOverlayPaintRect(
              'transit-selected',
              state._selectedKey,
            );
            if (card) plates.push(card);
          }
          const panels = (overlay?.WORLD_OVERLAY_OCCLUDER_SELECTORS || [])
            .flatMap((selector) => [...document.querySelectorAll(selector)])
            .filter(
              (el) =>
                !el.hidden &&
                el.checkVisibility({
                  checkOpacity: true,
                  checkVisibilityCSS: true,
                }),
            )
            .map((el) => {
              const r = el.getBoundingClientRect();
              return { x: r.left, y: r.top, w: r.width, h: r.height };
            });
          const skipped = [];
          const style = state._stylePreset;
          const uniforms = app.styleManager?.stages?.[style]?.uniforms || {};
          const intensity = uniforms.intensity ?? 1;
          const pixelation =
            uniforms.pixelation ?? (style === 'surveillance' ? 2.5 : 1.5);
          const sensor = style === 'surveillance' || style === 'thermal';
          // Invert NVG's barrel transform; thermal only quantizes the source.
          const screenPoint = (sx, sy) => {
            let x = sx,
              y = sy;
            if (style === 'surveillance') {
              const tx = (sx / width) * 2 - 1,
                ty = (sy / height) * 2 - 1;
              let cx = tx,
                cy = ty;
              for (let i = 0; i < 16; i++) {
                const r2 = cx * cx + cy * cy;
                const d =
                  1 + r2 * intensity * 0.25 + r2 * r2 * intensity * 0.075;
                cx = tx / d;
                cy = ty / d;
              }
              x = ((cx + 1) * width) / 2;
              y = ((cy + 1) * height) / 2;
            }
            const offset = sensor
              ? ((1 + (pixelation - 1) * intensity) * intensity) /
                2 /
                (canvas.width / width)
              : 0;
            return { x: x + offset, y: y - offset };
          };
          const uiBlocked = (x, y) => {
            const el = document.elementFromPoint?.(x, y);
            return (
              el &&
              el !== canvas &&
              !el.closest?.(
                '#world-overlay-root, #world-overlay-detection-surface',
              ) &&
              el.tagName !== 'BODY' &&
              el.tagName !== 'HTML'
            );
          };
          for (const entry of state._vehicles.values()) {
            if (!entry.marker || entry.marker.show === false) continue;
            const p = entry.marker.position;
            const clip = mul(proj, mul(view, [p.x, p.y, p.z, 1]));
            if (!(clip[3] > 0)) continue;
            const screen = entry.marker.computeScreenSpacePosition?.(scene) || {
              x: ((clip[0] / clip[3]) * 0.5 + 0.5) * width,
              y: (1 - ((clip[1] / clip[3]) * 0.5 + 0.5)) * height,
            };
            const rect = entry.marker.constructor.getScreenSpaceBoundingBox?.(
              entry.marker,
              screen,
            ) || { x: screen.x - 16, y: screen.y - 16, width: 32, height: 32 };
            const { x, y } = screenPoint(screen.x, screen.y);
            const c = Math.abs(Math.cos(entry.marker.rotation || 0)),
              sn = Math.abs(Math.sin(entry.marker.rotation || 0));
            const w = rect.width * c + rect.height * sn,
              h = rect.height * c + rect.width * sn;
            const footprint = { x: x - w / 2, y: y - h / 2, w, h };
            let reason = null;
            if (
              rect.x < 0 ||
              rect.y < 0 ||
              rect.x + rect.width > width ||
              rect.y + rect.height > height
            )
              reason = 'billboard rectangle outside frame';
            if (
              entry.marker.color?.alpha < 0.95 ||
              entry.markerCollection?.show === false
            )
              reason = 'billboard not opaque/collection hidden';
            const raster = rasters.get(entry.marker.image);
            if (!raster) reason = 'billboard alpha unavailable';
            else if (
              raster.data[
                (Math.floor(raster.height / 2) * raster.width +
                  Math.floor(raster.width / 2)) *
                  4 +
                  3
              ] < 242
            )
              reason = 'billboard centre is transparent';
            if (
              sensor &&
              Math.hypot(
                (((x / width) * 2 - 1) * width) / height,
                (y / height) * 2 - 1,
              ) > 0.6
            )
              reason = 'outside unmasked sensor lens';
            if (
              [
                [x, y],
                [rect.x, rect.y],
                [rect.x + rect.width, rect.y + rect.height],
                [rect.x + rect.width, rect.y],
                [rect.x, rect.y + rect.height],
              ].some(([px, py]) => uiBlocked(px, py))
            )
              reason = 'UI panel overlaps billboard';
            if (panels.some((r) => intersects(footprint, r)))
              reason = 'UI panel rectangle overlaps billboard';
            if (plates.some((r) => intersects(footprint, r)))
              reason = 'DETECT label/card rectangle overlaps billboard';
            if (reason) {
              skipped.push({ key: entry.key, reason });
              continue;
            }
            if (x < 40 || y < 40 || x > width - 40 || y > height - 40) continue;
            sprites.push({
              key: entry.key,
              mode: entry.mode,
              x,
              y,
              selected: state._selectedKey === entry.key,
              screenX: screen.x,
              screenY: screen.y,
              rect,
              bracketX: entry.detectContact?._candidateScreenX ?? screen.x,
              bracketY: entry.detectContact?._candidateScreenY ?? screen.y,
              raster,
              rotation: entry.marker.rotation || 0,
              halfW: Number.isFinite(entry.marker.width)
                ? Math.ceil(entry.marker.width / 2) + 2
                : 11,
              halfH: Number.isFinite(entry.marker.height)
                ? Math.ceil(entry.marker.height / 2) + 2
                : 7,
            });
          }
          const isolated = sprites.filter(
            (a) =>
              !a.selected &&
              sprites.every(
                (b) => b === a || Math.hypot(a.x - b.x, a.y - b.y) > 44,
              ),
          );
          const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
          const scale = canvas.width / canvas.clientWidth;
          const luma = (r, g, b) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;
          const readLuma = (cx, cy) => {
            const px = Math.floor(cx * scale);
            const py = Math.floor(canvas.height - 1 - cy * scale);
            const buf = new Uint8Array(4);
            gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
            return luma(buf[0], buf[1], buf[2]);
          };
          const surface = document.getElementById('world-overlay-canvas');
          const ctx = surface?.getContext('2d');
          // A hidden surface has no client size; nothing to read there.
          const sscale =
            surface && surface.clientWidth > 0
              ? surface.width / surface.clientWidth
              : 0;
          const out = [];
          for (const s of isolated) {
            if (out.length >= 12) break;
            // The normal canvas includes DETECT plates and selected cards.
            // A plate over the body invalidates this contact, even if WebGL below is hot.
            if (ctx && sscale > 0) {
              const body = ctx.getImageData(
                Math.floor((s.x - 3) * sscale),
                Math.floor((s.y - 3) * sscale),
                Math.max(1, Math.ceil(6 * sscale)),
                Math.max(1, Math.ceil(6 * sscale)),
              ).data;
              if (body.some((v, i) => i % 4 === 3 && v > 0)) {
                skipped.push({
                  key: s.key,
                  reason: 'DETECT label/card overlaps core',
                });
                continue;
              }
            }
            let centre = 0;
            for (let dx = -1; dx <= 1; dx += 1)
              for (let dy = -1; dy <= 1; dy += 1)
                centre += readLuma(s.x + dx, s.y + dy) / 9;
            let ringMin = 1;
            let ringMax = 0;
            // Sample the actual rotated raster halo, not a fixed-radius circle
            // that can hit the hot body or terrain after a display-size change.
            const raster = s.raster;
            const cos = Math.cos(s.rotation),
              sin = Math.sin(s.rotation);
            for (let ry = 1; ry < raster.height - 1; ry++)
              for (let rx = 1; rx < raster.width - 1; rx++) {
                const i = (ry * raster.width + rx) * 4;
                if (
                  raster.data[i + 3] < 200 ||
                  raster.data[i] > 30 ||
                  raster.data[i + 1] > 30 ||
                  raster.data[i + 2] > 30
                )
                  continue;
                const dx = ((rx + 0.5) / raster.width - 0.5) * s.rect.width;
                const dy = ((ry + 0.5) / raster.height - 0.5) * s.rect.height;
                const q = screenPoint(
                  s.screenX + dx * cos + dy * sin,
                  s.screenY - dx * sin + dy * cos,
                );
                const v = readLuma(q.x, q.y);
                ringMin = Math.min(ringMin, v);
                ringMax = Math.max(ringMax, v);
              }
            let bracket = null;
            if (ctx && sscale > 0) {
              // Transit brackets follow the padded sprite extent and snapped
              // stroke centres. Sample the middle of each straight segment,
              // never a colour histogram containing antialiased edges/callouts.
              const cx = Math.floor(s.bracketX) + 0.5,
                cy = Math.floor(s.bracketY) + 0.5;
              const hw = s.halfW,
                hh = s.halfH,
                mid = Math.max(4, Math.floor(Math.min(hw, hh) * 0.55)) / 2;
              const points = [
                [cx - hw + mid, cy - hh],
                [cx + hw - mid, cy - hh],
                [cx - hw + mid, cy + hh],
                [cx + hw - mid, cy + hh],
                [cx - hw, cy - hh + mid],
                [cx + hw, cy - hh + mid],
                [cx - hw, cy + hh - mid],
                [cx + hw, cy + hh - mid],
              ];
              let bestAlpha = 0;
              for (const [index, [x, y]] of points.entries()) {
                if (
                  uiBlocked(x, y) ||
                  plates.some((r) =>
                    intersects({ x: x - 1, y: y - 1, w: 2, h: 2 }, r),
                  )
                )
                  continue;
                // A label plate fills both sides of a stroke. Require empty
                // pixels beyond its dark backing on the perpendicular axis.
                const normal = index < 4 ? [0, 3] : [3, 0];
                if (
                  [-1, 1].some(
                    (sign) =>
                      ctx.getImageData(
                        Math.floor((x + sign * normal[0]) * sscale),
                        Math.floor((y + sign * normal[1]) * sscale),
                        1,
                        1,
                      ).data[3] > 0,
                  )
                )
                  continue;
                const data = ctx.getImageData(
                  Math.floor(x * sscale),
                  Math.floor(y * sscale),
                  1,
                  1,
                ).data;
                if (data[3] > bestAlpha) {
                  bestAlpha = data[3];
                  bracket = [data[0], data[1], data[2]];
                }
              }
            }
            out.push({
              key: s.key,
              mode: s.mode,
              verified: true,
              rectangle: s.rect,
              centre,
              background:
                [
                  readLuma(s.x + 25, s.y),
                  readLuma(s.x - 25, s.y),
                  readLuma(s.x, s.y + 25),
                  readLuma(s.x, s.y - 25),
                ].reduce((a, b) => a + b, 0) / 4,
              ringMin,
              ringMax,
              bracket,
              bracketTier: `transit_${s.mode}`,
              bracketExpected: palette[s.mode]
                ? [1, 3, 5].map((i) =>
                    parseInt(palette[s.mode].slice(i, i + 2), 16),
                  )
                : null,
              x: s.x,
              y: s.y,
            });
          }
          clearTimeout(timer);
          remove();
          console.log(
            `TRANSIT_SAMPLER ${style}: ${out.length} verified; skipped=${JSON.stringify(skipped)}`,
          );
          resolve(out);
        });
      window.__godsEyeView.viewer.scene.requestRender();
    });
  }, palette);
}

/** A fleet-to-fleet comparison must not inherit the city's selected marker. */
export function readTransitFleetStyle({ key, resetSelection = false } = {}) {
  const layer = window.__godsEyeView.dataManager.layers.get('transit').module;
  const state = layer._transitStateForTest();
  if (resetSelection) layer._transitPartsForTest().selection.clearSelection();
  const entry = key
    ? state._vehicles.get(key)
    : [...state._vehicles.values()].find((e) => e.marker?.show);
  return entry
    ? {
        key: entry.key,
        selected: state._selectedKey === entry.key,
        color: entry.marker.color.toCssColorString(),
        width: entry.marker.width,
        image: entry.marker.image,
      }
    : null;
}
