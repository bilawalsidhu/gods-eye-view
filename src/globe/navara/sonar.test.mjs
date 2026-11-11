import assert from 'node:assert/strict';
import test from 'node:test';
import { createCyberSonarSampler } from '../../cyberSonar.js';
import { patchMoverShader } from './movers/moverMesh.js';
import {
  DETACHED_SONAR,
  SONAR_VERTEX,
  createNavaraSonar,
  sonarFactorAt,
  sonarUniformsFor,
} from './sonar.js';

// A document root carrying the Cyber sonar settings, as the HUD writes them.
const rootWith = ({ range, opacity, sector }) => ({
  dataset: {
    cyberSonarRange: String(range),
    cyberSonarOpacity: String(opacity),
    cyberSonarSector: String(sector),
  },
});

test('the shader factor is the CPU sampler of cyberSonar.js', () => {
  const settings = [
    { range: 100, opacity: 84, sector: 24 },
    { range: 60, opacity: 35, sector: 8 },
    { range: 120, opacity: 50, sector: 60 },
  ];
  for (const { width, height } of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ])
    for (const setting of settings)
      for (const nowMs of [0, 700, 2600, 4100, 5199]) {
        const sampler = createCyberSonarSampler(
          width,
          height,
          nowMs,
          rootWith(setting),
        );
        const angleDeg = ((((nowMs % 5200) + 5200) % 5200) / 5200) * 360;
        const state = { enabled: true, active: true, angleDeg, ...setting };
        for (let y = 0; y <= height; y += height / 16)
          for (let x = 0; x <= width; x += width / 16) {
            const expected = sampler.at(x, y);
            const actual = sonarFactorAt(x, y, width, height, state);
            assert.ok(
              Math.abs(actual - expected) < 1e-9,
              `${width}x${height} ${JSON.stringify(setting)} t=${nowMs} (${x}, ${y}): ${actual} vs ${expected}`,
            );
          }
        // The sweep off: the sampler's neutral factor everywhere.
        assert.ok(
          Math.abs(
            sonarFactorAt(10, 10, width, height, { ...state, active: false }) -
              sampler.neutral,
          ) < 1e-12,
        );
      }
  // Off: contacts unchanged.
  assert.equal(
    sonarFactorAt(5, 5, 100, 100, { enabled: false, active: true }),
    1,
  );
});

test('the GLSL carries the same rule as its JS twin', () => {
  for (const term of [
    'radiusSquared * 0.000625',
    'min(resolution.x * 0.4, resolution.y * 0.52) * uGevSonar.y',
    'floorValue + (1.0 - floorValue) * 0.46',
    'min(10.0, uGevSonarSector * 0.42)',
    'degrees(atan(pixel.x, pixel.y)) - uGevSonar.x + 360.0',
    'color.rgb * 0.28 + (vec3(0.62, 0.68, 0.72) + vec3(0.38, 0.16, 0.12) * coverage) * 0.72',
    'color.a * factor',
  ])
    assert.ok(SONAR_VERTEX.includes(term), term);
});

test('the mover shaders treat contacts by their anchor and keep their position', () => {
  for (const point of [false, true]) {
    const shader = patchMoverShader(
      {
        uniforms: {},
        vertexShader:
          'void main() {\n#include <uv_vertex>\n#include <project_vertex>\n}',
        fragmentShader:
          'void main() {\n#include <color_fragment>\n#include <colorspace_fragment>\n}',
      },
      {},
      { point },
    );
    assert.match(
      shader.vertexShader,
      /vGevSonarFactor = gevSonarFactor\(projectionMatrix \* mvCenter, uGevResolution\);/,
    );
    assert.match(
      shader.vertexShader,
      /vGevColor = gevSonarColor\(gevColor, vGevSonarFactor\);/,
    );
    // gl_Position comes from the corner before the sonar runs.
    assert.ok(
      shader.vertexShader.indexOf(
        'gl_Position = projectionMatrix * mvPosition',
      ) < shader.vertexShader.indexOf('gevSonarFactor(projectionMatrix'),
    );
    if (point)
      assert.match(
        shader.fragmentShader,
        /vGevOutlineColor\.a \* vGevSonarFactor/,
      );
  }
});

test('one set of sonar uniforms per view, written by the port', () => {
  const view = {};
  const uniforms = sonarUniformsFor(view);
  assert.equal(sonarUniformsFor(view), uniforms, 'shared by its overlays');
  assert.notEqual(sonarUniformsFor({}), uniforms);
  assert.equal(DETACHED_SONAR.uGevSonarEnabled.value, 0);
  const port = createNavaraSonar(view);
  port.set({
    enabled: true,
    active: true,
    angleDeg: 120,
    range: 80,
    opacity: 50,
    sector: 30,
  });
  assert.deepEqual(uniforms.uGevSonar.value, [120, 0.8, 0.5, 1]);
  assert.equal(uniforms.uGevSonarSector.value, 30);
  assert.equal(uniforms.uGevSonarEnabled.value, 1);
  port.destroy();
  assert.equal(uniforms.uGevSonarEnabled.value, 0);
});
