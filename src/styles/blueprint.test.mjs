import assert from 'node:assert/strict';
import test from 'node:test';
import { blueprintShader } from './blueprint.js';
import { STYLES, STYLE_STATUS_LABELS } from '../ui/visualPresets.js';
import { STYLE_URL_NAMES, VIEW_STYLES } from '../view/index.js';
import {
  COCKPIT_VISION_MODES,
  cockpitVisionModeForStyle,
} from '../cockpitVisionPolicy.js';

test('blueprintShader defines expected shader uniforms and structure', () => {
  assert.equal(blueprintShader.name, 'blueprint');
  assert.ok(
    blueprintShader.uniforms.lineIntensity,
    'lineIntensity uniform defined',
  );
  assert.equal(blueprintShader.uniforms.lineIntensity.default, 1.2);
  assert.equal(blueprintShader.uniforms.lineIntensity.min, 0);
  assert.equal(blueprintShader.uniforms.lineIntensity.max, 2);

  assert.ok(
    blueprintShader.uniforms.gridDensity,
    'gridDensity uniform defined',
  );
  assert.equal(blueprintShader.uniforms.gridDensity.default, 0.5);
  assert.equal(blueprintShader.uniforms.gridDensity.min, 0);
  assert.equal(blueprintShader.uniforms.gridDensity.max, 1);

  assert.match(blueprintShader.fragmentShader, /uniform float lineIntensity;/);
  assert.match(blueprintShader.fragmentShader, /uniform float gridDensity;/);
  assert.match(blueprintShader.fragmentShader, /out_FragColor = vec4/);
});

test('blueprint style is registered across visual presets, views, and cockpit', () => {
  assert.equal(STYLES.blueprint, blueprintShader);
  assert.equal(STYLE_URL_NAMES.blueprint, 'blueprint');
  assert.ok(VIEW_STYLES.includes('blueprint'));

  assert.ok(COCKPIT_VISION_MODES.includes('blueprint'));
  assert.equal(cockpitVisionModeForStyle('blueprint'), 'blueprint');
});
