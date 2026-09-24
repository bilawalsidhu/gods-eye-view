/**
 * Scanner design inspired by kk376's tactical naval sonar visual style:
 * https://github.com/bilawalsidhu/gods-eye-view/pull/214
 *
 * This is a separate HUD/contact treatment, not a port of that PR's shader.
 */
export const CYBER_SONAR_PERIOD_MS = 5_200;
// Parked-scene wake-ups and shared overlays use the fleet cadence. Native
// contacts still compose after layer updates on each actual draw so owner
// color writes cannot flash through during camera/fleet animation.
export const CYBER_SONAR_RENDER_INTERVAL_MS = 80;
export const CYBER_SONAR_SWEEP_DEG = 24;
export const CYBER_SONAR_FEATHER_DEG = 10;
// The sector should still read as a clear acquisition pass, but contacts
// outside it must remain immediately legible against FLIR terrain. Icons and
// dots keep a strong operator-tunable opacity floor; labels retain an even
// brighter floor so typography never disappears between passes.
export const CYBER_SONAR_DIM_FACTOR = 0.84;
export const CYBER_SONAR_LABEL_DIM_FACTOR = 0.92;
export const CYBER_SONAR_DEFAULTS = Object.freeze({
  rings: 8,
  range: 100,
  intensity: 70,
  opacity: 84,
  sector: 24,
});

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const primitiveColors = new WeakMap();
const sweepAnimations = new WeakMap();

/** Pin the compositor animation to the absolute clock used by contact sampling.
 * A negative delay alone is relative to the animation's eventual start, which
 * may be much later than theme initialization (or restart after HUD hiding).
 * Cache the running animation: no per-frame style writes or animation queries.
 */
export function syncCyberSonarAnimation(
  root = globalThis.document?.documentElement,
) {
  if (!root) return;
  const cached = sweepAnimations.get(root);
  if (cached?.element.isConnected && cached.animation.playState !== 'idle')
    return;
  const element = root.querySelector?.('.hud-sonar');
  const animation = element
    ?.getAnimations?.({ subtree: true })
    .find((item) => item.animationName === 'cyber-sonar-sweep');
  if (!animation) return;
  // The document animation timeline and performance.now share the navigation
  // time origin. Zero both offsets so delayed starts cannot shift the sector.
  animation.effect.updateTiming({ delay: 0 });
  animation.startTime = 0;
  sweepAnimations.set(root, { element, animation });
}

const copyColor = (color) => {
  if (!color || !Number.isFinite(color.alpha)) return null;
  if (typeof color.clone === 'function') return color.clone();
  return { ...color };
};

/** Read owner opacity before a hue-only restyle, never our composited opacity.
 * An independently written color still wins, including real freshness changes.
 */
export function cyberSonarBaseAlpha(visual, property = 'color') {
  const current = visual?.[property];
  const state = primitiveColors.get(visual)?.[property];
  const applied = state?.lastAppliedColor;
  return applied &&
    current &&
    current.red === applied.red &&
    current.green === applied.green &&
    current.blue === applied.blue &&
    current.alpha === applied.alpha
    ? state.base.alpha
    : (current?.alpha ?? 1);
}

