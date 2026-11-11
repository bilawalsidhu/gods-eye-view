// Navara ports for the existing heading scenarios. No app viewer is installed.
// Samples come from the renderer handles through the read-only layer probe.
export async function installNavaraHeadingProbe(page) {
  await page.evaluate(async () => {
    const app = window.__godsEyeView;
    if (app.engine.kind !== 'navara') return;
    const geo = await import('/src/geo/index.js');
    const engine = app.engine;
    const drawn = (id) =>
      ['flights', 'military']
        .flatMap((layer) => app.layers.drawn(layer) ?? [])
        .filter((row) => row.id === id);
    window.__findTrackedModel = (id) => {
      const rows = drawn(id);
      const row =
        rows.find((r) => r.trackedModel && r.model?.ready && r.model.show) ??
        rows.find((r) => r.model?.ready && r.model.show);
      return row
        ? {
            id,
            ready: row.model.ready,
            show: row.model.show,
            modelMatrix: row.model.matrix,
          }
        : null;
    };
    window.__courseFromModelMatrix = (mm, offset) => {
      if (!mm) return null;
      const c = geo.cartographic.fromCartesian({
        x: mm[12],
        y: mm[13],
        z: mm[14],
      });
      const ex = -Math.sin(c.longitude),
        ey = Math.cos(c.longitude);
      const nx = -Math.sin(c.latitude) * Math.cos(c.longitude);
      const ny = -Math.sin(c.latitude) * Math.sin(c.longitude),
        nz = Math.cos(c.latitude);
      const h =
        (Math.atan2(
          -(mm[0] * nx + mm[1] * ny + mm[2] * nz),
          mm[0] * ex + mm[1] * ey,
        ) *
          180) /
        Math.PI;
      return (((h - offset) % 360) + 360) % 360;
    };
    const turn = (angle = 0, nearer = 0) => {
      const handle = engine.camera.following();
      const target = handle?.target();
      if (!target)
        throw new Error('Heading screenshot needs a followed target');
      const frame = geo.transforms.eastNorthUpToFixedFrame(target);
      const inverse = geo.matrix4.inverseTransformation(
        frame,
        geo.matrix4.create(),
      );
      const p = geo.matrix4.multiplyByPoint(
        inverse,
        engine.camera.pose().position,
        geo.cartesian3.create(),
      );
      const x = p.x * Math.cos(angle) - p.y * Math.sin(angle);
      const y = p.x * Math.sin(angle) + p.y * Math.cos(angle);
      const range = Math.hypot(x, y, p.z);
      const scale = Math.max(150, range - nearer) / range;
      handle.retarget({
        viewFrom: { x: x * scale, y: y * scale, z: p.z * scale },
      });
    };
    window.__headingView = {
      clock: { currentTime: undefined },
      get trackedEntity() {
        const handle = engine.camera.following();
        if (!handle) return null;
        const label = handle.label;
        const id = label?.id?.split(':').at(-1);
        return {
          gevTrackedId: label?.id,
          gevLabelModel:
            typeof label?.model === 'function' ? label.model() : label?.model,
          gevDisplayPosition: handle.target,
          billboard: {
            rotation: {
              getValue: () => drawn(id).find((r) => r.tracked)?.trackedRotation,
            },
          },
        };
      },
      camera: {
        rotateRight: (a) => turn(a),
        rotateLeft: (a) => turn(-a),
        zoomIn: (m) => turn(0, m),
      },
      scene: {
        preRender: engine.frames.preRender,
        postRender: engine.frames.postRender,
        requestRender: () => engine.render.request('heading-probe'),
      },
    };
    // Observe real Navara frames; unlike Cesium this port does not own a
    // manual viewer loop. The 600 ms case samples at that cadence while
    // Navara continues rendering; the dt-clamp branch is covered by unit QA.
    window.__sampleModelCourse = (id, offset, windowMs, stepMs = 100) =>
      new Promise((resolve) => {
        const samples = [];
        let last = -Infinity;
        const remove = engine.frames.preRender.addEventListener(() => {
          const now = performance.now();
          if (now - last < stepMs) return;
          last = now;
          const model = window.__findTrackedModel(id);
          samples.push({
            tMs: now,
            epochMs: Date.now(),
            course: model
              ? window.__courseFromModelMatrix(model.modelMatrix, offset)
              : null,
          });
        });
        setTimeout(() => {
          remove();
          resolve(samples);
        }, windowMs);
        engine.render.request('heading-probe');
      });
  });
}
