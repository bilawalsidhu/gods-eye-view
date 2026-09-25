import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAppleMobilePlatform,
  probeOutParamVaryingLinkFailure,
  shouldDisableModelAtmosphere,
  applyModelAtmosphereWorkaround,
} from './atmosphereCompat.js';

const IPAD_OS12 = {
  userAgent:
    'Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15',
  platform: 'iPad',
  maxTouchPoints: 5,
};
// iPadOS 13+ desktop mode: no iPad token, reports as a Mac.
const IPAD_DESKTOP_MODE = {
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
  platform: 'MacIntel',
  maxTouchPoints: 5,
};
const MAC_DESKTOP = {
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
  platform: 'MacIntel',
  maxTouchPoints: 0,
};
const LINUX_DESKTOP = {
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/141',
  platform: 'Linux x86_64',
  maxTouchPoints: 0,
};

/** Minimal GL double. `linkOk: false` mimics the Metal translator's refusal. */
function fakeGl({ linkOk = true, compileOk = true, throwOn = null } = {}) {
  const deleted = { shaders: 0, programs: 0 };
  return {
    deleted,
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    createShader: () => ({}),
    createProgram: () => ({}),
    shaderSource() {
      if (throwOn === 'shaderSource') throw new Error('context lost');
    },
    compileShader() {},
    attachShader() {},
    linkProgram() {},
    getShaderParameter: () => compileOk,
    getProgramParameter: () => linkOk,
    deleteShader: () => (deleted.shaders += 1),
    deleteProgram: () => (deleted.programs += 1),
  };
}

test('identifies iPadOS in both legacy and desktop-mode guises', () => {
  assert.equal(isAppleMobilePlatform(IPAD_OS12), true);
  assert.equal(isAppleMobilePlatform(IPAD_DESKTOP_MODE), true);
});

test('does not mistake a real Mac or a Linux desktop for Apple mobile', () => {
  // Regression guard: the desktop-mode check keys on touch points, and a Mac
  // reports the same MacIntel platform string with zero of them.
  assert.equal(isAppleMobilePlatform(MAC_DESKTOP), false);
  assert.equal(isAppleMobilePlatform(LINUX_DESKTOP), false);
});

test('treats a missing navigator as not-Apple rather than throwing', () => {
  assert.equal(isAppleMobilePlatform(undefined), false);
  assert.equal(isAppleMobilePlatform(null), false);
});

test('detects desktop-mode iPadOS without navigator.platform', () => {
  // `navigator.platform` is deprecated and can be absent or stripped; the UA's
  // Macintosh token plus touch points has to carry the detection on its own.
  assert.equal(
    isAppleMobilePlatform({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
      maxTouchPoints: 5,
    }),
    true,
  );
  // Same UA, no touch: a real Mac, which must stay untouched.
  assert.equal(
    isAppleMobilePlatform({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
      maxTouchPoints: 0,
    }),
    false,
  );
});

test('probe reports failure only when the program fails to link', () => {
  assert.equal(
    probeOutParamVaryingLinkFailure(fakeGl({ linkOk: false })),
    true,
  );
  assert.equal(
    probeOutParamVaryingLinkFailure(fakeGl({ linkOk: true })),
    false,
  );
});

test('a compile failure is not reported as the link bug', () => {
  // The Metal defect surfaces at link time; both stages compile cleanly.
  // Treating a compile error as the bug would disable fog for the wrong reason.
  assert.equal(
    probeOutParamVaryingLinkFailure(
      fakeGl({ compileOk: false, linkOk: false }),
    ),
    false,
  );
});

test('probe releases its GL objects on both paths', () => {
  const ok = fakeGl({ linkOk: true });
  probeOutParamVaryingLinkFailure(ok);
  assert.equal(ok.deleted.shaders, 2);
  assert.equal(ok.deleted.programs, 1);

  const thrown = fakeGl({ throwOn: 'shaderSource' });
  probeOutParamVaryingLinkFailure(thrown);
  assert.equal(thrown.deleted.shaders, 2, 'shaders freed even when GL throws');
  assert.equal(thrown.deleted.programs, 1);
});

test('probe treats a null context as healthy, not broken', () => {
  assert.equal(probeOutParamVaryingLinkFailure(null), false);
});

test('a failing probe disables the stage on any platform', () => {
  assert.equal(
    shouldDisableModelAtmosphere({
      navigatorLike: LINUX_DESKTOP,
      createProbeContext: () => fakeGl({ linkOk: false }),
    }),
    true,
  );
});

test('a passing probe still quarantines Apple mobile but frees desktops', () => {
  const createProbeContext = () => fakeGl({ linkOk: true });
  assert.equal(
    shouldDisableModelAtmosphere({
      navigatorLike: IPAD_DESKTOP_MODE,
      createProbeContext,
    }),
    true,
  );
  assert.equal(
    shouldDisableModelAtmosphere({
      navigatorLike: LINUX_DESKTOP,
      createProbeContext,
    }),
    false,
  );
});

test('falls back to platform detection when no context can be made', () => {
  const createProbeContext = () => null;
  assert.equal(
    shouldDisableModelAtmosphere({
      navigatorLike: IPAD_OS12,
      createProbeContext,
    }),
    true,
  );
  assert.equal(
    shouldDisableModelAtmosphere({
      navigatorLike: MAC_DESKTOP,
      createProbeContext,
    }),
    false,
  );
});

test('applies to the scene by clearing renderable, never enabled', () => {
  // `enabled` must survive: Fog.update short-circuits when it is false, which
  // forfeits the density used for 3D Tiles screen-space-error scaling, and
  // visualSettings' IR boost saves/restores that same flag.
  const scene = { fog: { enabled: true, renderable: true } };
  const applied = applyModelAtmosphereWorkaround(scene, {
    navigatorLike: IPAD_DESKTOP_MODE,
    createProbeContext: () => null,
  });
  assert.equal(applied, true);
  assert.equal(scene.fog.renderable, false);
  assert.equal(scene.fog.enabled, true);
});

test('leaves unaffected devices completely untouched', () => {
  const scene = { fog: { enabled: true, renderable: true } };
  const applied = applyModelAtmosphereWorkaround(scene, {
    navigatorLike: LINUX_DESKTOP,
    createProbeContext: () => fakeGl({ linkOk: true }),
  });
  assert.equal(applied, false);
  assert.equal(scene.fog.renderable, true);
});

test('tolerates a scene with no fog object', () => {
  assert.equal(applyModelAtmosphereWorkaround({}, {}), false);
  assert.equal(applyModelAtmosphereWorkaround(null, {}), false);
});

test('releases the throwaway probe context after probing', () => {
  let lost = 0;
  const gl = fakeGl({ linkOk: true });
  gl.getExtension = (name) =>
    name === 'WEBGL_lose_context' ? { loseContext: () => (lost += 1) } : null;
  shouldDisableModelAtmosphere({
    navigatorLike: LINUX_DESKTOP,
    createProbeContext: () => gl,
  });
  assert.equal(lost, 1, 'probe context must not linger until GC');
});
