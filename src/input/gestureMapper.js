/**
 * Hand Gesture Classifier & Action Mapper.
 *
 * Classifies 10 distinct tactical hand gestures from 21 MediaPipe hand landmarks
 * and maps them to God's Eye View actions with temporal smoothing and debounce.
 */

export const GESTURE_NAMES = Object.freeze({
  INDEX_POINT: 'INDEX_POINT',
  FIST: 'FIST',
  PINCH: 'PINCH',
  OPEN_PALM: 'OPEN_PALM',
  PEACE_SIGN: 'PEACE_SIGN',
  TWO_FINGERS_UP: 'TWO_FINGERS_UP',
  THUMBS_UP: 'THUMBS_UP',
  THUMBS_DOWN: 'THUMBS_DOWN',
  HANG_LOOSE: 'HANG_LOOSE',
  SWIPE_LEFT: 'SWIPE_LEFT',
  SWIPE_RIGHT: 'SWIPE_RIGHT',
  NONE: 'NONE',
});

function dist(p1, p2) {
  if (!p1 || !p2) return 0;
  const x1 = p1.x !== undefined ? p1.x : p1[0] !== undefined ? p1[0] : 0;
  const y1 = p1.y !== undefined ? p1.y : p1[1] !== undefined ? p1[1] : 0;
  const x2 = p2.x !== undefined ? p2.x : p2[0] !== undefined ? p2[0] : 0;
  const y2 = p2.y !== undefined ? p2.y : p2[1] !== undefined ? p2[1] : 0;
  return Math.hypot(x1 - x2, y1 - y2);
}

/**
 * Checks if fingers are extended relative to their MCP/PIP joints.
 * @param {Array<{x: number, y: number, z?: number}>} lm - 21 hand landmarks
 * @returns {{ thumb: boolean, index: boolean, middle: boolean, ring: boolean, pinky: boolean }}
 */
export function getFingerExtensions(lm) {
  if (!Array.isArray(lm) || lm.length < 21) {
    return {
      thumb: false,
      index: false,
      middle: false,
      ring: false,
      pinky: false,
    };
  }

  const wrist = lm[0];

  // For fingers (index..pinky), tip distance to wrist vs pip distance to wrist
  const isExtended = (tipIdx, pipIdx) => {
    return dist(lm[tipIdx], wrist) > dist(lm[pipIdx], wrist) * 1.15;
  };

  const index = isExtended(8, 6);
  const middle = isExtended(12, 10);
  const ring = isExtended(16, 14);
  const pinky = isExtended(20, 18);

  // Thumb extension: distance between thumb tip (4) and pinky MCP (17)
  const thumb = dist(lm[4], lm[17]) > dist(lm[2], lm[17]) * 1.25;

  return { thumb, index, middle, ring, pinky };
}

/**
 * Classifies the static gesture from a single frame of 21 hand landmarks.
 * @param {Array<{x: number, y: number, z?: number}>} lm
 * @returns {{ gesture: string, confidence: number, details: object }}
 */
export function classifyHandGesture(lm) {
  if (!Array.isArray(lm) || lm.length < 21) {
    return { gesture: GESTURE_NAMES.NONE, confidence: 0, details: {} };
  }

  const ext = getFingerExtensions(lm);
  const pinchDist = dist(lm[4], lm[8]);
  const indexMiddleDist = dist(lm[8], lm[12]);

  // 1. Closed Fist: all 4 primary fingers folded into palm
  if (!ext.index && !ext.middle && !ext.ring && !ext.pinky) {
    return { gesture: GESTURE_NAMES.FIST, confidence: 0.95, details: {} };
  }

  // 2. Pinch gesture (thumb tip & index tip touching or very close)
  if (pinchDist < 0.08) {
    const x4 =
      lm[4].x !== undefined ? lm[4].x : lm[4][0] !== undefined ? lm[4][0] : 0;
    const y4 =
      lm[4].y !== undefined ? lm[4].y : lm[4][1] !== undefined ? lm[4][1] : 0;
    const x8 =
      lm[8].x !== undefined ? lm[8].x : lm[8][0] !== undefined ? lm[8][0] : 0;
    const y8 =
      lm[8].y !== undefined ? lm[8].y : lm[8][1] !== undefined ? lm[8][1] : 0;
    return {
      gesture: GESTURE_NAMES.PINCH,
      confidence: Math.max(0, 1 - pinchDist / 0.08),
      details: {
        pinchDist,
        center: { x: (x4 + x8) / 2, y: (y4 + y8) / 2 },
      },
    };
  }

  // 3. Open Palm (all 4 main fingers extended)
  if (ext.index && ext.middle && ext.ring && ext.pinky) {
    return { gesture: GESTURE_NAMES.OPEN_PALM, confidence: 0.95, details: {} };
  }

  // 4. Hang Loose / Shaka (thumb & pinky extended, inner 3 folded)
  if (ext.thumb && ext.pinky && !ext.index && !ext.middle && !ext.ring) {
    return { gesture: GESTURE_NAMES.HANG_LOOSE, confidence: 0.9, details: {} };
  }

  // 5. Peace sign (V) or Two Fingers Up (index & middle extended, ring & pinky folded)
  if (ext.index && ext.middle && !ext.ring && !ext.pinky) {
    if (indexMiddleDist > 0.04) {
      return {
        gesture: GESTURE_NAMES.PEACE_SIGN,
        confidence: 0.9,
        details: { spread: indexMiddleDist },
      };
    }
    return {
      gesture: GESTURE_NAMES.TWO_FINGERS_UP,
      confidence: 0.85,
      details: {},
    };
  }

  // 6. Index Finger Point (only index extended)
  if (ext.index && !ext.middle && !ext.ring && !ext.pinky) {
    return {
      gesture: GESTURE_NAMES.INDEX_POINT,
      confidence: 0.9,
      details: { pointTip: lm[8] },
    };
  }

  // 7. Thumbs Up / Thumbs Down (only thumb extended)
  if (ext.thumb && !ext.index && !ext.middle && !ext.ring && !ext.pinky) {
    const isUp = lm[4].y < lm[3].y;
    return {
      gesture: isUp ? GESTURE_NAMES.THUMBS_UP : GESTURE_NAMES.THUMBS_DOWN,
      confidence: 0.9,
      details: {},
    };
  }

  return { gesture: GESTURE_NAMES.NONE, confidence: 0, details: {} };
}

