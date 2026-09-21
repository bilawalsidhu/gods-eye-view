/**
 * AI-powered Webcam Hand and Face Gesture Controller.
 * Powered by @vladmandic/human for touchless 3D globe manipulation,
 * targeting, and holographic HUD feedback.
 */

/**
 * Classifies the active hand gesture from landmarks and detected gestures.
 * @param {Array<[number, number, number]>} landmarks - 21 hand 3D points
 * @param {Array<{ gesture: string }>} [gestures] - Built-in recognized gestures
 * @returns {{ name: string, label: string, icon: string, confidence: number }}
 */
export function classifyHandPose(landmarks, gestures = []) {
  if (!landmarks || landmarks.length < 21) {
    return { name: 'none', label: 'NO HAND', icon: '❓', confidence: 0 };
  }

  // Robust coordinate access supporting both [x, y, z] and {x, y, z}
  const getX = (p) =>
    p ? (p.x !== undefined ? p.x : p[0] !== undefined ? p[0] : 0) : 0;
  const getY = (p) =>
    p ? (p.y !== undefined ? p.y : p[1] !== undefined ? p[1] : 0) : 0;
  const pointDist = (p1, p2) =>
    Math.hypot(getX(p1) - getX(p2), getY(p1) - getY(p2));

  // Built-in gesture check from human
  const gestureNames = gestures.map((g) =>
    typeof g === 'string' ? g : g.gesture || '',
  );
  if (gestureNames.some((g) => g.includes('thumbs up'))) {
    return { name: 'thumbs_up', label: 'CONFIRM', icon: '👍', confidence: 0.9 };
  }

  const thumbTip = landmarks[4];
  const indexTip = landmarks[8];
  const middleTip = landmarks[12];
  const ringTip = landmarks[16];
  const pinkyTip = landmarks[20];
  const wrist = landmarks[0];

  // Pinch check: Distance between thumb tip (4) and index tip (8)
  const pinchDist = pointDist(thumbTip, indexTip);
  if (pinchDist < 0.08) {
    return {
      name: 'pinch',
      label: 'PINCH ZOOM',
      icon: '🤏',
      confidence: 0.88,
      distance: pinchDist,
    };
  }

  // Check finger extension relative to wrist
  const indexExtended = pointDist(indexTip, wrist) > 0.28;
  const middleCurled = pointDist(middleTip, wrist) < 0.22;
  const ringCurled = pointDist(ringTip, wrist) < 0.22;
  const pinkyCurled = pointDist(pinkyTip, wrist) < 0.22;

  // Pointing check: Only index extended, others curled
  if (indexExtended && middleCurled && ringCurled && pinkyCurled) {
    return {
      name: 'point',
      label: 'TARGET LOCK',
      icon: '👉',
      confidence: 0.85,
    };
  }

  // Fist check: All fingertips close to wrist
  const allCurled = !indexExtended && middleCurled && ringCurled && pinkyCurled;
  if (allCurled || gestureNames.some((g) => g.includes('fist'))) {
    return {
      name: 'fist',
      label: 'GRAB & ROTATE',
      icon: '✊',
      confidence: 0.9,
    };
  }

  // Peace / V sign: Index and middle extended, ring and pinky curled
  const middleExtended = pointDist(middleTip, wrist) > 0.28;
  if (indexExtended && middleExtended && ringCurled && pinkyCurled) {
    return {
      name: 'peace',
      label: 'COCKPIT VIEW',
      icon: '✌️',
      confidence: 0.9,
    };
  }

  // Open palm
  return {
    name: 'open_palm',
    label: 'HOVER / SCAN',
    icon: '🖐️',
    confidence: 0.75,
  };
}

/**
 * Maps normalized camera coordinates (mirrored horizontally) to screen space.
 * @param {[number, number]|{x: number, y: number}} point - Point in [0, 1]
 * @param {number} width - Screen width
 * @param {number} height - Screen height
 * @returns {{ x: number, y: number }}
 */
export function mapHandToScreenCoords(point, width, height) {
  if (!point) return { x: 0, y: 0 };
  const rawX =
    point.x !== undefined ? point.x : point[0] !== undefined ? point[0] : 0;
  const rawY =
    point.y !== undefined ? point.y : point[1] !== undefined ? point[1] : 0;
  // Mirror x coordinate so hand moves naturally with user
  const mirroredX = 1 - Math.max(0, Math.min(1, rawX));
  const clampedY = Math.max(0, Math.min(1, rawY));
  return {
    x: Math.round(mirroredX * width),
    y: Math.round(clampedY * height),
  };
}

/**
 * Calculates subtle parallax pitch and yaw offsets from face rotation.
 * @param {{ pitch?: number, yaw?: number, roll?: number }} rotation
 * @returns {{ pitchOffset: number, yawOffset: number }}
 */
export function calculateHeadParallaxOffset(rotation) {
  if (!rotation) return { pitchOffset: 0, yawOffset: 0 };
  const maxTiltRad = 0.08; // ~4.5 degrees max
  const yaw = rotation.yaw || 0;
  const pitch = rotation.pitch || 0;
  return {
    pitchOffset: Math.max(-maxTiltRad, Math.min(maxTiltRad, pitch * 0.05)),
    yawOffset: Math.max(-maxTiltRad, Math.min(maxTiltRad, yaw * 0.05)),
  };
}

