const clamp01 = (value) => Math.max(0, Math.min(1, value));

/** Own playback timers and scene-clock subscriptions independently of renderer and editor state. */
export function createPlaybackClock(options) {
  return new PlaybackClock(options);
}

class PlaybackClock {
  constructor({
    isRunning,
    timingForShot,
    onProgress,
    now = () => Date.now(),
    schedule = (callback, ms) => setInterval(callback, ms),
    cancel = (timer) => clearInterval(timer),
  }) {
    this.isRunning = isRunning;
    this.timingForShot = timingForShot;
    this.onProgress = onProgress;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this._progressTimer = null;
    this._shotProgressTimer = null;
    this._sceneClockTimer = null;
    this._sceneClockListeners = new Set();
    this._sceneClockSnapshot = null;
    this._destroyed = false;
    this._waitGeneration = 0;
    this._shotGeneration = 0;
    this._sceneGeneration = 0;
    this._waiters = new Set();
  }

  get snapshot() {
    return this._sceneClockSnapshot ? { ...this._sceneClockSnapshot } : null;
  }
  get activeTimers() {
    return (
      [
        this._progressTimer,
        this._shotProgressTimer,
        this._sceneClockTimer,
      ].filter((timer) => timer !== null).length + this._waiters.size
    );
  }

  stopShot() {
    this._shotGeneration++;
    this.cancel(this._shotProgressTimer);
    this._shotProgressTimer = null;
  }
  stopSceneTimer() {
    this._sceneGeneration++;
    this.cancel(this._sceneClockTimer);
    this._sceneClockTimer = null;
  }
  finish() {
    this.cancel(this._progressTimer);
    this._progressTimer = null;
    this.stopSceneTimer();
  }
  stop() {
    this.cancelWaits();
    this.stopShot();
    this.finish();
    if (
      !this._sceneClockSnapshot ||
      this._sceneClockSnapshot.stopped ||
      this._destroyed
    )
      return;
    this._sceneClockSnapshot = {
      ...this._sceneClockSnapshot,
      running: false,
      stopped: true,
    };
    for (const listener of this._sceneClockListeners) {
      try {
        listener(this.snapshot);
      } catch {
        /* Observers cannot block cancellation. */
      }
    }
  }
  destroy() {
    this.cancelWaits();
    this._destroyed = true;
    this.stopShot();
    this.finish();
    this._sceneClockListeners.clear();
    this._sceneClockSnapshot = null;
  }

  cancelWaits() {
    this._waitGeneration++;
    for (const finish of [...this._waiters]) finish();
  }

