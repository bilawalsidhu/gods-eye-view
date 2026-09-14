/**
 * Leeway Monte Carlo worker: runs the ensemble off the main thread and
 * transfers the frame buffer back. Pure compute — imports only the model.
 */
import { runEnsemble } from './leeway.js';

self.onmessage = (event) => {
  const { cmd, payload } = event.data ?? {};
  if (cmd !== 'run') return;
  try {
    // payload.landMask arrives by structured clone — never transfer the
    // bitmask data: its buffer is shared with main-thread click gating.
    const result = runEnsemble(payload);
    self.postMessage({
      type: 'result',
      timesMs: result.timesMs,
      frames: result.frames,
      beachedAtFrame: result.beachedAtFrame,
      n: result.n,
      degraded: result.degraded,
      clampedInTime: result.clampedInTime,
      clampedFrames: result.clampedFrames,
      frameCount: result.frameCount,
      meanEndLat: result.meanEndLat,
      meanEndLon: result.meanEndLon,
      spreadKm: result.spreadKm,
    }, [result.timesMs.buffer, result.frames.buffer, result.beachedAtFrame.buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error?.message ?? error) });
  }
};
