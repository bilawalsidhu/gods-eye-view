/**
 * Webcam Hand Tracker using MediaPipe Hands (Browser WASM/WebGL).
 *
 * Runs video capture and landmark inference capped at 15 fps to stay well
 * under the 8% CPU / GPU budget with exponential moving average coordinate smoothing.
 */

const MEDIAPIPE_HANDS_CDN =
  'https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js';

export class HandTracker {
  /**
   * @param {object} [options]
   * @param {number} [options.fps=15] - Target detection frame rate
   * @param {number} [options.smoothing=0.6] - EMA smoothing factor (0: stiff, 1: raw)
   * @param {(result: { landmarks: Array<{x: number, y: number, z: number}>, handedness: string }) => void} [options.onResults]
   * @param {(error: Error) => void} [options.onError]
   */
  constructor({
    fps = 15,
    smoothing = 0.6,
    videoEl = null,
    onResults = null,
    onError = null,
  } = {}) {
    this.fps = fps;
    this.smoothing = smoothing;
    this.videoEl = videoEl;
    this._externalVideo = Boolean(videoEl);
    this.onResults = onResults;
    this.onError = onError;

    this.stream = null;
    this.hands = null;
    this.isRunning = false;
    this._isProcessing = false;

    this._smoothedLandmarks = null;
    this._lastFrameTime = 0;
    this._frameIntervalMs = 1000 / fps;
    this._animFrameId = null;
  }

  /**
   * Lazy load MediaPipe Hands script from CDN if not already loaded.
   */
  async _loadScript() {
    if (typeof window === 'undefined') return false;
    if (window.Hands) return true;

    return new Promise((resolve, reject) => {
      const existing = document.querySelector(
        `script[src="${MEDIAPIPE_HANDS_CDN}"]`,
      );
      if (existing) {
        if (window.Hands) {
          resolve(true);
          return;
        }
        const checkInterval = setInterval(() => {
          if (window.Hands) {
            clearInterval(checkInterval);
            resolve(true);
          }
        }, 50);
        existing.addEventListener(
          'load',
          () => {
            clearInterval(checkInterval);
            resolve(true);
          },
          { once: true },
        );
        existing.addEventListener(
          'error',
          () => {
            clearInterval(checkInterval);
            reject(new Error('Failed to load MediaPipe Hands'));
          },
          { once: true },
        );
        setTimeout(() => {
          clearInterval(checkInterval);
          if (window.Hands) resolve(true);
          else reject(new Error('MediaPipe script load timeout'));
        }, 6000);
        return;
      }

      const script = document.createElement('script');
      script.src = MEDIAPIPE_HANDS_CDN;
      script.crossOrigin = 'anonymous';
      script.onload = () => resolve(true);
      script.onerror = () => reject(new Error('MediaPipe script load error'));
      document.head.appendChild(script);
    });
  }

  /**
   * Start webcam capture and gesture tracking loop.
   */
  async start() {
    if (this.isRunning) return;
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      this.onError?.(
        new Error('Camera API not available in this browser environment'),
      );
      return;
    }