  /** Own cancellable hold delays; Stop and destroy settle pending waiters immediately. */
  async wait(ms, token) {
    const generation = this._waitGeneration;
    const endAt = this.now() + ms;
    const current = () =>
      !this._destroyed &&
      generation === this._waitGeneration &&
      !token.cancelled &&
      !token.signal?.aborted;
    while (current() && this.now() < endAt) {
      await new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          token.signal?.removeEventListener('abort', finish);
          this._waiters.delete(finish);
          resolve();
        };
        const timer = setTimeout(finish, 70);
        this._waiters.add(finish);
        token.signal?.addEventListener('abort', finish, { once: true });
      });
    }
  }

  subscribe(listener) {
    if (this._destroyed || typeof listener !== 'function') return () => {};
    this._sceneClockListeners.add(listener);
    if (this._sceneClockSnapshot) listener({ ...this._sceneClockSnapshot });
    return () => this._sceneClockListeners.delete(listener);
  }

  publish(
    scene,
    shot,
    sceneElapsedSec,
    { running = this.isRunning(), seeking = false } = {},
  ) {
    if (this._destroyed || !scene || !shot) return;
    const timing = this.timingForShot(scene, shot);
    const elapsedSec = Math.max(
      0,
      Math.min(timing.totalSec, Number(sceneElapsedSec) || 0),
    );
    this._sceneClockSnapshot = {
      sceneId: scene.id,
      shotId: shot.id,
      shotIndex: timing.shotIndex,
      shotCount: scene.shots.length,
      sceneElapsedSec: elapsedSec,
      sceneDurationSec: timing.totalSec,
      sceneProgress: timing.totalSec > 0 ? elapsedSec / timing.totalSec : 0,
      running: Boolean(running),
      seeking: Boolean(seeking),
    };
    for (const listener of this._sceneClockListeners) {
      try {
        listener({ ...this._sceneClockSnapshot });
      } catch (error) {
        console.warn('[Scenes] Scene clock listener failed:', error);
      }
    }
  }

  startRunProgress(totalSec) {
    this.cancel(this._progressTimer);
    if (this._destroyed) return;
    const startMs = this.now();
    const totalMs = Math.max(1000, totalSec * 1000);
    const timer = this.schedule(() => {
      if (this._destroyed || this._progressTimer !== timer || !this.isRunning())
        return;
      const elapsedMs = this.now() - startMs;
      this.onProgress(elapsedMs / totalMs);
    }, 100);
    this._progressTimer = timer;
  }

  startShotProgress(token, seconds, from, to, sceneClock = null) {
    this.stopShot();
    const generation = this._shotGeneration;
    if (
      generation !== this._shotGeneration ||
      this._destroyed ||
      token.cancelled ||
      token.signal?.aborted ||
      this.isRunning()
    )
      return;
    this.onProgress(from);
    if (generation !== this._shotGeneration || this._destroyed) return;
    if (sceneClock) {
      this.publish(
        sceneClock.scene,
        sceneClock.shot,
        sceneClock.sceneElapsedFrom,
        { running: false },
      );
    }
    if (
      generation !== this._shotGeneration ||
      this._destroyed ||
      token.cancelled ||
      token.signal?.aborted ||
      this.isRunning()
    )
      return;
    if (seconds <= 0) {
      this.onProgress(to);
      if (generation !== this._shotGeneration || this._destroyed) return;
      if (sceneClock) {
        this.publish(
          sceneClock.scene,
          sceneClock.shot,
          sceneClock.sceneElapsedTo,
          { running: false },
        );
      }
      return;
    }
    const startedAt = this.now();
    const timer = this.schedule(() => {
      if (this._shotProgressTimer !== timer) return;
      if (
        generation !== this._shotGeneration ||
        this._destroyed ||
        token.cancelled ||
        token.signal?.aborted ||
        this.isRunning()
      ) {
        this.cancel(timer);
        if (this._shotProgressTimer === timer) this._shotProgressTimer = null;
        return;
      }
      const fraction = clamp01((this.now() - startedAt) / (seconds * 1000));
      this.onProgress(from + (to - from) * fraction);
      if (generation !== this._shotGeneration || this._destroyed) return;
      if (sceneClock) {
        this.publish(
          sceneClock.scene,
          sceneClock.shot,
          sceneClock.sceneElapsedFrom +
            (sceneClock.sceneElapsedTo - sceneClock.sceneElapsedFrom) *
              fraction,
          { running: false },
        );
      }
      if (fraction >= 1) {
        this.cancel(timer);
        if (this._shotProgressTimer === timer) this._shotProgressTimer = null;
      }
    }, 100);
    timer.unref?.();
    this._shotProgressTimer = timer;
  }

  startScene(scene, shot, token) {
    this.stopSceneTimer();
    const generation = this._sceneGeneration;
    const timing = this.timingForShot(scene, shot);
    if (
      generation !== this._sceneGeneration ||
      this._destroyed ||
      token.cancelled ||
      token.signal?.aborted
    )
      return timing;
    const startedAt = this.now();
    this.publish(scene, shot, timing.startElapsedSec, {
      running: true,
    });
    if (
      generation !== this._sceneGeneration ||
      this._destroyed ||
      token.cancelled ||
      token.signal?.aborted
    )
      return timing;
    const timer = this.schedule(() => {
      if (this._sceneClockTimer !== timer) return;
      if (
        this._destroyed ||
        token.cancelled ||
        token.signal?.aborted ||
        !this.isRunning()
      ) {
        this.cancel(timer);
        if (this._sceneClockTimer === timer) this._sceneClockTimer = null;
        return;
      }
      const shotElapsedSec = Math.min(
        timing.durationSec,
        (this.now() - startedAt) / 1000,
      );
      this.publish(scene, shot, timing.startElapsedSec + shotElapsedSec, {
        running: true,
      });
    }, 50);
    timer.unref?.();
    this._sceneClockTimer = timer;
    return timing;
  }
}
