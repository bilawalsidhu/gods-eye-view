/**
 * Volumetric 2D/3D Weather Particle & Lightning Simulation.
 *
 * Renders high-speed rain streaks, drifting snow crystals, and lightning
 * flashes overlaid onto the Cesium viewport, responsive to local weather and
 * cockpit aircraft velocity vectors.
 */

const MAX_RAIN_PARTICLES = 400;
const MAX_SNOW_PARTICLES = 250;

export class WeatherParticles {
  /**
   * @param {object} [options]
   * @param {HTMLElement} [options.container]
   */
  constructor({ container = null } = {}) {
    this.container =
      container || (typeof document !== 'undefined' ? document.body : null);
    this.canvas = null;
    this.ctx = null;
    this.isActive = false;

    this.profile = {
      rain: 0,
      snow: 0,
      fog: 0,
      storm: 0,
      lightning: 0,
      wind: 0,
      windDirectionDeg: 0,
    };

    this._cockpitVelocity = { speedKts: 0, headingDeg: 0 };
    this._particles = [];
    this._animId = null;
    this._lightningAlpha = 0;
    this._lastTime = 0;

    this._initDom();
  }

  _initDom() {
    if (typeof document === 'undefined' || !this.container) return;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'gev-weather-particles-canvas';
    this.canvas.style.position = 'absolute';
    this.canvas.style.inset = '0';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.pointerEvents = 'none';
    this.canvas.style.zIndex = '5';

    this.ctx = this.canvas.getContext('2d');
    this._resize();
    window.addEventListener('resize', () => this._resize());
    this.container.appendChild(this.canvas);
  }

  _resize() {
    if (!this.canvas) return;
    this.canvas.width = window.innerWidth || 1920;
    this.canvas.height = window.innerHeight || 1080;
  }

  /**
   * Update active weather condition profile.
   * @param {object} profile
   */
  updateWeather(profile = {}) {
    this.profile = { ...this.profile, ...profile };
    const hasPrecip =
      this.profile.rain > 0.05 ||
      this.profile.snow > 0.05 ||
      this.profile.storm > 0.1;

    if (hasPrecip && !this.isActive) {
      this.start();
    } else if (!hasPrecip && this.isActive) {
      this.stop();
    }
  }

  /**
   * Modulate particle velocity when in cockpit flight mode.
   * @param {number} speedKts
   * @param {number} headingDeg
   */
  setCockpitVelocity(speedKts = 0, headingDeg = 0) {
    this._cockpitVelocity = {
      speedKts: Math.max(0, Number(speedKts) || 0),
      headingDeg: Number(headingDeg) || 0,
    };
  }

  start() {
    if (this.isActive) return;
    this.isActive = true;
    this._initParticles();
    this._lastTime = performance.now();
    this._loop();
  }

  stop() {
    this.isActive = false;
    if (this._animId) {
      cancelAnimationFrame(this._animId);
      this._animId = null;
    }
    if (this.ctx && this.canvas) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  _initParticles() {
    const w = this.canvas?.width || 1920;
    const h = this.canvas?.height || 1080;
    const isSnow = this.profile.snow > this.profile.rain;
    const count = isSnow
      ? Math.round(MAX_SNOW_PARTICLES * this.profile.snow)
      : Math.round(MAX_RAIN_PARTICLES * this.profile.rain);

    this._particles = [];
    for (let i = 0; i < count; i++) {
      this._particles.push({
        x: Math.random() * w,
        y: Math.random() * h,
        z: Math.random() * 0.8 + 0.2, // depth factor
        length: Math.random() * 18 + 12,
        speed: Math.random() * 400 + 600,
        sway: Math.random() * Math.PI * 2,
      });
    }
  }

  _loop() {
    if (!this.isActive) return;

    const now = performance.now();
    const dt = Math.min(0.05, (now - this._lastTime) / 1000);
    this._lastTime = now;

    this._updateAndDraw(dt);
    this._animId = requestAnimationFrame(() => this._loop());
  }

  _updateAndDraw(dt) {
    if (!this.ctx || !this.canvas) return;
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    ctx.clearRect(0, 0, w, h);

    // Random lightning flash during storms
    if (this.profile.lightning > 0.3) {
      if (
        Math.random() < 0.008 * this.profile.lightning &&
        this._lightningAlpha <= 0
      ) {
        this._lightningAlpha = 0.85;
      }
    }

    if (this._lightningAlpha > 0) {
      ctx.fillStyle = `rgba(230, 245, 255, ${this._lightningAlpha})`;
      ctx.fillRect(0, 0, w, h);
      this._lightningAlpha = Math.max(0, this._lightningAlpha - dt * 3.5);
    }

    const isSnow = this.profile.snow > this.profile.rain;
    const windRad = (this.profile.windDirectionDeg * Math.PI) / 180;
    const windX = Math.sin(windRad) * this.profile.wind * 150;
    const cockpitBoost = (this._cockpitVelocity.speedKts / 300) * 400;

    if (isSnow) {
      ctx.fillStyle = 'rgba(240, 250, 255, 0.85)';
      for (const p of this._particles) {
        p.sway += dt * 2.5;
        p.y += (120 + cockpitBoost * 0.3) * p.z * dt;
        p.x += (windX + Math.sin(p.sway) * 40) * dt;

        if (p.y > h) {
          p.y = -10;
          p.x = Math.random() * w;
        }
        if (p.x > w) p.x = 0;
        if (p.x < 0) p.x = w;

        ctx.beginPath();
        ctx.arc(p.x, p.y, 2 * p.z, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // Rain streaks
      ctx.strokeStyle = 'rgba(180, 225, 255, 0.55)';
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';

      for (const p of this._particles) {
        const fallSpeed = (p.speed + cockpitBoost) * p.z;
        p.y += fallSpeed * dt;
        p.x += windX * dt;

        if (p.y > h) {
          p.y = -20;
          p.x = Math.random() * w;
        }
        if (p.x > w) p.x = 0;
        if (p.x < 0) p.x = w;

        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(
          p.x + windX * 0.05,
          p.y + p.length * p.z * (1 + cockpitBoost * 0.002),
        );
        ctx.stroke();
      }
    }
  }

  destroy() {
    this.stop();
    this.canvas?.remove();
    this.canvas = null;
    this.ctx = null;
  }
}