/** Apply the sector factor to a Cesium point/billboard without owning its base style. */
export function applyCyberSonarPrimitive(
  visual,
  factor,
  active = true,
  sampler,
  property = 'color',
  opaque = false,
) {
  if (!visual) return;
  const current = visual[property];
  let slots = primitiveColors.get(visual);
  let state = slots?.[property];
  const ownsCurrentColor =
    state &&
    current &&
    current.red === state.lastAppliedColor.red &&
    current.green === state.lastAppliedColor.green &&
    current.blue === state.lastAppliedColor.blue &&
    current.alpha === state.lastAppliedColor.alpha;
  if (!active) {
    // An owner refresh between the last paint and teardown wins over our cache.
    if (ownsCurrentColor)
      visual[property] = state.undefinedBase
        ? undefined
        : copyColor(state.base);
    if (slots) delete slots[property];
    return;
  }
  if (!current && property !== 'color') return;
  const nextFactor = clamp01(factor);
  // Cesium setters copy into a stable internal Color instead of retaining the
  // assigned object. Compare its channels with our snapshot as well, so an
  // owner's in-place style refresh is still recognized as a new base.
  if (
    ownsCurrentColor &&
    Math.abs(nextFactor - state.lastAppliedFactor) <= 0.002 &&
    state.floor === sampler?.floor
  ) {
    return;
  }
  if (!ownsCurrentColor) {
    if (!state) {
      state = {
        base: copyColor(current) || { red: 1, green: 1, blue: 1, alpha: 1 },
        lastAppliedFactor: Number.NaN,
      };
      if (!slots) primitiveColors.set(visual, (slots = Object.create(null)));
      slots[property] = state;
    } else {
      state.base.red = current?.red ?? 1;
      state.base.green = current?.green ?? 1;
      state.base.blue = current?.blue ?? 1;
      state.base.alpha = current?.alpha ?? 1;
    }
    state.undefinedBase = current === undefined;
  }
  const next = state.lastAppliedColor || copyColor(state.base);
  if (!next) return;
  const tint =
    property === 'outlineColor' || property === 'backgroundColor'
      ? state.base
      : sampler
        ? sampler.tint(state.base, nextFactor, next)
        : cyberSonarTintColor(state.base, nextFactor);
  next.red = tint.red * (opaque ? nextFactor : 1);
  next.green = tint.green * (opaque ? nextFactor : 1);
  next.blue = tint.blue * (opaque ? nextFactor : 1);
  // Keep models in their owner's opaque/translucent render pass. Dimming RGB
  // avoids rebuilding model draw commands twice on every sector crossing.
  next.alpha = state.base.alpha * (opaque ? 1 : nextFactor);
  visual[property] = next;
  state.appliedColor = visual[property];
  state.lastAppliedColor = next;
  state.lastAppliedFactor = nextFactor;
  state.floor = sampler?.floor;
}

/** One settings read and one clock/viewport calculation per paint, not contact. */
export function createCyberSonarSampler(
  width,
  height,
  now,
  root = globalThis.document?.documentElement,
) {
  if (now === undefined) now = globalThis.performance?.now?.() ?? 0;
  const settings = readCyberSonarSettings(root);
  const floor = settings.opacity / 100;
  const radius = (Math.min(width * 0.4, height * 0.52) * settings.range) / 100;
  const radiusSquared = radius * radius;
  const angle = cyberSonarAngleDeg(now);
  const feather = Math.min(CYBER_SONAR_FEATHER_DEG, settings.sector * 0.42);
  return {
    floor,
    neutral: floor + (1 - floor) * 0.46,
    at(x, y) {
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        width <= 0 ||
        height <= 0
      )
        return 1;
      const dx = x - width / 2,
        dy = y - height / 2;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared > radiusSquared) return floor;
      if (distanceSquared < radiusSquared * 0.000625) return 1;
      const delta =
        ((((Math.atan2(dx, -dy) * 180) / Math.PI - angle) % 360) + 360) % 360;
      if (delta > settings.sector) return floor;
      return (
        floor + (1 - floor) * Math.min(1, (settings.sector - delta) / feather)
      );
    },
    label(factor) {
      return (1 + factor) * 0.5;
    },
    tint(base, factor, out) {
      const coverage =
        floor >= 0.9999 ? 1 : clamp01((factor - floor) / (1 - floor));
      out.red = base.red * 0.28 + (0.62 + 0.38 * coverage) * 0.72;
      out.green = base.green * 0.28 + (0.68 + 0.16 * coverage) * 0.72;
      out.blue = base.blue * 0.28 + (0.72 + 0.12 * coverage) * 0.72;
      return out;
    },
  };
}

