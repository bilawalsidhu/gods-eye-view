import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from 'cesium';
import {
  createNativeRasterImageryProvider,
  installNativeRasterDatelineMapping,
  nativeRasterImageryDiagnostics,
  nativeRasterDimensions,
  updateNativeRasterImagery,
  installNativeNightGlobeLighting,
  NATIVE_NIGHT_BRIGHTNESS,
} from './nativeRasterImagery.js';

const options = {
  url: 'data:image/png;base64,AA==',
  tileWidth: 2048,
  tileHeight: 1024,
  rectangle: C.Rectangle.MAX_VALUE,
};
const builder = () => {
  const result = new C.ShaderBuilder();
  result.addVarying('vec3', 'v_positionWC');
  return result;
};
const input = (provider, index = 0) => ({
  imageryLayer: new C.ImageryLayer(provider),
  imageryTexCoordAttributeSetIndex: index,
});
const body = (shader, id) => shader._functions[id]?.body.join('\n') || '';

test('real globe shader receives GPU night masking once while ordinary imagery keeps its native sample', () => {
  const source = C._shadersGlobeFS;
  assert.ok(source.includes('in vec3 v_positionMC;'));
  const stage = {
    baseFragmentShaderSource: { sources: [source] },
    getShaderProgram(options) {
      return options;
    },
  };
  const viewer = {
    scene: {
      globe: { _surface: { _tileProvider: { _surfaceShaderSet: stage } } },
    },
  };
  installNativeNightGlobeLighting(C, viewer);
  const token = {};
  assert.equal(stage.getShaderProgram(token), token);
  const text = stage.baseFragmentShaderSource.sources[0];
  assert.ok(text.includes('czm_sunDirectionWC'));
  assert.ok(text.includes(`textureBrightness == ${NATIVE_NIGHT_BRIGHTNESS}.0`));
  assert.ok(text.includes('gevNightLighting(value, v_positionMC)'));
  assert.ok(text.includes('textureBrightness = 1.0;'));
  assert.equal((text.match(/vec4 gevNightLighting\(/g) || []).length, 1);
  stage.getShaderProgram(token);
  assert.equal(stage.baseFragmentShaderSource.sources[0], text);
  const clean = { baseFragmentShaderSource: { sources: [source] } };
  assert.equal(
    clean.baseFragmentShaderSource.sources[0],
    source,
    'other viewer is untouched',
  );
});

test('night imagery evaluates the GPU sun mask on native 3D geometry while scalar imagery keeps ordinary sampling', () => {
  const night = createNativeRasterImageryProvider(
    C,
    { ...options, nightLighting: true },
    'tileset',
  );
  const layer = new C.ImageryLayer(night);
  layer.brightness = NATIVE_NIGHT_BRIGHTNESS;
  const shader = builder();
  C.ImageryPipelineStage._createMainImageryShader(
    shader,
    [{ imageryLayer: layer, imageryTexCoordAttributeSetIndex: 0 }],
    { brightness: true, alpha: true },
  );
  const text = body(shader, 'gevRasterSampleAndBlend');
  assert.ok(text.includes('gevNightLighting(value, v_positionWC)'));
  assert.ok(body(shader, 'gevNightLighting').includes('czm_sunDirectionWC'));
  assert.ok(
    shader._fragmentShaderParts.functionIds.indexOf('gevNightLighting') <
      shader._fragmentShaderParts.functionIds.indexOf(
        'gevRasterSampleAndBlend',
      ),
    'GPU night helper is declared before its sampling caller',
  );
  const ordinary = builder();
  C.ImageryPipelineStage._createMainImageryShader(
    ordinary,
    [input(createNativeRasterImageryProvider(C, options, 'tileset'))],
    { brightness: true },
  );
  assert.equal(
    body(ordinary, 'gevRasterSampleAndBlend').includes('gevNightLighting'),
    false,
  );
});

test('raster sizing retains global aspect ratio and enables mipmaps within the texture budget', () => {
  assert.deepEqual(nativeRasterDimensions(3600), { width: 4096, height: 2048 });
  assert.deepEqual(nativeRasterDimensions(720, 2048), {
    width: 1024,
    height: 512,
  });
  assert.deepEqual(nativeRasterDimensions(10000, 2048), {
    width: 2048,
    height: 1024,
  });
});

test('refresh updates shared loaded textures and mipmaps without replacing layer or pending imagery', async () => {
  const canvas = { width: 2048, height: 1024 };
  const provider = createNativeRasterImageryProvider(
    C,
    { ...options, canvas },
    'tileset',
  );
  const calls = [];
  const texture = {
    width: 2048,
    height: 1024,
    sampler: {
      minificationFilter: C.TextureMinificationFilter.LINEAR_MIPMAP_LINEAR,
    },
    copyFrom: (value) => calls.push(['upload', value.source]),
    generateMipmap: (hint) => calls.push(['mipmap', hint]),
  };
  const pending = { image: canvas };
  const layer = {
    imageryProvider: provider,
    alpha: 0.67,
    show: true,
    _imageryCache: { loaded: { texture }, shared: { texture }, pending },
  };
  const cache = layer._imageryCache;
  assert.equal(updateNativeRasterImagery(C, layer, canvas), 1);
  assert.deepEqual(calls, [
    ['upload', canvas],
    ['mipmap', C.MipmapHint.NICEST],
  ]);
  assert.equal(layer._imageryCache, cache);
  assert.equal(layer._imageryCache.pending, pending);
  assert.equal(layer.alpha, 0.67);
  assert.equal(layer.show, true);
  assert.equal(await provider.requestImage(0, 0, 0), canvas);
  texture.width = 1024;
  assert.throws(
    () => updateNativeRasterImagery(C, layer, canvas),
    /dimensions/,
  );
  assert.equal(calls.length, 2, 'invalid upload retains the old texture');
  assert.throws(
    () => updateNativeRasterImagery(C, { imageryProvider: {} }, canvas),
    /owned/,
  );
});

test('real Cesium vertices on either side of dateline reproduce incorrect midpoint sampling, while fragment ECEF stays at the seam', () => {
  const positions = [
    C.Cartographic.fromDegrees(179.8, 10),
    C.Cartographic.fromDegrees(-179.8, 10),
    C.Cartographic.fromDegrees(179.8, 11),
  ];
  const rect =
    C.ModelImageryMapping.computeCartographicBoundingRectangle(positions);
  assert.ok(C.Math.toDegrees(rect.width) > 359);
  const texCoords = C.ModelImageryMapping._createTextureCoordinates(
    positions,
    3,
    rect,
    new C.GeographicProjection(),
  );
  assert.equal(
    (texCoords[0] + texCoords[2]) / 2,
    0.5,
    'vertex longitude interpolation incorrectly crosses Greenwich',
  );
  const first = C.Cartesian3.fromRadians(
    positions[0].longitude,
    positions[0].latitude,
  );
  const second = C.Cartesian3.fromRadians(
    positions[1].longitude,
    positions[1].latitude,
  );
  const midpoint = C.Cartesian3.midpoint(first, second, new C.Cartesian3());
  const u = Math.atan2(midpoint.y, midpoint.x) / (Math.PI * 2) + 0.5;
  assert.ok(
    u < 0.001 || u > 0.999,
    'fragment interpolation in continuous ECEF samples ±180, never 0 degrees',
  );
});

test('provider uses same exported runtime stage, preserves exclusive max-level adaptation and promises direct canvases', async () => {
  const canvas = { width: 2048, height: 1024 };
  const globe = createNativeRasterImageryProvider(
    C,
    { ...options, canvas },
    'globe',
  );
  const tiles = createNativeRasterImageryProvider(
    C,
    { ...options, canvas },
    'tileset',
  );
  assert.equal(globe.maximumLevel, 0);
  assert.equal(tiles.maximumLevel, 1);
  const response = tiles.requestImage(0, 0, 0);
  assert.equal(typeof response.then, 'function');
  assert.equal(await response, canvas);
  assert.equal(tiles.tileWidth, 2048);
  assert.equal(tiles.tileHeight, 1024);
  assert.equal(nativeRasterImageryDiagnostics(C).installed, true);
  const installed = C.ImageryPipelineStage._createMainImageryShader;
  installNativeRasterDatelineMapping(C);
  assert.equal(
    C.ImageryPipelineStage._createMainImageryShader,
    installed,
    'idempotent installation uses the actual Cesium namespace',
  );
});

test('marked global raster builds initialized fragment world UV and periodic mip gradients while ordinary imagery preserves native mapping', () => {
  const native = new C.SingleTileImageryProvider(options);
  const raster = createNativeRasterImageryProvider(C, options, 'tileset');
  const shader = builder();
  const flags = {
    alpha: true,
    brightness: true,
    contrast: true,
    hue: true,
    saturation: true,
    gamma: true,
    colorToAlpha: true,
  };
  const before = nativeRasterImageryDiagnostics(C).mappedInputs;
  C.ImageryPipelineStage._createMainImageryShader(
    shader,
    [input(native), input(raster)],
    flags,
  );
  const main = body(shader, 'blendBaseColorWithImagery');
  assert.match(
    main,
    /sampleAndBlend\(blendedBaseColor, u_imageryTextures\[0\], v_imagery_texCoord_0, u_imageryTextureCoordinateRectangle\[0\]/,
  );
  assert.match(
    main,
    /gevRasterSampleAndBlend\(blendedBaseColor, u_imageryTextures\[1\], gevGlobalRasterUv\(\), vec4\(0.0, 0.0, 1.0, 1.0\), vec4\(0.0, 0.0, 1.0, 1.0\)/,
  );
  assert.match(body(shader, 'gevGlobalRasterUv'), /atan\(n.y, n.x\)/);
  assert.ok(
    shader._vertexShaderParts.defineLines.includes(
      'COMPUTE_POSITION_WC_CUSTOM_SHADER',
    ),
  );
  assert.ok(
    shader._fragmentShaderParts.defineLines.includes(
      'COMPUTE_POSITION_WC_CUSTOM_SHADER',
    ),
  );
  const blending = body(shader, 'gevRasterSampleAndBlend');
  assert.match(blending, /textureGrad/);
  assert.match(blending, /gevDx.x -= floor\(gevDx.x \+ 0.5\)/);
  assert.match(blending, /gevDy.x -= floor\(gevDy.x \+ 0.5\)/);
  assert.match(blending, /effectiveAlpha = textureAlpha/);
  assert.match(blending, /textureBrightness/);
  assert.match(blending, /colorToAlpha/);
  assert.equal(nativeRasterImageryDiagnostics(C).mappedInputs, before + 1);
});

test('unmarked provider shader is unchanged, including its native texture-coordinate coverage', () => {
  const shader = builder();
  const provider = new C.SingleTileImageryProvider(options);
  C.ImageryPipelineStage._createMainImageryShader(
    shader,
    [input(provider)],
    {},
  );
  assert.equal(shader._functions.gevGlobalRasterUv, undefined);
  assert.match(
    body(shader, 'blendBaseColorWithImagery'),
    /v_imagery_texCoord_0/,
  );
  assert.equal(shader._vertexShaderParts.defineLines.length, 0);
});

test('regional rasters and incompatible engine contracts reject explicitly instead of silently leaving coverage holes', () => {
  assert.throws(
    () =>
      createNativeRasterImageryProvider(
        C,
        { ...options, rectangle: C.Rectangle.fromDegrees(-20, -10, 20, 10) },
        'tileset',
      ),
    /full-world/,
  );
  assert.throws(
    () =>
      installNativeRasterDatelineMapping({
        ...C,
        VERSION: '1.139.0',
        ImageryPipelineStage: {},
      }),
    /requires verified 1.138/,
  );
  assert.throws(
    () =>
      installNativeRasterDatelineMapping({ ...C, ImageryPipelineStage: {} }),
    /missing ImageryPipelineStage/,
  );
  const raster = createNativeRasterImageryProvider(C, options, 'tileset');
  assert.throws(
    () =>
      C.ImageryPipelineStage._createMainImageryShader(
        new C.ShaderBuilder(),
        [input(raster)],
        {},
      ),
    /world-position varying is absent/,
  );
});
