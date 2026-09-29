// atmosphereCompat: the Apple Metal/ANGLE quarantine for Cesium's per-vertex
// model atmosphere (ported from upstream b456eb8 + 20a03aa). Pins the link
// probe, the iOS/iPadOS platform matrix (including desktop-mode iPad), the
// renderable-not-enabled choice, and the probe context release.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyModelAtmosphereWorkaround,
  isAppleMobilePlatform,
  probeOutParamVaryingLinkFailure,
  shouldDisableModelAtmosphere,
} from './atmosphereCompat.js';
import { readSource } from './testSupport/readSource.js';

/** A fake WebGL2 context: link fails only when both stages compile — the
 *  precise shape of the ANGLE Metal bug (compile clean, link dead). */
function fakeGl({ linkStatus = false, compileStatus = true, missing = [] } = {}) {
  const shaders = [];
  const programs = [];
  const extensions = {};
  return {
    VERTEX_SHADER: 'vs',
    FRAGMENT_SHADER: 'fs',
    COMPILE_STATUS: 'compile',
    LINK_STATUS: 'link',
    createShader: (kind) => (missing.includes('shader') ? null : { kind }),
    createProgram: () => (missing.includes('program') ? null : { id: programs.length }),
    shaderSource(_s, src) { shaders.push(src); },
    compileShader() {},
    getShaderParameter: (_s, what) => (what === 'compile' ? compileStatus : true),
    attachShader() {},
    linkProgram() {},
    getProgramParameter: (_p, what) => (what === 'link' ? linkStatus : true),
    deleteShader: (s) => shaders.splice(shaders.indexOf(s), 1),
    deleteProgram: (p) => programs.splice(programs.indexOf(p), 1),
    getExtension: (name) => extensions[name] || null,
    __release: (name) => { extensions[name] = { loseContext() { extensions[name].lost = true; } }; },
    __shaders: shaders,
    __programs: programs,
  };
}

test('the probe reports failure only for a clean-compile/dead-link program', () => {
  assert.equal(probeOutParamVaryingLinkFailure(fakeGl({ linkStatus: false })), true);
  assert.equal(probeOutParamVaryingLinkFailure(fakeGl({ linkStatus: true })), false,
    'a linking program means the driver is fine');
  assert.equal(probeOutParamVaryingLinkFailure(fakeGl({ compileStatus: false })), false,
    'a compile failure is not the bug being probed for');
  assert.equal(probeOutParamVaryingLinkFailure(null), false,
    'no context is never mistaken for a broken driver');
  assert.equal(probeOutParamVaryingLinkFailure(fakeGl({ missing: ['shader'] })), false);
  assert.equal(probeOutParamVaryingLinkFailure(fakeGl({ missing: ['program'] })), false);
});

test('platform matrix: iOS yes, desktop-mode iPad yes, real Macs and everything else no', () => {
  const ios = { userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)', platform: 'iPad', maxTouchPoints: 5 };
  const iphone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)', platform: 'iPhone', maxTouchPoints: 5 };
  const desktopIpad = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 };
  const appleSiliconMac = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 };
  const intelMac = { userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 0 };
  const windows = { userAgent: 'Mozilla/5.0 (Windows NT 10.0)', platform: 'Win32', maxTouchPoints: 10 };
  const android = { userAgent: 'Android', platform: 'Linux armv8l', maxTouchPoints: 5 };

  assert.equal(isAppleMobilePlatform(ios), true);
  assert.equal(isAppleMobilePlatform(iphone), true);
  assert.equal(isAppleMobilePlatform(desktopIpad), true, 'iPadOS desktop mode: Mac UA + touch');
  assert.equal(isAppleMobilePlatform(appleSiliconMac), false, 'Apple Silicon Macs report 0 touch points');
  assert.equal(isAppleMobilePlatform(intelMac), false);
  assert.equal(isAppleMobilePlatform(windows), false, 'touch alone is not Apple mobile');
  assert.equal(isAppleMobilePlatform(android), false);
  assert.equal(isAppleMobilePlatform(null), false);
  assert.equal(isAppleMobilePlatform({}), false);
});

test('shouldDisableModelAtmosphere: probe verdict is authoritative, Apple mobile is quarantined regardless', () => {
  const desktopIpad = { userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 5 };
  const intelMac = { userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 0 };

  assert.equal(
    shouldDisableModelAtmosphere({ navigatorLike: intelMac, createProbeContext: () => fakeGl({ linkStatus: false }) }),
    true,
    'a failing link quarantines even a desktop Mac',
  );
  assert.equal(
    shouldDisableModelAtmosphere({ navigatorLike: desktopIpad, createProbeContext: () => fakeGl({ linkStatus: true }) }),
    true,
    'a passing probe does NOT lift the Apple-mobile quarantine — the probe is far simpler than Cesium',
  );
  assert.equal(
    shouldDisableModelAtmosphere({ navigatorLike: intelMac, createProbeContext: () => fakeGl({ linkStatus: true }) }),
    false,
    'a healthy driver on a desktop Mac keeps the atmosphere',
  );
  assert.equal(
    shouldDisableModelAtmosphere({ navigatorLike: desktopIpad, createProbeContext: () => null }),
    true,
    'no probe context falls back to platform detection',
  );
});

test('the probe releases its throwaway WebGL2 context (browsers cap live contexts)', () => {
  const gl = fakeGl({ linkStatus: true });
  gl.__release('WEBGL_lose_context');
  let released = false;
  gl.getExtension = (name) => (name === 'WEBGL_lose_context'
    ? { loseContext: () => { released = true; } }
    : null);
  shouldDisableModelAtmosphere({ navigatorLike: null, createProbeContext: () => gl });
  assert.equal(released, true, 'loseContext fires even when the probe path returns early');
});

test('applyModelAtmosphereWorkaround clears renderable, never enabled', () => {
  const scene = { fog: { enabled: true, renderable: true } };
  const applied = applyModelAtmosphereWorkaround(scene, {
    navigatorLike: { userAgent: 'iPhone', platform: 'iPhone', maxTouchPoints: 5 },
    createProbeContext: () => null,
  });
  assert.equal(applied, true);
  assert.equal(scene.fog.renderable, false, 'the broken stage is kept out of the pipeline');
  assert.equal(scene.fog.enabled, true, 'fog density still drives 3D Tiles screen-space error');

  // A scene without fog is left untouched; an unaffected device is a no-op.
  assert.equal(applyModelAtmosphereWorkaround({}, { createProbeContext: () => null }), false);
  assert.equal(applyModelAtmosphereWorkaround(null), false);
  assert.equal(
    applyModelAtmosphereWorkaround(
      { fog: { enabled: true, renderable: true } },
      { navigatorLike: { userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 0 }, createProbeContext: () => fakeGl({ linkStatus: true }) },
    ),
    false,
    'unaffected devices keep the model atmosphere',
  );
});

test('the boot path applies the workaround before tiles build a draw command', () => {
  const main = readSource('./main.js', import.meta.url);
  assert.match(main, /applyModelAtmosphereWorkaround\(viewer\.scene\)/);
  assert.ok(
    main.indexOf('applyModelAtmosphereWorkaround(viewer.scene)') < main.indexOf('createGooglePhotorealistic3DTileset'),
    'the workaround must land before the tileset loads',
  );
});
