// Frosted glass workspace: a translucent white sheet with a brighter border, and a soft halo
// that follows nearby hands. Gives a tabletop activity a readable surface instead of a wireframe
// cage, and shows the learner where their hands are against it.
import * as THREE from 'three';

export const MAX_HANDS=2;
// Real-world hand sizes, so the halo is divided by the root's scale rather than shrinking with it.
const HAND_RADIUS=.13,HAND_REACH=.28;

const vertexShader=`
varying vec2 vLocal;
void main(){
 vLocal=position.xy;
 gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
}`;

const fragmentShader=`
uniform vec2 uHalf;
uniform float uRadius;
uniform float uBorder;
uniform vec3 uHands[${MAX_HANDS}];
uniform float uHandRadius;
uniform float uHandReach;
uniform float uBaseAlpha;
uniform float uBorderAlpha;
varying vec2 vLocal;

float roundedBox(vec2 p,vec2 extent,float r){
 vec2 q=abs(p)-extent+r;
 return length(max(q,0.0))+min(max(q.x,q.y),0.0)-r;
}

void main(){
 float d=roundedBox(vLocal,uHalf,uRadius);
 if(d>0.0)discard;
 float edge=-d;
 // Brighter, less see-through toward the edge; a thin luminous line at the very rim.
 float borderRamp=1.0-smoothstep(0.0,uBorder,edge);
 float rimLine=1.0-smoothstep(0.0,0.0035,edge);
 float glow=0.0;
 for(int i=0;i<${MAX_HANDS};i++){
  vec3 h=uHands[i];
  if(h.y<-0.5)continue;
  float planar=length(vLocal-h.xz);
  float lift=clamp(1.0-abs(h.y)/uHandReach,0.0,1.0);
  float falloff=exp(-(planar*planar)/(2.0*uHandRadius*uHandRadius));
  glow=max(glow,falloff*lift);
 }
 float alpha=uBaseAlpha+borderRamp*uBorderAlpha+rimLine*0.4+glow*0.6;
 vec3 color=mix(vec3(0.80,0.84,0.88),vec3(1.0),max(borderRamp*0.7,glow));
 gl_FragColor=vec4(color,clamp(alpha,0.0,0.95));
}`;

export function createGlassWorkspace({width=1,depth=1,radius=.05,border=.06,baseAlpha=.22,borderAlpha=.38}={}){
 const hands=Array.from({length:MAX_HANDS},()=>new THREE.Vector3(0,-1,0));
 const material=new THREE.ShaderMaterial({
  vertexShader,fragmentShader,transparent:true,depthWrite:false,side:THREE.DoubleSide,toneMapped:false,
  uniforms:{
   uHalf:{value:new THREE.Vector2(width/2,depth/2)},
   uRadius:{value:radius},
   uBorder:{value:border},
   uHands:{value:hands},
   uHandRadius:{value:HAND_RADIUS},
   uHandReach:{value:HAND_REACH},
   uBaseAlpha:{value:baseAlpha},
   uBorderAlpha:{value:borderAlpha},
  },
 });
 const mesh=new THREE.Mesh(new THREE.PlaneGeometry(width,depth),material);
 mesh.rotation.x=-Math.PI/2;
 mesh.name='Glass workspace';
 // After the -90deg X rotation the plane's local y runs along the root's -z.
 const local=new THREE.Vector3();
 return {
  mesh,
  material,
  // Accepts world-space points; anything null or missing hides that halo. `root` is whatever the
  // mesh is positioned by, and its scale keeps the halo hand-sized as the activity resizes.
  setHands(points,root){
   const scale=root.scale.x||1;
   material.uniforms.uHandRadius.value=HAND_RADIUS/scale;
   material.uniforms.uHandReach.value=HAND_REACH/scale;
   for(let i=0;i<MAX_HANDS;i++){
    const p=points?.[i];
    if(!p){hands[i].set(0,-1,0);continue}
    root.worldToLocal(local.copy(p));
    hands[i].set(local.x,local.y,-local.z);
   }
  },
 };
}