/** Remaining delay before the next contact-projection refresh is due. */
export function cyberSonarFrameDelay(
  lastPaintAt,
  nowMs,
  intervalMs = CYBER_SONAR_RENDER_INTERVAL_MS,
) {
  if (
    !Number.isFinite(lastPaintAt) ||
    !Number.isFinite(nowMs) ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0
  ) {
    return 0;
  }
  return Math.max(0, intervalMs - (nowMs - lastPaintAt));
}

const datasetNumber = (root, key, fallback) => {
  const value = Number(root?.dataset?.[key]);
  return Number.isFinite(value) ? value : fallback;
};

export function readCyberSonarSettings(
  root = globalThis.document?.documentElement,
) {
  return {
    rings: Math.round(
      clamp(
        datasetNumber(root, 'cyberSonarRings', CYBER_SONAR_DEFAULTS.rings),
        3,
        12,
      ),
    ),
    range: Math.round(
      clamp(
        datasetNumber(root, 'cyberSonarRange', CYBER_SONAR_DEFAULTS.range),
        60,
        120,
      ),
    ),
    intensity: Math.round(
      clamp(
        datasetNumber(
          root,
          'cyberSonarIntensity',
          CYBER_SONAR_DEFAULTS.intensity,
        ),
        0,
        100,
      ),
    ),
    opacity: Math.round(
      clamp(
        datasetNumber(root, 'cyberSonarOpacity', CYBER_SONAR_DEFAULTS.opacity),
        35,
        100,
      ),
    ),
    sector: Math.round(
      clamp(
        datasetNumber(root, 'cyberSonarSector', CYBER_SONAR_DEFAULTS.sector),
        8,
        60,
      ),
    ),
  };
}

export function applyCyberSonarSettings(
  settings,
  root = globalThis.document?.documentElement,
) {
  if (!root?.dataset || !root?.style) return readCyberSonarSettings(root);
  const next = {
    ...readCyberSonarSettings(root),
    ...(settings || {}),
  };
  // Ignore stale session input from the removed effect selector.
  delete next.mode;
  delete root.dataset.cyberSonarMode;
  next.rings = Math.round(
    clamp(Number(next.rings) || CYBER_SONAR_DEFAULTS.rings, 3, 12),
  );
  next.range = Math.round(
    clamp(Number(next.range) || CYBER_SONAR_DEFAULTS.range, 60, 120),
  );
  next.intensity = Math.round(
    clamp(
      Number.isFinite(Number(next.intensity))
        ? Number(next.intensity)
        : CYBER_SONAR_DEFAULTS.intensity,
      0,
      100,
    ),
  );
  next.opacity = Math.round(
    clamp(
      Number.isFinite(Number(next.opacity))
        ? Number(next.opacity)
        : CYBER_SONAR_DEFAULTS.opacity,
      35,
      100,
    ),
  );
  next.sector = Math.round(
    clamp(Number(next.sector) || CYBER_SONAR_DEFAULTS.sector, 8, 60),
  );
  root.dataset.cyberSonarRings = String(next.rings);
  root.dataset.cyberSonarRange = String(next.range);
  root.dataset.cyberSonarIntensity = String(next.intensity);
  root.dataset.cyberSonarOpacity = String(next.opacity);
  root.dataset.cyberSonarSector = String(next.sector);
  root.style.setProperty('--cyber-sonar-ring-step', `${100 / next.rings}%`);
  root.style.setProperty(
    '--cyber-sonar-size-vw',
    `${(80 * next.range) / 100}vw`,
  );
  root.style.setProperty(
    '--cyber-sonar-size-vh',
    `${(104 * next.range) / 100}vh`,
  );
  root.style.setProperty(
    '--cyber-sonar-visual-intensity',
    String(0.22 + 0.5 * (next.intensity / 100)),
  );
  root.style.setProperty(
    '--cyber-sonar-sector-quarter',
    `${next.sector * 0.25}deg`,
  );
  root.style.setProperty(
    '--cyber-sonar-sector-middle',
    `${next.sector * 0.6}deg`,
  );
  root.style.setProperty('--cyber-sonar-sector-width', `${next.sector}deg`);
  return next;
}

