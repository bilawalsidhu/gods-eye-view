import { msg } from '../i18n/marker.js';

/**
 * Blueprint Style — Architectural CAD / Technical schematic styling
 * High-pass edge contours + blueprint drafting grid + technical cyan-blue monochrome grading.
 *
 * Transforms photorealistic 3D cities, terrain, and space assets into a live architectural blueprint.
 */
export const blueprintShader = {
  name: 'blueprint',
  uniforms: {
    lineIntensity: {
      default: 1.2,
      min: 0,
      max: 2,
      label: msg('Line Intensity'),
    },
    gridDensity: { default: 0.5, min: 0, max: 1, label: msg('Grid Density') },
  },
  fragmentShader: /* glsl */ `
    uniform sampler2D colorTexture;
    uniform vec2 colorTextureDimensions;
    uniform float intensity;
    uniform float lineIntensity;
    uniform float gridDensity;
    in vec2 v_textureCoordinates;

    void main() {
      vec2 uv = v_textureCoordinates;
      vec2 texel = 1.0 / colorTextureDimensions;
      vec4 color = texture(colorTexture, uv);

      // ── 1. Luminance & Monochrome Blueprint Tone ──────────
      float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));

      // Blueprint palette: Deep drafting blue base (#0a1c38)
      vec3 blueprintBase = vec3(0.039, 0.110, 0.220);
      vec3 blueprintMid  = vec3(0.082, 0.282, 0.522);
      vec3 blueprintCyan = vec3(0.220, 0.820, 1.000);
      vec3 blueprintLine = vec3(0.850, 0.950, 1.000);

      // Shaded background gives subtle land & building relief
      vec3 bg = mix(blueprintBase, blueprintMid, luma * 0.7);

      // ── 2. Sobel Edge Detection for Architectural Outlines ─
      vec4 cTL = texture(colorTexture, uv + vec2(-texel.x,  texel.y));
      vec4 cTC = texture(colorTexture, uv + vec2( 0.0,      texel.y));
      vec4 cTR = texture(colorTexture, uv + vec2( texel.x,  texel.y));
      vec4 cML = texture(colorTexture, uv + vec2(-texel.x,  0.0));
      vec4 cMR = texture(colorTexture, uv + vec2( texel.x,  0.0));
      vec4 cBL = texture(colorTexture, uv + vec2(-texel.x, -texel.y));
      vec4 cBC = texture(colorTexture, uv + vec2( 0.0,     -texel.y));
      vec4 cBR = texture(colorTexture, uv + vec2( texel.x, -texel.y));

      float lTL = dot(cTL.rgb, vec3(0.299, 0.587, 0.114));
      float lTC = dot(cTC.rgb, vec3(0.299, 0.587, 0.114));
      float lTR = dot(cTR.rgb, vec3(0.299, 0.587, 0.114));
      float lML = dot(cML.rgb, vec3(0.299, 0.587, 0.114));
      float lMR = dot(cMR.rgb, vec3(0.299, 0.587, 0.114));
      float lBL = dot(cBL.rgb, vec3(0.299, 0.587, 0.114));
      float lBC = dot(cBC.rgb, vec3(0.299, 0.587, 0.114));
      float lBR = dot(cBR.rgb, vec3(0.299, 0.587, 0.114));

      // Sobel horizontal & vertical gradients
      float gx = (lTR + 2.0 * lMR + lBR) - (lTL + 2.0 * lML + lBL);
      float gy = (lBL + 2.0 * lBC + lBR) - (lTL + 2.0 * lTC + lTR);
      float edge = sqrt(gx * gx + gy * gy);

      // Boost edge sharpness
      float edgeFactor = smoothstep(0.08, 0.35, edge) * lineIntensity;
      vec3 lines = mix(vec3(0.0), blueprintCyan, clamp(edgeFactor, 0.0, 1.0));
      if (edgeFactor > 0.8) {
        lines = mix(lines, blueprintLine, (edgeFactor - 0.8) * 1.5);
      }

      // ── 3. Technical Drafting Grid Overlay ────────────────
      vec2 screenCoord = uv * colorTextureDimensions;
      vec2 gridMod = mod(screenCoord, 48.0);
      float isGridLine = max(step(gridMod.x, 1.0), step(gridMod.y, 1.0));
      float gridAlpha = isGridLine * 0.15 * gridDensity;

      // ── 4. Composition ───────────────────────────────────
      vec3 styled = bg + lines + vec3(0.05, 0.25, 0.45) * gridAlpha;

      // Vignette to frame the blueprint
      vec2 vigUV = uv * (1.0 - uv);
      float vig = vigUV.x * vigUV.y * 16.0;
      vig = pow(vig, 0.25);
      styled *= mix(0.75, 1.0, vig);

      out_FragColor = vec4(mix(color.rgb, styled, intensity), color.a);
    }
  `,
};
