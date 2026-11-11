/** Observe a quiet request-mode globe, then measure it without requesting frames. */
export function measureIdleRender(
  page,
  { quietMs = 600, sampleMs = 5000, timeoutMs = 15000 } = {},
) {
  return page.evaluate(
    ({ quietMs, sampleMs, timeoutMs }) =>
      new Promise((resolve, reject) => {
        const { engine } = window.__godsEyeView;
        const started = performance.now();
        let lastActivity = started;
        let measuringAt = null;
        let renders = 0;
        let framesWithPendingTiles = 0;
        let tilesLoadedBefore = false;
        const settlingRequests = {};
        const requests = {};
        const original = engine.render.request;
        const observedRequest = function (reason = 'globe-engine') {
          const now = performance.now();
          lastActivity = now;
          const counts = measuringAt === null ? settlingRequests : requests;
          const row = (counts[reason] ??= {
            count: 0,
            firstMs: now - started,
            lastMs: 0,
          });
          row.count++;
          row.lastMs = now - started;
          return original.apply(this, arguments);
        };
        engine.render.request = observedRequest;
        const remove = engine.frames.postRender.addEventListener(() => {
          lastActivity = performance.now();
          if (measuringAt === null) return;
          renders++;
          if (!engine.surface.tilesLoaded()) framesWithPendingTiles++;
        });
        const cleanup = () => {
          clearInterval(timer);
          remove();
          if (engine.render.request === observedRequest)
            engine.render.request = original;
        };
        const timer = setInterval(() => {
          if (window.__godsEyeView.engine !== engine || engine.isDestroyed()) {
            cleanup();
            reject(new Error('Idle observation interrupted: engine changed'));
            return;
          }
          const now = performance.now();
          const tilesLoaded = engine.surface.tilesLoaded();
          if (measuringAt === null) {
            if (
              !tilesLoaded ||
              engine.camera.flightActive() ||
              engine.render.isContinuous()
            )
              lastActivity = now;
            if (now - lastActivity >= quietMs) {
              measuringAt = now;
              tilesLoadedBefore = tilesLoaded;
            } else if (now - started >= timeoutMs) {
              cleanup();
              reject(
                new Error(
                  `Readiness timeout: idle render; ${JSON.stringify({ tilesLoaded, settlingRequests })}`,
                ),
              );
            }
            return;
          }
          if (now - measuringAt < sampleMs) return;
          cleanup();
          const governor =
            window.__godsEyeView.getRenderGovernorDiagnostics?.();
          resolve({
            renders,
            settleMs: Math.round(measuringAt - started),
            settlingRequests,
            requests,
            tilesLoadedBefore,
            tilesLoadedAfter: tilesLoaded,
            framesWithPendingTiles,
            mode: governor?.mode,
            holds: governor?.holds,
          });
        }, 50);
      }),
    { quietMs, sampleMs, timeoutMs },
  );
}