const cyberSonarDimFactor = (root = globalThis.document?.documentElement) =>
  readCyberSonarSettings(root).opacity / 100;

const cyberSonarLabelDimFactor = (
  root = globalThis.document?.documentElement,
) => {
  const contactFloor = cyberSonarDimFactor(root);
  return Number((contactFloor + (1 - contactFloor) * 0.5).toFixed(4));
};

export function cyberSonarNeutralIntensity(
  root = globalThis.document?.documentElement,
) {
  const dimFactor = cyberSonarDimFactor(root);
  return dimFactor + (1 - dimFactor) * 0.46;
}

export function cyberSonarTintColor(
  baseColor,
  contactIntensity,
  root = globalThis.document?.documentElement,
) {
  const dimFactor = cyberSonarDimFactor(root);
  const remainingRange = 1 - dimFactor;
  const coverage =
    remainingRange <= 0.0001
      ? 1
      : clamp01((contactIntensity - dimFactor) / remainingRange);
  const target = {
    red: 0.62 + 0.38 * coverage,
    green: 0.68 + 0.16 * coverage,
    blue: 0.72 + 0.12 * coverage,
  };
  const retain = 0.28;
  return {
    red: (baseColor?.red ?? 1) * retain + target.red * (1 - retain),
    green: (baseColor?.green ?? 1) * retain + target.green * (1 - retain),
    blue: (baseColor?.blue ?? 1) * retain + target.blue * (1 - retain),
    alpha: baseColor?.alpha ?? 1,
  };
}

const normalizedPhaseMs = (nowMs) => {
  if (!Number.isFinite(nowMs)) return 0;
  return (
    ((nowMs % CYBER_SONAR_PERIOD_MS) + CYBER_SONAR_PERIOD_MS) %
    CYBER_SONAR_PERIOD_MS
  );
};

/** Clockwise sweep heading, where 0 degrees is the top of the keyhole. */
export function cyberSonarAngleDeg(nowMs) {
  return (normalizedPhaseMs(nowMs) / CYBER_SONAR_PERIOD_MS) * 360;
}

/** Negative CSS animation delay that synchronizes the sector to the shared clock. */
export function cyberSonarAnimationDelay(nowMs) {
  return `${-normalizedPhaseMs(nowMs)}ms`;
}

/**
 * Brightness/alpha multiplier for one screen-projected contact.
 * Invalid projections fail open so a render edge case never hides a contact.
 */
export function cyberSonarIntensityAtScreenPoint(
  x,
  y,
  viewportWidth,
  viewportHeight,
  nowMs,
  root = globalThis.document?.documentElement,
) {
  if (
    ![x, y, viewportWidth, viewportHeight, nowMs].every(Number.isFinite) ||
    viewportWidth <= 0 ||
    viewportHeight <= 0
  ) {
    return 1;
  }

  const centerX = viewportWidth / 2;
  const centerY = viewportHeight / 2;
  const dx = x - centerX;
  const dy = y - centerY;
  const settings = readCyberSonarSettings(root);
  const dimFactor = cyberSonarDimFactor(root);
  const radius =
    Math.min(viewportWidth * 0.4, viewportHeight * 0.52) *
    (settings.range / 100);
  const distance = Math.hypot(dx, dy);

  if (distance > radius) return dimFactor;
  if (distance < radius * 0.025) return 1;

  const pointAngle = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
  const delta = (pointAngle - cyberSonarAngleDeg(nowMs) + 360) % 360;
  const sweepDeg = settings.sector;
  const featherDeg = Math.min(CYBER_SONAR_FEATHER_DEG, sweepDeg * 0.42);
  if (delta > sweepDeg) return dimFactor;

  const featherStart = sweepDeg - featherDeg;
  const coverage =
    delta <= featherStart ? 1 : clamp01((sweepDeg - delta) / featherDeg);
  return dimFactor + (1 - dimFactor) * coverage;
}

