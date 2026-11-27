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
const CYBER_SONAR_FEATHER_DEG = 10;
const CYBER_SONAR_DEFAULTS = Object.freeze({
  rings: 8,
  range: 100,
  intensity: 70,
  opacity: 84,
  sector: 24,
});

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
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

// The contact tint: a cool grey outside the sector, warm inside it, each
// mixed in at this strength over the contact's own colour.
const CYBER_SONAR_DIM_RGB = [0.62, 0.68, 0.72];
const CYBER_SONAR_LIT_RGB = [1, 0.84, 0.84];
const CYBER_SONAR_TINT_STRENGTH = 0.72;
/** How far toward the warm tint contacts sit while the sweep is off. */
const CYBER_SONAR_NEUTRAL_COVERAGE = 0.46;

const hexOf = (rgb) =>
  `#${rgb
    .map((c) =>
      Math.round(clamp01(c) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;

/**
 * The renderer's screen modulation sector for the Cyber contact sweep over
 * a `width` x `height` CSS-pixel map: the same band `createCyberSonarSampler`
 * samples. Not sweeping (Sonar OFF, reduced motion), a radius of 0 holds
 * every contact at the neutral level the sweep rests at.
 * @param {number} width
 * @param {number} height
 * @param {number} nowMs
 * @param {{sweeping?: boolean, root?: object}} [options]
 * @returns {import('./render/contract/effects').ModulationSector}
 */
export function cyberSonarSector(
  width,
  height,
  nowMs,
  { sweeping = true, root = globalThis.document?.documentElement } = {},
) {
  const settings = readCyberSonarSettings(root);
  const floor = settings.opacity / 100;
  const center = { x: width / 2, y: height / 2 };
  const widthRad = (settings.sector * Math.PI) / 180;
  if (!sweeping) {
    const coverage = floor >= 0.9999 ? 1 : CYBER_SONAR_NEUTRAL_COVERAGE;
    return {
      center,
      angle: 0,
      width: widthRad,
      radius: 0,
      floor: floor + (1 - floor) * CYBER_SONAR_NEUTRAL_COVERAGE,
      strength: CYBER_SONAR_TINT_STRENGTH,
      color: hexOf(
        CYBER_SONAR_DIM_RGB.map(
          (c, i) => c + (CYBER_SONAR_LIT_RGB[i] - c) * coverage,
        ),
      ),
    };
  }
  return {
    center,
    angle: (cyberSonarAngleDeg(nowMs) * Math.PI) / 180,
    width: widthRad,
    radius: (Math.min(width * 0.4, height * 0.52) * settings.range) / 100,
    floor,
    strength: CYBER_SONAR_TINT_STRENGTH,
    color: hexOf(CYBER_SONAR_LIT_RGB),
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
 * Sonar is an opt-in visual style over any HUD layout: it is on only after
 * the Display panel's Sonar toggle, a voice request or a legacy Cyber link
 * turns it on.
 */
export function isCyberSonarEnabled(
  root = globalThis.document?.documentElement,
) {
  return root?.dataset?.cyberSonar === 'on';
}

export function setCyberSonarEnabled(
  enabled,
  root = globalThis.document?.documentElement,
) {
  if (!root?.dataset) return false;
  root.dataset.cyberSonar = enabled ? 'on' : 'off';
  applyCyberSonarThemePhase(root, enabled);
  return enabled;
}

/**
 * Whether the map-mode sweep should alter flight presentation. `hudActive`
 * is the HUD's visibility from its owner, which a caller acting on it in the
 * same turn passes; otherwise the rendered `#intel-hud` class answers.
 */
export function isCyberSonarActive({
  root = globalThis.document?.documentElement,
  body = globalThis.document?.body,
  hud,
  hudActive,
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
    isCyberSonarEnabled(root) &&
    (hudActive ?? hud?.classList?.contains?.('active')) &&
    !body?.classList?.contains?.('cockpit-mode') &&
    !reducedMotion
  );
}

export function isCyberMapThemeActive({
  root = globalThis.document?.documentElement,
  body = globalThis.document?.body,
  hud,
  hudActive,
} = {}) {
  if (hud === undefined)
    hud = globalThis.document?.getElementById?.('intel-hud');
  return !!(
    isCyberSonarEnabled(root) &&
    (hudActive ?? hud?.classList?.contains?.('active')) &&
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
