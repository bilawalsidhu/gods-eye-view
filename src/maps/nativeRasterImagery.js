// Cesium 1.138's model draper interpolates vertex longitude UVs through zero
// across the dateline. Only our full-world rasters opt into fragment mapping.
const RASTER = Symbol.for('gev.nativeGlobalRaster');
const NIGHT = Symbol.for('gev.nativeNightLighting');
const NIGHT_GLOBE = Symbol.for('gev.nativeNightGlobe');
export const NATIVE_NIGHT_BRIGHTNESS = -7319;
const PATCH = Symbol.for('gev.nativeGlobalRasterPipeline');
const SUPPORTED_VERSION = /^1\.138(?:\.0)?$/;
const UNIT_RECTANGLE = 'vec4(0.0, 0.0, 1.0, 1.0)';

// The source is static light-signal imagery. Only the sun vector changes;
// both surface pipelines evaluate the same night mask per fragment on GPU.
export const NATIVE_NIGHT_GLSL = `
vec4 gevNightLighting(vec4 signal, vec3 positionWC) {
  vec3 normalWC = normalize(positionWC * vec3(1.0, 1.0, 1.0067394967422764));
  float sunDot = dot(normalWC, czm_sunDirectionWC);
  float night = 1.0 - smoothstep(-0.15, 0.15, sunDot);
  float lamps = 1.0 - smoothstep(-0.30, 0.0, sunDot);
  float luma = dot(signal.rgb, vec3(0.2126, 0.7152, 0.0722));
  float mask = smoothstep(0.04, 0.30, max(luma, signal.a));
  float boost = min(3.0, luma * (1.9 + max(max(signal.r, signal.g), signal.b) * 4.2));
  float dark = night * 0.94 * (1.0 - mask * 0.7);
  float light = lamps * mask * 0.96 * (1.0 - dark);
  float alpha = dark + light;
  vec3 color = (vec3(39.0, 38.0, 51.0) / 255.0 * dark + vec3(1.0, 0.82, 0.36) * boost * light) / max(alpha, 0.00001);
  return vec4(clamp(color, 0.0, 1.0), alpha * 0.96);
}`;

/** Install on this viewer only; ordinary imagery keeps native color processing. */
export function installNativeNightGlobeLighting(C, viewer) {
  const stage = viewer.scene.globe?._surface?._tileProvider?._surfaceShaderSet;
  if (stage?.[NIGHT_GLOBE]) return;
  if (!SUPPORTED_VERSION.test(C.VERSION || '') || !stage?.getShaderProgram)
    unsupported(C, 'requires verified globe surface shader set');
  const original = stage.getShaderProgram;
  stage.getShaderProgram = function (options) {
    const source = this.baseFragmentShaderSource;
    if (
      !source.sources.some((text) => text.includes('vec4 gevNightLighting('))
    ) {
      const sampling =
        'vec4 value = texture(textureToSample, textureCoordinates);';
      const index = source.sources.findIndex((text) => text.includes(sampling));
      if (index < 0 || !source.sources[index].includes('in vec3 v_positionMC;'))
        unsupported(C, 'globe sampling or world-position contract changed');
      source.sources[index] = source.sources[index].replace(
        sampling,
        `${sampling}\n#ifdef APPLY_BRIGHTNESS\nif (textureBrightness == ${NATIVE_NIGHT_BRIGHTNESS}.0) { value = gevNightLighting(value, v_positionMC); textureBrightness = 1.0; }\n#endif`,
      );
      source.sources[index] = source.sources[index].replace(
        'vec4 sampleAndBlend(',
        `${NATIVE_NIGHT_GLSL}\nvec4 sampleAndBlend(`,
      );
    }
    return original.call(this, options);
  };
  Object.defineProperty(stage, NIGHT_GLOBE, { value: true });
}

/** Power-of-two global rasters enable Cesium's trilinear mipmap filtering. */
export function nativeRasterDimensions(sourceWidth, maximumWidth = 4096) {
  const width = Math.min(
    maximumWidth,
    2 ** Math.ceil(Math.log2(Math.max(2, sourceWidth))),
  );
  return { width, height: width / 2 };
}

