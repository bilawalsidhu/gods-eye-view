// The NVG and FLIR row-sum texture can be a framebuffer Cesium's bloom
// blur samples LINEAR; the main shaders read it at texel centres, where LINEAR and NEAREST agree.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createCesiumEffects } from './effects.js';
import { styleDefinition } from '../../ui/visualEffects.js';
import { nightVisionShader } from '../../styles/surveillance.js';
import { thermalShader } from '../../styles/thermal.js';

// No GL in Node: keep the framebuffer bookkeeping, skip the GL objects.
Cesium.FramebufferManager.prototype.update = function () {};
Cesium.FramebufferManager.prototype.destroy = function () {};

for (const shader of [nightVisionShader, thermalShader])
  test(`${shader.name}: bloom row sums are read at texel centres`, () => {
    const collection = new Cesium.PostProcessStageCollection();
    const fx = createCesiumEffects(
      { postProcessStages: collection },
      {
        capabilities: new Set(['styles', 'bloom', 'sharpen']),
        frame: {
          on: () => () => {},
          holdContinuous: () => () => {},
          requestRender() {},
        },
        report: (e) => {
          throw e;
        },
      },
    );
    fx.port.defineStyle(styleDefinition(shader.name, shader));
    fx.port.setStyle(shader.name);
    fx.port.bloom({ enabled: true, strength: 0.5 }); // scene-wide Bloom, HDR off (default)
    const cache = collection._textureCache;
    cache.updateDependencies();
    cache.update({
      drawingBufferWidth: 100,
      drawingBufferHeight: 100,
      depthTexture: true,
    });
    const rows = `effects_style_${shader.name}_bloomRowsTexture`;
    const shared = cache._framebuffers.find((f) =>
      f.stages.includes(rows),
    ).stages;
    // Precondition: the row pass writes into the blur-x framebuffer, whose
    // texture czm_bloom_blur_y_direction (sampleMode LINEAR) re-samples.
    assert.ok(
      shared.includes('czm_bloom_blur_x_direction'),
      JSON.stringify(shared),
    );
    // So the main shader reads each row sum at a texel centre.
    const reads = [
      ...shader.fragmentShader.matchAll(/texture\(bloomRowsTexture, ([^\n]*)/g),
    ].map((match) => match[1]);
    assert.ok(reads.length > 0);
    for (const read of reads)
      assert.match(read, /^\(floor\(.+\) \+ 0\.5\) \/ dims\)/);
  });
