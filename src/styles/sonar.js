/**
 * Sonar Style — Tactical Naval / Hydrographic Acoustic Display
 * Rotating radial sweep beam + phosphor persistence trail +
 * concentric range rings + high-contrast acoustic echo return
 */
export const sonarShader = {
  name: 'sonar',
  uniforms: {
    sweepSpeed: { default: 0.8, min: 0.1, max: 3.0, label: 'Sweep speed' },
    ringDensity: { default: 4.0, min: 1.0, max: 10.0, label: 'Range rings' },
    persistence: { default: 0.7, min: 0.1, max: 1.0, label: 'Persistence' },
    gain: { default: 1.4, min: 0.5, max: 2.5, label: 'Acoustic gain' },
  },
  fragmentShader: /* glsl */ `
    uniform sampler2D colorTexture;
    uniform vec2 colorTextureDimensions;
    uniform float intensity;
    uniform float time;
    uniform float sweepSpeed;
    uniform float ringDensity;
    uniform float persistence;
    uniform float gain;
    in vec2 v_textureCoordinates;

    #define PI 3.14159265359
    #define TWO_PI 6.28318530718

    void main() {
      vec2 uv = v_textureCoordinates;
      vec4 color = texture(colorTexture, uv);

      // Centered coordinates with aspect ratio correction
      vec2 centered = uv * 2.0 - 1.0;
      float aspect = colorTextureDimensions.x / max(1.0, colorTextureDimensions.y);
      centered.x *= aspect;

      float dist = length(centered);
      float angle = atan(centered.y, centered.x);
      if (angle < 0.0) angle += TWO_PI;

      // Rotating sweep angle (clockwise)
      float sweepAngle = mod(time * sweepSpeed, TWO_PI);
      float sweepDiff = mod(sweepAngle - angle, TWO_PI);

      // Sharp leading sweep line with smooth falloff
      float sweepLine = smoothstep(0.045, 0.0, sweepDiff);

      // Exponential phosphor persistence trail behind the sweep
      float decayRate = 3.5 / max(0.08, persistence);
      float trail = exp(-sweepDiff * decayRate);

      // Concentric circular range rings
      float ringPattern = abs(sin(dist * ringDensity * PI));
      float rings = smoothstep(0.96, 0.995, ringPattern) * 0.22;
      rings *= smoothstep(1.5, 0.2, dist);

      // Subtle crosshair axes
      float crosshairs = (smoothstep(0.003 * aspect, 0.0, abs(centered.x)) +
                          smoothstep(0.003, 0.0, abs(centered.y))) * 0.12;
      crosshairs *= smoothstep(1.2, 0.1, dist);

      // Acoustic echo response: extract scene luminance and boost contrast
      float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));
      float pingEcho = pow(clamp(luma * gain, 0.0, 1.0), 1.6);

      // Palette: deep oceanic navy baseline -> bright phosphor cyan
      vec3 oceanDark = vec3(0.012, 0.042, 0.11);
      vec3 phosphorCyan = vec3(0.0, 0.96, 0.78);
      vec3 pingBright = vec3(0.65, 1.0, 0.92);

      // Illuminated echo: contacts light up as the sweep passes, decaying with the trail
      float echoIllumination = pingEcho * (trail * 0.88 + 0.12);
      vec3 echoColor = mix(oceanDark, phosphorCyan, echoIllumination);
      echoColor += pingBright * pingEcho * sweepLine * 0.75;

      // Add sweep beam, rings, and crosshairs
      vec3 result = echoColor;
      result += phosphorCyan * sweepLine * 0.45;
      result += phosphorCyan * (rings + crosshairs) * (trail * 0.45 + 0.55);

      // Circular viewport vignette
      float vignette = smoothstep(1.45, 0.4, dist);
      result *= vignette;

      out_FragColor = vec4(mix(color.rgb, result, intensity), color.a);
    }
  `,
};