/** Preserve label legibility while keeping it synchronized with the stronger contact sweep. */
export function cyberSonarLabelIntensity(
  contactIntensity,
  root = globalThis.document?.documentElement,
) {
  const dimFactor = cyberSonarDimFactor(root);
  const labelDimFactor = cyberSonarLabelDimFactor(root);
  const remainingRange = 1 - dimFactor;
  if (remainingRange <= 0.0001) return 1;
  const normalized = clamp01((contactIntensity - dimFactor) / remainingRange);
  return labelDimFactor + (1 - labelDimFactor) * normalized;
}

export function isCyberSonarEnabled(
  root = globalThis.document?.documentElement,
) {
  return root?.dataset?.cyberSonar !== 'off';
}

export function setCyberSonarEnabled(
  enabled,
  root = globalThis.document?.documentElement,
) {
  if (!root?.dataset) return false;
  root.dataset.cyberSonar = enabled ? 'on' : 'off';
  if (root.dataset.uiTheme === 'cyber') {
    applyCyberSonarThemePhase(root, enabled);
  }
  return enabled;
}

/** Whether the map-mode sweep should alter flight presentation. */
export function isCyberSonarActive({
  root = globalThis.document?.documentElement,
  body = globalThis.document?.body,
  hud,
  reducedMotion,
} = {}) {
  // Keep optional method calls in the body: production downleveling of nested
  // parameter initializers can otherwise lose the method's receiver binding.
  if (hud === undefined)
    hud = globalThis.document?.getElementById?.('intel-hud');
  if (reducedMotion === undefined)
    reducedMotion =
      globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ??
      false;
  return !!(
    root?.dataset?.uiTheme === 'cyber' &&
    isCyberSonarEnabled(root) &&
    hud?.classList?.contains?.('active') &&
    !body?.classList?.contains?.('cockpit-mode') &&
    !reducedMotion
  );
}

export function isCyberMapThemeActive({
  root = globalThis.document?.documentElement,
  body = globalThis.document?.body,
  hud,
} = {}) {
  if (hud === undefined)
    hud = globalThis.document?.getElementById?.('intel-hud');
  return !!(
    root?.dataset?.uiTheme === 'cyber' &&
    hud?.classList?.contains?.('active') &&
    !body?.classList?.contains?.('cockpit-mode')
  );
}

// Unsupported engines retain their native contact rendering, without a dimmer
// fallback. Decorative rings remain independent from the contact adapter.
export function isCyberContactThemeActive(options = {}) {
  const root = options.root ?? globalThis.document?.documentElement;
  return (
    isCyberMapThemeActive(options) &&
    root?.dataset?.cyberSonarGpu !== 'unsupported'
  );
}

export function isCyberContactSonarActive(options = {}) {
  return isCyberContactThemeActive(options) && isCyberSonarActive(options);
}

/** Set or clear the shared visual phase used by the sector and contact sweep. */
export function applyCyberSonarThemePhase(root, enabled, nowMs) {
  if (!root?.style) return;
  if (!enabled || !isCyberSonarEnabled(root)) {
    root.style.removeProperty?.('--cyber-sonar-angle');
    root.style.removeProperty?.('--cyber-sonar-phase-delay');
    return;
  }
  const clock = Number.isFinite(nowMs)
    ? nowMs
    : (globalThis.performance?.now?.() ?? 0);
  // The visual sweep is compositor-animated. Writing a custom property on the
  // document root every frame invalidates styles across the entire HUD, so JS
  // only seeds the shared clock when the theme or sonar state changes.
  root.style.removeProperty?.('--cyber-sonar-angle');
  const currentDelay = root.style
    .getPropertyValue?.('--cyber-sonar-phase-delay')
    ?.trim();
  // setVariant() may be called repeatedly with the already-active layout.
  // Preserve the running animation's original timeline in that case; changing
  // its negative delay after it has started would shift the sector off the
  // absolute clock used by contact highlighting.
  if (currentDelay) return;
  root.style.setProperty?.(
    '--cyber-sonar-phase-delay',
    cyberSonarAnimationDelay(clock),
  );
}
