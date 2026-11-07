import {
  Mesh,
  ShaderMaterial,
  InstancedBufferGeometry,
  InstancedBufferAttribute,
  Float32BufferAttribute,
  Vector2,
  DoubleSide,
} from 'three';
import { fromDegrees } from '../../geo/cartesian3.js';

const KEY = 'gevWindFlow';
const registered = new WeakSet();
const vertexShader = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 begin, end;
attribute vec3 progress;
uniform vec2 viewport;
varying vec4 flow;
void main() {
  vec3 world = mix(begin,end,position.x);
  vec4 a = projectionMatrix * viewMatrix * vec4(begin,1.0);
  vec4 b = projectionMatrix * viewMatrix * vec4(end,1.0);
  vec2 delta = (b.xy/max(1.0,b.w)-a.xy/max(1.0,a.w))*viewport;
  vec2 perp = vec2(-delta.y,delta.x)/max(0.000001,length(delta));
  gl_Position = mix(a,b,position.x);
  gl_Position.xy += perp * position.y * 2.4 * gl_Position.w/viewport;
  flow = vec4(mix(progress.x,progress.y,position.x),progress.z,position.y,
    dot(normalize(world),normalize(cameraPosition-world)));
  #include <logdepthbuf_vertex>
}`;
const fragmentShader = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float seconds,heightFade,ghost;
varying vec4 flow;
void main() {
  #include <logdepthbuf_fragment>
  float behind=fract(seconds*0.16+flow.y-flow.x);
  float tail=1.0-smoothstep(0.0,0.32,behind), tip=1.0-smoothstep(0.0,0.045,behind);
  float ends=smoothstep(0.0,0.055,flow.x)*(1.0-smoothstep(0.945,1.0,flow.x));
  float edge=1.0-smoothstep(0.52,1.0,abs(flow.z));
  float alpha=(ghost+0.64*tail+0.16*tip)*ends*edge*smoothstep(0.0,0.065,flow.w)*heightFade;
  if(alpha<0.001) discard;
  gl_FragColor=vec4(mix(vec3(0.50,0.79,0.90),vec3(0.91,0.99,1.0),tip),alpha);
}`;

export function createWindFlowMesh({ view, MeshDesc }, paths, heightM) {
  if (!registered.has(view)) {
    view.registerMesh(
      KEY,
      class extends MeshDesc {
        constructor(host, ctx, config) {
          super(host, ctx, config);
          this.flow = config[KEY];
        }
        getPassKey() {
          return 'transparent';
        }
        createMesh() {
          return this.flow;
        }
        onDestroy() {
          this.flow.geometry.dispose();
          this.flow.material.dispose();
          super.onDestroy();
        }
      },
    );
    registered.add(view);
  }
  const segments = paths.reduce((sum, p) => sum + p.coordinates.length - 1, 0);
  const begin = new Float32Array(segments * 3),
    end = new Float32Array(segments * 3),
    progress = new Float32Array(segments * 3);
  let i = 0;
  for (const path of paths) {
    let previous = null;
    const n = path.coordinates.length - 1;
    for (let j = 0; j <= n; j++) {
      const [lon, lat] = path.coordinates[j];
      const next = fromDegrees(lon, lat, heightM);
      if (previous) {
        begin.set([previous.x, previous.y, previous.z], i);
        end.set([next.x, next.y, next.z], i);
        progress.set([(j - 1) / n, j / n, path.phase], i);
        i += 3;
      }
      previous = next;
    }
  }
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute([0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0], 3),
  );
  geometry.setIndex([0, 1, 2, 2, 1, 3]);
  for (const [key, array] of Object.entries({ begin, end, progress }))
    geometry.setAttribute(key, new InstancedBufferAttribute(array, 3));
  geometry.instanceCount = segments;
  const uniforms = {
    seconds: { value: 0 },
    heightFade: { value: 0 },
    ghost: { value: 0.25 },
    viewport: { value: new Vector2(1, 1) },
  };
  const material = new ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    side: DoubleSide,
    depthWrite: false,
    toneMapped: false,
  });
  material.forceSinglePass = true;
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  const holder = view.addMesh({ [KEY]: mesh });
  return {
    update({ time, fade, still, width, height }) {
      mesh.visible = fade > 0;
      uniforms.seconds.value = time;
      uniforms.heightFade.value = fade;
      uniforms.ghost.value = still ? 0.34 : 0.25;
      uniforms.viewport.value.set(Math.max(1, width), Math.max(1, height));
    },
    destroy: () => holder.delete(),
    segments,
  };
}