/** Update the shared geographic texture without dropping imagery or draw commands. */
export function updateNativeRasterImagery(C, layer, canvas) {
  if (!layer?.imageryProvider?.[RASTER])
    throw new Error('Only owned native rasters may be refreshed in place');
  if (!SUPPORTED_VERSION.test(C.VERSION || '') || !layer._imageryCache)
    unsupported(C, 'requires verified native imagery texture cache');
  const textures = new Set();
  for (const imagery of Object.values(layer._imageryCache))
    if (imagery.texture) textures.add(imagery.texture);
  // Validate the entire update first. Pending requests still resolve to the
  // same canvas, so images not uploaded yet automatically receive new pixels.
  for (const texture of textures)
    if (
      texture.width !== canvas.width ||
      texture.height !== canvas.height ||
      typeof texture.copyFrom !== 'function'
    )
      unsupported(C, 'native raster texture dimensions or upload API changed');
  for (const texture of textures) {
    texture.copyFrom({ source: canvas });
    if (
      texture.sampler.minificationFilter ===
      C.TextureMinificationFilter.LINEAR_MIPMAP_LINEAR
    )
      texture.generateMipmap(C.MipmapHint.NICEST);
  }
  return textures.size;
}

function unsupported(C, detail) {
  throw new Error(
    `Native global raster dateline mapping unsupported (Cesium ${C.VERSION || 'unknown'}): ${detail}`,
  );
}

/** Readable diagnostics also prove the production external renderer uses this hook. */
export function nativeRasterImageryDiagnostics(C) {
  const state = C.ImageryPipelineStage?.[PATCH];
  return {
    version: C.VERSION || null,
    installed: Boolean(state),
    mappedInputs: state?.mappedInputs || 0,
    compiledPrimitives: state?.compiledPrimitives || 0,
  };
}

/**
 * Use the stage exported by the actual Cesium namespace, rather than importing
 * a second engine instance (production uses vite-plugin-cesium's global build).
 * This private compatibility hook is intentionally restricted to 1.138.
 */
