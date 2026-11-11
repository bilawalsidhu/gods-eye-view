import * as geo from './geo/index.js';
import { renderGovernorFor } from './renderGovernor.js';

/**
 * OrbitController — smooth orbit around a target point.
 * Uses the engine's preRender frames for frame-rate-independent updates.
 * Toggle with O key; auto-stops on POI/city change.
 */
export class OrbitController {
  /**
   * @param {import('./globe/contract.js').GlobeEngine | null} engine
   */
  constructor(engine) {
    this.engine = engine ?? null;
    this.active = false;
    this.target = null;
    this.radius = 500;
    this.pitch = -30;
    this.speed = geo.math.toRadians(6); // ~6°/sec → full rotation in ~60s
    this.angle = 0;
    this._removeListener = null;
  }

  /**
   * Start orbiting around a target position.
   * @param {{x: number, y: number, z: number}} targetCartesian - The point to orbit around
   * @param {object} options
   * @param {number} options.radius - Distance from target in meters
   * @param {number} options.pitch - Tilt angle in degrees (negative = looking down)
   * @param {number} options.speed - Degrees per second (default 6)
   */
  start(targetCartesian, options = {}) {
    if (!targetCartesian || !this.engine) return;
    const { camera, frames } = this.engine;

    this.target = targetCartesian;
    this.radius = options.radius || this.radius;
    this.pitch = options.pitch || this.pitch;
    this.speed = geo.math.toRadians(options.speed || 6);
    this.active = true;
    // Orbit mutates the camera from preRender — without a hold the loop
    // starves after its first idle frame. (perf wave 2)
    this._renderGovernor = renderGovernorFor(this.engine);
    this._renderGovernor?.holdContinuousRender('camera-orbit');

    // Start from the camera's current heading for seamless transition
    this.angle = camera.pose().heading;

    let lastTime = Date.now();
    this._removeListener = frames.preRender.addEventListener(() => {
      if (!this.active) return;

      const now = Date.now();
      const dt = (now - lastTime) / 1000;
      lastTime = now;

      this.angle += this.speed * dt;

      camera.lookAt(this.target, {
        heading: this.angle,
        pitch: geo.math.toRadians(this.pitch),
        range: this.radius,
      });
    });
  }

  /**
   * Stop orbiting. Camera freezes at current position and user regains control.
   */
  stop() {
    this.active = false;
    this._renderGovernor?.releaseContinuousRender('camera-orbit');
    if (this._removeListener) {
      this._removeListener();
      this._removeListener = null;
    }
    // Unlock camera for free interaction
    this.engine?.camera.release();
  }

  /**
   * Orbit on another globe engine's camera (an engine switch), or none
   * (null). A running orbit stops: its frames belonged to the outgoing one.
   */
  attachEngine(engine) {
    if (this.active || this._removeListener) {
      this.active = false;
      this._renderGovernor?.releaseContinuousRender('camera-orbit');
      this._removeListener?.();
      this._removeListener = null;
    }
    this.engine = engine ?? null;
  }

  /**
   * Toggle orbit on/off.
   * @param {{x: number, y: number, z: number}} targetCartesian - Required when starting
   * @param {object} options - Passed to start()
   * @returns {boolean} Whether orbit is now active
   */
  toggle(targetCartesian, options) {
    if (this.active) {
      this.stop();
    } else {
      this.start(targetCartesian, options);
    }
    return this.active;
  }
}
