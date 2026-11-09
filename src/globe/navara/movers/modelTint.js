// Models use the scene's depth, but their lit display colour is resolved after
// the view's HDR effects. This keeps MSAA from spreading HDR tint into edges.
import { InstancedMesh } from 'three';
import { OVERLAY_DEPTH_FRAGMENT } from '../overlayDepth.js';
import { DETACHED_SONAR, SONAR_VERTEX } from '../sonar.js';

// three's pinned ACESFilmicToneMapping, with the view's public exposure.
const ACES = `
uniform float uGevModelExposure;
vec3 gevModelAces(vec3 color) {
  const mat3 inputMatrix = mat3(0.59719,0.076,0.0284, 0.35458,0.90834,0.13383, 0.04823,0.01566,0.83777);
  const mat3 outputMatrix = mat3(1.60475,-0.10208,-0.00327, -0.53108,1.10813,-0.07276, -0.07367,-0.00605,1.07602);
  color = inputMatrix * (color * uGevModelExposure / 0.6);
  color = (color * (color + 0.0245786) - 0.000090537) /
    (color * (0.983729 * color + 0.432951) + 0.238081);
  return clamp(outputMatrix * color, 0.0, 1.0);
}
`;

export function createModelTint(mesh, uniforms, overlayUniforms) {
  const material = mesh.material.clone();
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.toneMapped = false;
  const lit = material.isMeshBasicMaterial
    ? 'gl_FragColor.rgb'
    : 'gevModelAces(gl_FragColor.rgb)';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, DETACHED_SONAR, uniforms, overlayUniforms, {
      uGevDepthMode: { value: 1 },
    });
    shader.vertexShader = shader.vertexShader
      .replace(
        'void main() {',
        `attribute vec4 gevColor;\nvarying vec4 vGevColor;\nvarying float vGevDepthFree;\nvarying float vGevSonarFactor;\nuniform vec2 uGevResolution;\n${SONAR_VERTEX}\nvoid main() {`,
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvGevColor = gevColor;\nvGevDepthFree = 0.0;\nvGevSonarFactor = gevSonarFactor(projectionMatrix * modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0), uGevResolution);',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        'void main() {',
        `uniform float uGevBlend;\nuniform float uGevAmbient;\nvarying vec4 vGevColor;\n${ACES}\nvarying float vGevSonarFactor;\n${SONAR_VERTEX}\n${OVERLAY_DEPTH_FRAGMENT}\nvoid main() {`,
      )
      .replace(
        '#include <logdepthbuf_fragment>',
        '#include <logdepthbuf_fragment>\nif (gevOverlayHidden()) discard;',
      )
      .replace(
        '#include <map_fragment>',
        '#include <map_fragment>\ndiffuseColor.a *= vGevColor.a;',
      )
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * uGevAmbient;',
      )
      .replace(
        '#include <opaque_fragment>',
        `#include <opaque_fragment>\nvec3 gevLitSrgb = sRGBTransferOETF(vec4(${lit}, 1.0)).rgb;\nvec4 gevContact = gevSonarColor(vec4(mix(gevLitSrgb, vGevColor.rgb, uGevBlend), gl_FragColor.a), vGevSonarFactor);\ngl_FragColor = vec4(sRGBTransferEOTF(gevContact).rgb, gevContact.a);`,
      );
  };
  material.customProgramCacheKey = () => 'gev-model-lit-display-color';
  const tint = new InstancedMesh(
    mesh.geometry,
    material,
    mesh.instanceMatrix.count,
  );
  tint.userData.gevModelTint = true;
  tint.instanceMatrix = mesh.instanceMatrix;
  tint.frustumCulled = false;
  tint.renderOrder = mesh.renderOrder;
  return tint;
}