    try {
      // 1. Try initializing @vladmandic/human AI engine first
      try {
        const { Human } = await import('@vladmandic/human');
        const localPath =
          typeof window !== 'undefined'
            ? '/node_modules/@vladmandic/human/models/'
            : 'https://cdn.jsdelivr.net/npm/@vladmandic/human/models/';
        this.human = new Human({
          backend: 'webgl',
          modelBasePath: localPath,
          face: { enabled: false },
          body: { enabled: false },
          hand: {
            enabled: true,
            maxDetected: 1,
            minConfidence: 0.35,
            landmarks: true,
            detector: { modelPath: 'handtrack.json' },
          },
          object: { enabled: false },
          gesture: { enabled: true },
        });
        if (typeof this.human.load === 'function') {
          await this.human.load();
        }
      } catch (humanErr) {
        console.debug?.('[HandTracker] Falling back to MediaPipe:', humanErr);
        await this._loadScript();

        // Initialize MediaPipe Hands as fallback
        if (window.Hands && !this.hands) {
          this.hands = new window.Hands({
            locateFile: (file) =>
              `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
          });

          this.hands.setOptions({
            maxNumHands: 1,
            modelComplexity: 0,
            minDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5,
          });

          this.hands.onResults((results) => this._handleResults(results));
        }
      }

      // Initialize video element if not externally provided
      if (!this.videoEl) {
        this.videoEl = document.createElement('video');
        this.videoEl.setAttribute('playsinline', '');
        this.videoEl.setAttribute('autoplay', '');
        this.videoEl.muted = true;
        this.videoEl.style.cssText =
          'position:fixed;top:-9999px;left:-9999px;width:320px;height:240px;opacity:0;pointer-events:none;z-index:-1;';
        document.body.appendChild(this.videoEl);
      }

      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 320 },
          height: { ideal: 240 },
          frameRate: { ideal: this.fps, max: 20 },
        },
      });

      this.videoEl.muted = true;
      this.videoEl.srcObject = this.stream;
      await this.videoEl.play();

      if (this.videoEl.readyState < 2) {
        await new Promise((resolve) => {
          this.videoEl.addEventListener('loadeddata', () => resolve(), {
            once: true,
          });
          setTimeout(resolve, 1000);
        });
      }

      this.isRunning = true;
      this._isProcessing = false;
      this._lastFrameTime = performance.now();
      this._scheduleFrame();
    } catch (err) {
      this.stop();
      this.onError?.(err);
    }
  }

  _scheduleFrame() {
    if (!this.isRunning) return;

    const loop = async () => {
      if (!this.isRunning) return;

      const now = performance.now();
      const elapsed = now - this._lastFrameTime;

      if (
        elapsed >= this._frameIntervalMs &&
        !this._isProcessing &&
        this.videoEl &&
        this.videoEl.readyState >= 2 &&
        !this.videoEl.paused
      ) {
        this._lastFrameTime = now;
        this._isProcessing = true;
        try {
          if (this.human && this.isRunning) {
            const res = await this.human.detect(this.videoEl);
            if (res.hand && res.hand.length > 0) {
              const rawLm = res.hand[0].landmarks;
              const multiHandLandmarks = [
                rawLm.map(([x, y, z]) => ({ x, y, z: z || 0 })),
              ];
              this._handleResults({
                multiHandLandmarks,
                multiHandedness: [{ label: 'Right' }],
              });
            } else {
              this._handleResults({ multiHandLandmarks: [] });
            }
          } else if (this.hands && this.isRunning) {
            await this.hands.send({ image: this.videoEl });
          }
        } catch (frameErr) {
          console.debug?.('[HandTracker] Frame drop:', frameErr);
        } finally {
          this._isProcessing = false;
        }
      }

      if (this.isRunning) {
        this._animFrameId = requestAnimationFrame(loop);
      }
    };

    this._animFrameId = requestAnimationFrame(loop);
  }

  _handleResults(results) {
    if (!results.multiHandLandmarks || !results.multiHandLandmarks.length) {
      this._smoothedLandmarks = null;
      this.onResults?.({ landmarks: null, handedness: null });
      return;
    }

    const raw = results.multiHandLandmarks[0];
    const handedness = results.multiHandedness?.[0]?.label || 'Right';

    // Exponential Moving Average (EMA) smoothing
    if (!this._smoothedLandmarks) {
      this._smoothedLandmarks = raw.map((p) => ({
        x: p.x,
        y: p.y,
        z: p.z || 0,
      }));
    } else {
      const alpha = this.smoothing;
      for (let i = 0; i < raw.length; i++) {
        this._smoothedLandmarks[i].x =
          alpha * raw[i].x + (1 - alpha) * this._smoothedLandmarks[i].x;
        this._smoothedLandmarks[i].y =
          alpha * raw[i].y + (1 - alpha) * this._smoothedLandmarks[i].y;
        this._smoothedLandmarks[i].z =
          alpha * (raw[i].z || 0) + (1 - alpha) * this._smoothedLandmarks[i].z;
      }
    }

    this.onResults?.({
      landmarks: this._smoothedLandmarks,
      handedness,
      rawResults: results,
    });
  }

  /**
   * Stop webcam tracking and release media stream.
   */
  stop() {
    this.isRunning = false;
    this._isProcessing = false;
    if (this._animFrameId) {
      cancelAnimationFrame(this._animFrameId);
      this._animFrameId = null;
    }

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }

    if (this.videoEl) {
      this.videoEl.pause();
      this.videoEl.srcObject = null;
      if (!this._externalVideo) {
        this.videoEl.remove();
        this.videoEl = null;
      }
    }

    this._smoothedLandmarks = null;
    this.human = null;
  }
}