export function installNativeRasterDatelineMapping(C) {
  const stage = C.ImageryPipelineStage;
  if (stage?.[PATCH]) return nativeRasterImageryDiagnostics(C);
  if (!SUPPORTED_VERSION.test(C.VERSION || ''))
    unsupported(C, 'requires verified 1.138 shader contracts');
  for (const method of [
    '_createMainImageryShader',
    '_createSampleAndBlendCallArguments',
    '_buildSampleAndBlendFunction',
  ])
    if (typeof stage?.[method] !== 'function')
      unsupported(C, `missing ImageryPipelineStage.${method}`);
  if (C.ShaderDestination?.FRAGMENT !== 1 || C.ShaderDestination?.BOTH !== 2)
    unsupported(C, 'unexpected ShaderDestination contract');
  const original = stage._createMainImageryShader;
  const state = { mappedInputs: 0, compiledPrimitives: 0 };
  stage._createMainImageryShader = function (builder, inputs, flags) {
    const tagged = inputs.some(
      (input) => input.imageryLayer?.imageryProvider?.[RASTER],
    );
    if (!tagged) return original.call(this, builder, inputs, flags);
    const hasNight = inputs.some(
      (input) => input.imageryLayer?.imageryProvider?.[NIGHT],
    );
    if (hasNight && !flags.brightness)
      unsupported(C, 'night layer requires its native brightness selector');
    if (hasNight) {
      builder.addFunction(
        'gevNightLighting',
        'vec4 gevNightLighting(vec4 signal, vec3 positionWC)',
        C.ShaderDestination.FRAGMENT,
      );
      builder.addFunctionLines(
        'gevNightLighting',
        NATIVE_NIGHT_GLSL.trim().split('\n').slice(1, -1),
      );
    }
    // GeometryPipelineStage declares this varying unconditionally but only
    // assigns it under these defines. Enable assignment in both shader stages.
    for (const parts of [
      builder._vertexShaderParts,
      builder._fragmentShaderParts,
    ])
      if (
        !parts?.varyingLines?.some((line) =>
          /\bvec3\s+v_positionWC\s*;/.test(line),
        )
      )
        unsupported(C, 'model world-position varying is absent');
    builder.addDefine(
      'COMPUTE_POSITION_WC_CUSTOM_SHADER',
      undefined,
      C.ShaderDestination.BOTH,
    );
    builder.addFunction(
      'gevGlobalRasterUv',
      'vec2 gevGlobalRasterUv()',
      C.ShaderDestination.FRAGMENT,
    );
    builder.addFunctionLines('gevGlobalRasterUv', [
      // The WGS84 ellipsoid normal gives geodetic latitude, not spherical latitude.
      'vec3 n = normalize(v_positionWC * vec3(1.0, 1.0, 1.0067394967422764));',
      'return vec2(atan(n.y, n.x) * czm_oneOverTwoPi + 0.5, asin(clamp(n.z, -1.0, 1.0)) * czm_oneOverPi + 0.5);',
    ]);
    // Reuse the native blending/color/alpha function, changing only sampling
    // for our marked rasters. Wrapped longitude derivatives must not select a
    // coarse mip at ±180 on power-of-two night canvases.
    let replacedTexture = false;
    const adapter = {
      addFunction: (id, signature, destination) =>
        builder.addFunction(
          'gevRasterSampleAndBlend',
          signature.replace('sampleAndBlend(', 'gevRasterSampleAndBlend('),
          destination,
        ),
      addFunctionLines: (id, lines) =>
        builder.addFunctionLines(
          'gevRasterSampleAndBlend',
          lines.flatMap((line) => {
            if (
              line !==
              'vec4 value = texture(textureToSample, effectiveTextureCoordinates);'
            )
              return [line];
            replacedTexture = true;
            return [
              'vec2 gevDx = dFdx(effectiveTextureCoordinates);',
              'vec2 gevDy = dFdy(effectiveTextureCoordinates);',
              'gevDx.x -= floor(gevDx.x + 0.5);',
              'gevDy.x -= floor(gevDy.x + 0.5);',
              'vec4 value = textureGrad(textureToSample, effectiveTextureCoordinates, gevDx, gevDy);',
              ...(hasNight && flags.brightness
                ? [
                    `if (textureBrightness == ${NATIVE_NIGHT_BRIGHTNESS}.0) { value = gevNightLighting(value, v_positionWC); textureBrightness = 1.0; }`,
                  ]
                : []),
            ];
          }),
        ),
    };
    stage._buildSampleAndBlendFunction(adapter, flags);
    if (!replacedTexture) unsupported(C, 'native sampling function changed');
    builder.addFunction(
      'blendBaseColorWithImagery',
      'vec4 blendBaseColorWithImagery(vec4 baseColorWithAlpha)',
      C.ShaderDestination.FRAGMENT,
    );
    builder.addFunctionLines('blendBaseColorWithImagery', [
      'vec4 blendedBaseColor = baseColorWithAlpha;',
    ]);
    for (let index = 0; index < inputs.length; index++) {
      const input = inputs[index];
      let args = stage._createSampleAndBlendCallArguments(
        flags,
        input.imageryTexCoordAttributeSetIndex,
        index,
      );
      let functionName = 'sampleAndBlend';
      if (input.imageryLayer?.imageryProvider?.[RASTER]) {
        const uv = `v_imagery_texCoord_${input.imageryTexCoordAttributeSetIndex}`;
        const rectangle = `u_imageryTextureCoordinateRectangle[${index}]`;
        const transform = `u_imageryTextureTranslationAndScale[${index}]`;
        if (
          ![uv, rectangle, transform].every((argument) =>
            args.includes(argument),
          )
        )
          unsupported(C, 'native blend arguments changed');
        args = args
          .replace(uv, 'gevGlobalRasterUv()')
          .replace(rectangle, UNIT_RECTANGLE)
          .replace(transform, UNIT_RECTANGLE);
        functionName = 'gevRasterSampleAndBlend';
        state.mappedInputs++;
      }
      builder.addFunctionLines('blendBaseColorWithImagery', [
        `blendedBaseColor = ${functionName}(${args});`,
      ]);
    }
    builder.addFunctionLines('blendBaseColorWithImagery', [
      'return blendedBaseColor;',
    ]);
    state.compiledPrimitives++;
  };
  Object.defineProperty(stage, PATCH, { value: state });
  return nativeRasterImageryDiagnostics(C);
}

/** Global EPSG:4326 raster; the tileset draper's exclusive max level needs 1. */
export function createNativeRasterImageryProvider(C, options, hostKind) {
  const rectangle = options.rectangle || C.Rectangle.MAX_VALUE;
  if (
    ['west', 'south', 'east', 'north'].some(
      (key) => Math.abs(rectangle[key] - C.Rectangle.MAX_VALUE[key]) > 1e-10,
    )
  )
    throw new Error(
      'Native dateline mapping requires a full-world Rectangle.MAX_VALUE raster',
    );
  if (hostKind === 'tileset') installNativeRasterDatelineMapping(C);
  const { canvas, nightLighting, ...providerOptions } = options;
  const provider = new C.SingleTileImageryProvider({
    ...providerOptions,
    rectangle,
    url: options.url || 'data:,',
  });
  Object.defineProperty(provider, RASTER, { value: true });
  if (nightLighting) Object.defineProperty(provider, NIGHT, { value: true });
  if (canvas) provider.requestImage = () => Promise.resolve(canvas);
  if (hostKind === 'tileset')
    Object.defineProperty(provider, 'maximumLevel', { get: () => 1 });
  return provider;
}
