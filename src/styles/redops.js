import { msg } from '../i18n/index.js';

/**
 * Red Ops Style — Red-lit night-operations monochrome
 * Submarine/command-bunker red lighting: preserves low-light vision while
 * keeping the tactical HUD readable.
 */
export const redOpsShader = {
  name: 'redops',
  uniforms: {
    tintStrength: { default: 0.85, min: 0, max: 1, label: msg('Tint') },
    contrastAmt: { default: 1.15, min: 0, max: 2, label: msg('Contrast') },
    vignetteAmt: { default: 0.55, min: 0, max: 1, label: msg('Vignette') },
  },
  fragmentShader: /* glsl */ `
    uniform sampler2D colorTexture;
    uniform vec2 colorTextureDimensions;
    uniform float intensity;
    uniform float tintStrength;
    uniform float contrastAmt;
    uniform float vignetteAmt;
    in vec2 v_textureCoordinates;

    void main() {
      vec2 uv = v_textureCoordinates;
      vec4 color = texture(colorTexture, uv);

      float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));
      float contrast = 1.0 + contrastAmt * intensity;
      float shaded = clamp((luma - 0.5) * contrast + 0.5, 0.0, 1.0);

      // Monochrome red — the classic bunker/submarine red-light treatment
      // that keeps night vision intact.
      vec3 redMono = vec3(shaded, shaded * 0.12, shaded * 0.05);
      vec3 tinted = mix(color.rgb, redMono, tintStrength * intensity);

      vec2 vigUV = uv * (1.0 - uv);
      float vig = vigUV.x * vigUV.y * 16.0;
      vig = pow(vig, 0.3 + 0.5 * vignetteAmt * intensity);

      vec3 result = tinted * mix(1.0, vig, intensity);
      out_FragColor = vec4(mix(color.rgb, result, intensity), color.a);
    }
  `,
};