export class VisionGestureController {
  constructor({ viewer = null, onGesture = null } = {}) {
    this.viewer = viewer;
    this.onGesture = onGesture;
    this.active = false;
    this.human = null;
    this.stream = null;
    this.videoEl = null;
    this.canvasEl = null;
    this.ctx = null;
    this.animId = null;

    this.lastHandPos = null;
    this.lastPinchDist = null;
    this.currentGesture = { name: 'none', label: 'STANDBY', icon: '👁️' };
    this.fps = 0;
    this._lastFrameTime = 0;
    this._lastProcessTime = 0;

    this._boundLoop = this._processFrame.bind(this);
  }

  async initHuman() {
    if (this.human) return this.human;
    // Dynamic import to keep startup footprint light
    const { Human } = await import('@vladmandic/human');

    const cdns = [
      '/node_modules/@vladmandic/human/models/',
      'https://cdn.jsdelivr.net/npm/@vladmandic/human/models/',
      'https://unpkg.com/@vladmandic/human/models/',
    ];

    let lastError = null;
    for (const cdn of cdns) {
      try {
        const humanInstance = new Human({
          backend: 'webgl',
          modelBasePath: cdn,
          face: {
            enabled: true,
            detector: { rotation: true },
            mesh: { enabled: true },
            iris: { enabled: false },
            description: { enabled: false },
            emotion: { enabled: true },
          },
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
          filter: { equalization: true },
        });

        // 10 second timeout for model download
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`Timeout loading from ${cdn}`)),
            10000,
          ),
        );

        if (typeof humanInstance.load === 'function') {
          await Promise.race([humanInstance.load(), timeoutPromise]);
        }

        this.human = humanInstance;
        return this.human;
      } catch (err) {
        console.warn(
          `[VisionGestures] Model load failed on ${cdn}:`,
          err.message,
        );
        lastError = err;
      }
    }

    throw lastError || new Error('Failed to load human models from CDN');
  }

  async start({ videoEl, canvasEl, pipContainer = null } = {}) {
    if (this.active) return;
    this.videoEl = videoEl;
    this.canvasEl = canvasEl;
    this.pipContainer = pipContainer;
    if (this.canvasEl) {
      this.ctx = this.canvasEl.getContext('2d');
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: 'user',
        },
        audio: false,
      });

      if (this.videoEl) {
        this.videoEl.srcObject = this.stream;
        await this.videoEl.play();
      }

      await this.initHuman();
      this.active = true;
      this._lastFrameTime = performance.now();
      this.animId = requestAnimationFrame(this._boundLoop);

      if (this.pipContainer) {
        this.pipContainer.classList.remove('hidden');
        this.pipContainer.dataset.state = 'tracking';
      }
    } catch (err) {
      console.warn('[VisionGesture] Camera or AI initialization failed:', err);
      this.stop();
      throw err;
    }
  }

  stop() {
    this.active = false;
    if (this.animId) {
      cancelAnimationFrame(this.animId);
      this.animId = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.videoEl) {
      this.videoEl.srcObject = null;
    }
    if (this.ctx && this.canvasEl) {
      this.ctx.clearRect(0, 0, this.canvasEl.width, this.canvasEl.height);
    }
    if (this.pipContainer) {
      this.pipContainer.classList.add('hidden');
      this.pipContainer.dataset.state = 'off';
    }
    this.currentGesture = { name: 'none', label: 'OFF', icon: '👁️' };
  }

  async _processFrame(now) {
    if (!this.active || !this.videoEl || !this.human) return;

    // Limit to ~20 FPS (50ms interval) to avoid hogging GPU
    if (now - this._lastProcessTime < 48) {
      if (this.active) {
        this.animId = requestAnimationFrame(this._boundLoop);
      }
      return;
    }
    this._lastProcessTime = now;

    // Calculate FPS
    const delta = now - this._lastFrameTime;
    this._lastFrameTime = now;
    if (delta > 0) this.fps = Math.round(1000 / delta);

    try {
      const res = await this.human.detect(this.videoEl);

      if (this.ctx && this.canvasEl) {
        this._drawCyberOverlay(res);
      }

      // Process Hand
      if (res.hand && res.hand.length > 0) {
        const hand = res.hand[0];
        const pose = classifyHandPose(hand.landmarks, res.gesture || []);
        this.currentGesture = pose;
        this._handleHandActions(hand, pose);
      } else {
        this.lastHandPos = null;
        this.lastPinchDist = null;
        if (!res.face || res.face.length === 0) {
          this.currentGesture = {
            name: 'none',
            label: 'SCANNING...',
            icon: '🔍',
          };
        }
      }

      // Process Face Parallax
      if (res.face && res.face.length > 0) {
        const face = res.face[0];
        if (face.rotation) {
          this._handleFaceParallax(face.rotation);
        }
      }

      this._updateHUDTelemetry();
    } catch (err) {
      // Ignore individual frame detection drops
    }

    if (this.active) {
      this.animId = requestAnimationFrame(this._boundLoop);
    }
  }

  _handleHandActions(hand, pose) {
    const palm = hand.landmarks[0]; // Wrist/base of palm
    const screenPos = mapHandToScreenCoords(
      palm,
      typeof window !== 'undefined' ? window.innerWidth : 1920,
      typeof window !== 'undefined' ? window.innerHeight : 1080,
    );

    this.onGesture?.(pose);

    // 1. Fist / Grab: Orbit & Pan globe
    if (pose.name === 'fist') {
      if (this.lastHandPos && this.viewer?.camera) {
        const dx = screenPos.x - this.lastHandPos.x;
        const dy = screenPos.y - this.lastHandPos.y;
        const rotFactor = 0.0035;
        this.viewer.camera.rotateRight?.(-dx * rotFactor);
        this.viewer.camera.rotateUp?.(-dy * rotFactor);
      }
      this.lastHandPos = screenPos;
    } else {
      this.lastHandPos = null;
    }

    // 2. Pinch: Altitude zoom
    if (pose.name === 'pinch' && pose.distance !== undefined) {
      if (this.lastPinchDist !== null && this.viewer?.camera) {
        const dDist = pose.distance - this.lastPinchDist;
        if (Math.abs(dDist) > 0.002) {
          const height =
            this.viewer.camera.positionCartographic?.height || 5000000;
          const zoomAmount = dDist * height * 1.5;
          if (zoomAmount > 0) {
            this.viewer.camera.zoomOut?.(zoomAmount);
          } else {
            this.viewer.camera.zoomIn?.(-zoomAmount);
          }
        }
      }
      this.lastPinchDist = pose.distance;
    } else {
      this.lastPinchDist = null;
    }

    // 3. Point: Raycast & Reticle
    if (
      pose.name === 'point' &&
      this.viewer?.camera &&
      typeof Cesium !== 'undefined'
    ) {
      const indexTip = hand.landmarks[8];
      const tipCoords = mapHandToScreenCoords(
        indexTip,
        window.innerWidth,
        window.innerHeight,
      );
      const ray = this.viewer.camera.getPickRay?.(
        new Cesium.Cartesian2(tipCoords.x, tipCoords.y),
      );
      if (ray) {
        this.targetRay = ray;
      }
    }

    // 4. Thumbs Up: Confirm / Voice event dispatch
    if (pose.name === 'thumbs_up') {
      if (!this._lastThumbsUp || Date.now() - this._lastThumbsUp > 2000) {
        this._lastThumbsUp = Date.now();
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('gev:voice-event', {
              detail: {
                type: 'gesture',
                gesture: 'thumbs_up',
                message: 'Gesture: Command confirmed via neural hand signal 👍',
              },
            }),
          );
        }
      }
    }
  }

  _handleFaceParallax(rotation) {
    if (!this.viewer?.camera) return;
    const { pitchOffset, yawOffset } = calculateHeadParallaxOffset(rotation);
    if (Math.abs(pitchOffset) > 0.005 || Math.abs(yawOffset) > 0.005) {
      // Subtle micro-rotation for 3D depth perception
      this.viewer.camera.lookRight?.(yawOffset * 0.08);
      this.viewer.camera.lookUp?.(pitchOffset * 0.08);
    }
  }

  _drawCyberOverlay(res) {
    const ctx = this.ctx;
    const w = this.canvasEl.width;
    const h = this.canvasEl.height;
    ctx.clearRect(0, 0, w, h);

    // Draw hand skeleton
    if (res.hand && res.hand.length > 0) {
      const hand = res.hand[0];
      const pts = hand.landmarks.map((pt) => ({
        x: (1 - pt[0]) * w, // Mirror
        y: pt[1] * h,
      }));

      ctx.save();
      ctx.strokeStyle = '#00f0ff';
      ctx.fillStyle = '#00f0ff';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#00f0ff';
      ctx.shadowBlur = 8;

      // Draw connections
      const fingers = [
        [0, 1, 2, 3, 4], // Thumb
        [0, 5, 6, 7, 8], // Index
        [0, 9, 10, 11, 12], // Middle
        [0, 13, 14, 15, 16], // Ring
        [0, 17, 18, 19, 20], // Pinky
      ];

      for (const chain of fingers) {
        ctx.beginPath();
        ctx.moveTo(pts[chain[0]].x, pts[chain[0]].y);
        for (let i = 1; i < chain.length; i++) {
          ctx.lineTo(pts[chain[i]].x, pts[chain[i]].y);
        }
        ctx.stroke();
      }

      // Draw joint dots
      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    }
  }

  _updateHUDTelemetry() {
    if (!this.pipContainer) return;
    const badge = this.pipContainer.querySelector('.pip-gesture-badge');
    if (badge) {
      badge.textContent = `${this.currentGesture.icon} ${this.currentGesture.label}`;
    }
    const fpsLabel = this.pipContainer.querySelector('.pip-fps-value');
    if (fpsLabel) {
      fpsLabel.textContent = `${this.fps} FPS`;
    }
  }
}