/**
 * Maps gestures to GEV tactical actions with temporal majority voting and debouncing.
 */
export class GestureMapper {
  /**
   * @param {object} [options]
   * @param {number} [options.holdDurationMs=200] - continuous hold required to fire discrete action
   * @param {(action: string, data: object) => void} [options.onAction]
   */
  constructor({ holdDurationMs = 200, onAction = null } = {}) {
    this.holdDurationMs = holdDurationMs;
    this.onAction = onAction;
    this._currentGesture = GESTURE_NAMES.NONE;
    this._gestureStartTime = 0;
    this._firedForCurrent = false;
    this._recentGestures = [];
    this._history = []; // wrist x history for swipe detection
  }

  /**
   * Update gesture classifier with new frame landmarks.
   * @param {Array<{x: number, y: number}>} landmarks
   * @param {number} [now=Date.now()]
   * @returns {{ rawGesture: string, firedAction: string | null }}
   */
  processFrame(landmarks, now = Date.now()) {
    if (!landmarks || landmarks.length < 21) {
      this._resetState();
      return { rawGesture: GESTURE_NAMES.NONE, firedAction: null };
    }

    // Check swipe velocity
    const wrist = landmarks[0];
    this._history.push({ x: wrist.x, time: now });
    if (this._history.length > 8) this._history.shift();

    let swipeAction = null;
    if (this._history.length >= 4) {
      const oldest = this._history[0];
      const newest = this._history[this._history.length - 1];
      const dt = (newest.time - oldest.time) / 1000;
      if (dt > 0.05 && dt < 0.4) {
        const dx = newest.x - oldest.x;
        const vx = dx / dt;
        if (vx < -0.8) {
          swipeAction = 'next_contact';
          this._history = [];
        } else if (vx > 0.8) {
          swipeAction = 'prev_contact';
          this._history = [];
        }
      }
    }

    if (swipeAction) {
      this.onAction?.(swipeAction, { type: 'swipe' });
      return {
        rawGesture: GESTURE_NAMES.SWIPE_RIGHT,
        firedAction: swipeAction,
      };
    }

    const { gesture, details } = classifyHandGesture(landmarks);

    // Continuous gestures (pan via point, zoom via pinch)
    if (gesture === GESTURE_NAMES.INDEX_POINT) {
      this.onAction?.('pan', { pointTip: details.pointTip });
    } else if (gesture === GESTURE_NAMES.PINCH) {
      this.onAction?.('pinch_zoom', {
        pinchDist: details.pinchDist,
        center: details.center,
      });
    }

    // Temporal majority voting across recent frames to eliminate flicker
    this._recentGestures.push(gesture);
    if (this._recentGestures.length > 5) this._recentGestures.shift();

    const counts = {};
    for (const g of this._recentGestures) {
      counts[g] = (counts[g] || 0) + 1;
    }
    let smoothedGesture = gesture;
    let maxCount = 0;
    for (const [g, count] of Object.entries(counts)) {
      if (count > maxCount) {
        maxCount = count;
        smoothedGesture = g;
      }
    }

    // Discrete hold gestures
    if (smoothedGesture !== this._currentGesture) {
      this._currentGesture = smoothedGesture;
      this._gestureStartTime = now;
      this._firedForCurrent = false;
      return { rawGesture: smoothedGesture, firedAction: null };
    }

    const elapsed = now - this._gestureStartTime;
    if (elapsed >= this.holdDurationMs && !this._firedForCurrent) {
      this._firedForCurrent = true;
      const action = this._mapGestureToAction(smoothedGesture);
      if (action) {
        this.onAction?.(action, { gesture: smoothedGesture, details });
        return { rawGesture: smoothedGesture, firedAction: action };
      }
    }

    return { rawGesture: smoothedGesture, firedAction: null };
  }

  _resetState() {
    this._currentGesture = GESTURE_NAMES.NONE;
    this._gestureStartTime = 0;
    this._firedForCurrent = false;
    this._recentGestures = [];
  }

  _mapGestureToAction(gesture) {
    switch (gesture) {
      case GESTURE_NAMES.FIST:
        return 'toggle_lock';
      case GESTURE_NAMES.OPEN_PALM:
        return 'reset_globe';
      case GESTURE_NAMES.PEACE_SIGN:
        return 'toggle_cockpit';
      case GESTURE_NAMES.TWO_FINGERS_UP:
        return 'ai_sitrep';
      case GESTURE_NAMES.HANG_LOOSE:
        return 'toggle_voice';
      case GESTURE_NAMES.THUMBS_UP:
        return 'confirm';
      case GESTURE_NAMES.THUMBS_DOWN:
        return 'dismiss';
      default:
        return null;
    }
  }
}
