import * as THREE from 'three';
import {XRHandMeshModel} from 'three/addons/webxr/XRHandMeshModel.js';

// Self-hosted WebXR skeletons with the Meta Dark v6 treatment selected in
// materials/hands/manifest.json. MeshToonMaterial preserves skinning and stereo paths.
export function createHandMaterial(){
 const ramp=new THREE.DataTexture(new Uint8Array([190,225,255]),3,1,THREE.RedFormat);
 ramp.minFilter=ramp.magFilter=THREE.NearestFilter;ramp.needsUpdate=true;
 const material=new THREE.MeshToonMaterial({color:'#ffffff',gradientMap:ramp,transparent:true,opacity:.76,depthWrite:true,side:THREE.FrontSide,toneMapped:false});
 material.name='Meta Dark v6';
 material.defaultAttributeValues={handFade:[1]};
 material.onBeforeCompile=shader=>{
  shader.vertexShader='attribute float handFade; varying float vHandFade;\n'+shader.vertexShader;
  shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvHandFade = handFade;');
  shader.fragmentShader='varying float vHandFade;\n'+shader.fragmentShader;
  shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>',`
   float facing = abs(dot(normalize(normal), normalize(vViewPosition)));
   float softShade = smoothstep(0.0, 0.001, facing);
   outgoingLight = mix(vec3(0.020,0.023,0.027), vec3(0.045,0.050,0.057), softShade);
   diffuseColor.a = opacity * vHandFade;
   #include <opaque_fragment>
  `);
 };
 material.customProgramCacheKey=()=> 'meta-dark-v6-ed9b27af1f';
 return material;
}
// Second slot: the hand shown in place of a controller (controller-hand.js). Same look as the
// tracked hand for now; materials/hands/manifest.json `controller` names its source spec, and the
// generator's functionName option emits a paste-ready replacement for this function alone.
export function createControllerHandMaterial(){
 const ramp=new THREE.DataTexture(new Uint8Array([190,225,255]),3,1,THREE.RedFormat);
 ramp.minFilter=ramp.magFilter=THREE.NearestFilter;ramp.needsUpdate=true;
 const material=new THREE.MeshToonMaterial({color:'#ffffff',gradientMap:ramp,transparent:true,opacity:.76,depthWrite:true,side:THREE.FrontSide,toneMapped:false});
 material.name='Meta Dark v6 controller hand';
 material.defaultAttributeValues={handFade:[1]};
 material.onBeforeCompile=shader=>{
  shader.vertexShader='attribute float handFade; varying float vHandFade;\n'+shader.vertexShader;
  shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvHandFade = handFade;');
  shader.fragmentShader='varying float vHandFade;\n'+shader.fragmentShader;
  shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>',`
   float facing = abs(dot(normalize(normal), normalize(vViewPosition)));
   float softShade = smoothstep(0.0, 0.001, facing);
   outgoingLight = mix(vec3(0.020,0.023,0.027), vec3(0.045,0.050,0.057), softShade);
   diffuseColor.a = opacity * vHandFade;
   #include <opaque_fragment>
  `);
 };
 material.customProgramCacheKey=()=> 'controller-meta-dark-v6-ed9b27af1f';
 return material;
}
// Meta Dark v6's white edge is a skinned inverted hull, not a fresnel term in the body shader.
// It must share the body's skeleton or the outline will lag behind tracked joints and controller poses.
export function createMetaDarkV6OutlineMaterial(){
 const material=new THREE.ShaderMaterial({
  uniforms:{uWidth:{value:.0026}},
  vertexShader:`attribute float handFade; varying float vHandFade;
   uniform float uWidth;
   #include <common>
   #include <skinning_pars_vertex>
   void main(){
    #include <beginnormal_vertex>
    #include <begin_vertex>
    vHandFade=handFade;
    #include <skinbase_vertex>
    #include <skinnormal_vertex>
    #include <skinning_vertex>
    vec4 mvPosition=modelViewMatrix*vec4(transformed,1.0);
    mvPosition.xyz+=normalize(normalMatrix*objectNormal)*uWidth;
    gl_Position=projectionMatrix*mvPosition;
   }`,
  fragmentShader:`varying float vHandFade;
   void main(){if(vHandFade<.004)discard;gl_FragColor=vec4(vec3(1.0),vHandFade);}`,
 side:THREE.BackSide,transparent:true,depthTest:true,depthWrite:false,toneMapped:false,
 });
 material.name='Meta Dark v6 solid white hull outline';
 material.defaultAttributeValues={handFade:[1]};
 return material;
}
function attachMetaDarkV6Outline(mesh,material){
 if(!mesh.isSkinnedMesh||!mesh.parent)return;
 const hull=new THREE.SkinnedMesh(mesh.geometry,material);hull.name='Meta Dark v6 outline';hull.userData.handOutline=true;
 hull.bind(mesh.skeleton,mesh.bindMatrix);hull.bindMode=mesh.bindMode;hull.frustumCulled=false;hull.renderOrder=(mesh.renderOrder||0)+1;
 mesh.parent.add(hull);
}
export function styleHandModel(object,material=createHandMaterial(),outlineMaterial=createMetaDarkV6OutlineMaterial()){
 object.updateMatrixWorld(true);
 object.traverse(mesh=>{
  if(!mesh.isMesh||mesh.userData.handOutline)return;
  // Bake the fade in bind space so it follows the wrist as the skeleton moves.
  const wrist=object.getObjectByName('wrist'),middle=object.getObjectByName('middle-finger-metacarpal');
  if(wrist&&middle){
   const origin=mesh.worldToLocal(wrist.getWorldPosition(new THREE.Vector3()));
   const axis=mesh.worldToLocal(middle.getWorldPosition(new THREE.Vector3())).sub(origin).normalize();
   mesh.geometry=mesh.geometry.clone();
   const positions=mesh.geometry.attributes.position,fade=new Float32Array(positions.count),point=new THREE.Vector3();
   for(let i=0;i<positions.count;i++){
    const distance=point.fromBufferAttribute(positions,i).sub(origin).dot(axis);
    fade[i]=THREE.MathUtils.smoothstep(distance,0,.045);
   }
   mesh.geometry.setAttribute('handFade',new THREE.BufferAttribute(fade,1));
  }
  mesh.material=material;mesh.castShadow=false;mesh.receiveShadow=false;attachMetaDarkV6Outline(mesh,outlineMaterial);
 });
 return object;
}
// Loaded GLBs keyed by URL, shared with the controller-hand factory so each hand downloads once.
export const handAssetCache={};
export function createToonHandFactory(basePath,cache=handAssetCache){
 const material=createHandMaterial();
 return {createHandModel(hand){
  const model=new THREE.Group();model.name='Tracked hand visual';model.userData.trackedHandVisual=true;
  let generation=0,source=null,motion=null;
  const clear=()=>{generation++;source=null;motion=null;model.clear();model.visible=false;};
  hand.addEventListener('connected',event=>{
   clear();if(!event.data.hand)return;source=event.data;const current=generation;
   // Load into an isolated group: an old async load must never attach a ghost hand.
   const staging=new THREE.Group();
   motion=new XRHandMeshModel(staging,hand,basePath+'webxr-profiles/generic-hand/',source.handedness,null,object=>{
    if(current!==generation)return;
    styleHandModel(object,material);model.clear();model.add(object);
   },cache);
  });
  hand.addEventListener('disconnected',clear);
  model.updateMatrixWorld=function(force){
   this.visible=!!source&&!!trackedHandPose(hand)&&!!motion;
   if(this.visible)motion.updateMesh();
   THREE.Group.prototype.updateMatrixWorld.call(this,force);
  };
  model.visible=false;return model;
 }};
}
export function trackedHandPose(hand){
 const index=hand?.joints?.['index-finger-tip'],thumb=hand?.joints?.['thumb-tip'],wrist=hand?.joints?.wrist;
 if(!hand?.visible||!index?.visible||!thumb?.visible||!wrist?.visible)return null;
 const a=index.getWorldPosition(new THREE.Vector3()),b=thumb.getWorldPosition(new THREE.Vector3());
 return {position:a.clone().add(b).multiplyScalar(.5),quaternion:wrist.getWorldQuaternion(new THREE.Quaternion()),distance:a.distanceTo(b)};
}
export function pinchHeld(distance,previous){return Number.isFinite(distance)&&distance<(previous?.028:.018);}
