import * as THREE from 'three';
import {OBB} from 'three/addons/math/OBB.js';
import {copyPose,mixPose} from './motion.js';

const CLEARANCE=.03;
const visible=o=>{for(let p=o;p;p=p.parent)if(!p.visible)return false;return true;};
export function panelBox(pose,size,padding=CLEARANCE){
  const scale=pose.scale??1,extra=size.handle?.08:0;
  const center=pose.position.clone().add(new THREE.Vector3(0,-extra*scale/2,0).applyQuaternion(pose.quaternion));
  return new OBB(center,new THREE.Vector3(size.width*scale/2+padding,(size.height+extra)*scale/2+padding,.008+padding),new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(pose.quaternion)));
}
function corners(box){const result=[];for(const x of [-1,1])for(const y of [-1,1])for(const z of [-1,1])result.push(new THREE.Vector3(x,y,z).multiply(box.halfSize).applyMatrix3(box.rotation).add(box.center));return result;}
function boxTriangles(box){const p=corners(box),result=[];for(const [a,b,c,d] of [[0,1,3,2],[4,6,7,5],[0,4,5,1],[2,3,7,6],[0,2,6,4],[1,5,7,3]])result.push(new THREE.Triangle(p[a],p[b],p[c]),new THREE.Triangle(p[a],p[c],p[d]));return result;}
function triangleHits(box,t){const rotation=box.rotation.clone().transpose();const local=p=>p.clone().sub(box.center).applyMatrix3(rotation);return new THREE.Box3(box.halfSize.clone().negate(),box.halfSize.clone()).intersectsTriangle(new THREE.Triangle(local(t.a),local(t.b),local(t.c)));}
function bounds(box){return new THREE.Box3().setFromPoints(corners(box));}
function triangleTree(items){
  const box=new THREE.Box3();for(const i of items)box.union(i.bounds);
  if(items.length<=12)return {bounds:box,items};
  const size=box.getSize(new THREE.Vector3()),axis=size.x>=size.y&&size.x>=size.z?'x':size.y>=size.z?'y':'z';
  items.sort((a,b)=>(a.bounds.min[axis]+a.bounds.max[axis])-(b.bounds.min[axis]+b.bounds.max[axis]));const half=Math.floor(items.length/2);
  return {bounds:box,left:triangleTree(items.slice(0,half)),right:triangleTree(items.slice(half))};
}
function queryTree(tree,predicate,out=[]){if(!tree||!predicate(tree.bounds))return out;if(tree.items)out.push(...tree.items.filter(i=>predicate(i.bounds)));else{queryTree(tree.left,predicate,out);queryTree(tree.right,predicate,out);}return out;}

// Clip an obstacle triangle against the convex view pyramid ending at the panel.
// Unlike a handful of rays, this also detects a small obstruction between the samples.
function clippedTriangle(triangle,planes){let poly=[triangle.a,triangle.b,triangle.c];for(const plane of planes){const next=[];for(let i=0;i<poly.length;i++){const a=poly[i],b=poly[(i+1)%poly.length],da=plane.distanceToPoint(a),db=plane.distanceToPoint(b);if(da>=0)next.push(a);if((da<0)!==(db<0))next.push(a.clone().lerp(b,da/(da-db)));}poly=next;if(!poly.length)return false;}return true;}
function viewPyramid(pose,size,head){
  const w=size.width*(pose.scale??1)/2,h=size.height*(pose.scale??1)/2;
  const pts=[[-w,-h],[w,-h],[w,h],[-w,h]].map(([x,y])=>new THREE.Vector3(x,y,0).applyQuaternion(pose.quaternion).add(pose.position));
  const center=head.clone().lerp(pose.position,.5),planes=[];
  for(let i=0;i<4;i++){const p=new THREE.Plane().setFromCoplanarPoints(head,pts[i],pts[(i+1)%4]);if(p.distanceToPoint(center)<0)p.negate();planes.push(p);}
  const direction=pose.position.clone().sub(head).normalize();
  planes.push(new THREE.Plane().setFromNormalAndCoplanarPoint(direction,head.clone().addScaledVector(direction,.03)));
  planes.push(new THREE.Plane().setFromNormalAndCoplanarPoint(direction.clone().negate(),pose.position.clone().addScaledVector(direction,-.015)));
  return planes;
}

export class PanelCollision {
  constructor(){this.entries=new Map();this.obstacles=[];}
  registerBox(id,object,{enabled=()=>visible(object)}={}){this.entries.set(id,{object,enabled,kind:'box'});return ()=>this.entries.delete(id);}
  registerTriangles(id,triangles){const items=triangles.map(triangle=>({triangle,bounds:new THREE.Box3().setFromPoints([triangle.a,triangle.b,triangle.c])}));this.entries.set(id,{kind:'triangles',triangles,tree:items.length?triangleTree(items):null});return ()=>this.entries.delete(id);}
  unregister(id){this.entries.delete(id);}
  refresh(panels=[]){
    const obstacles=[];
    for(const [id,e] of this.entries){if(e.enabled&&!e.enabled())continue;
      if(e.kind==='box'){e.object.updateWorldMatrix(true,false);if(!e.matrix?.equals(e.object.matrixWorld)){const g=e.object.geometry;if(!g.boundingBox)g.computeBoundingBox();const box=new OBB().fromBox3(g.boundingBox).applyMatrix4(e.object.matrixWorld);e.cached={id,box,bounds:bounds(box),triangles:boxTriangles(box)};e.matrix=e.object.matrixWorld.clone();}obstacles.push(e.cached);}
      else if(e.tree)obstacles.push({id,tree:e.tree,bounds:e.tree.bounds});
    }
    for(const p of panels)if(p.visible&&p.initialized&&p.variant!=='label'){const box=panelBox(p.pose,p.size,0);obstacles.push({id:p.id,box,bounds:bounds(box),triangles:boxTriangles(box)});}
    this.obstacles=obstacles;
  }
  intersects(box,exclude){const broad=bounds(box);return this.obstacles.some(o=>o.id!==exclude&&broad.intersectsBox(o.bounds)&&(o.box?box.intersectsOBB(o.box):queryTree(o.tree,b=>broad.intersectsBox(b)).some(i=>triangleHits(box,i.triangle))));}
  occluded(pose,size,head,exclude){const planes=viewPyramid(pose,size,head),broad=new THREE.Box3().setFromPoints([head,...corners(panelBox(pose,size,0))]);return this.obstacles.some(o=>o.id!==exclude&&broad.intersectsBox(o.bounds)&&(o.triangles||queryTree(o.tree,b=>broad.intersectsBox(b)).map(i=>i.triangle)).some(t=>clippedTriangle(t,planes)));}
  valid(pose,size,head,exclude,{sight=true,headClearance=.45}={}){
    const box=panelBox(pose,size);if(head&&box.clampPoint(head,new THREE.Vector3()).distanceTo(head)<headClearance)return false;
    return !this.intersects(box,exclude)&&(!sight||!head||!this.occluded(pose,size,head,exclude));
  }
  rayDistance(ray,max=Infinity,exclude){let distance=max;for(const o of this.obstacles){if(o.id===exclude)continue;if(!ray.intersectsBox(o.bounds))continue;for(const t of o.triangles||queryTree(o.tree,b=>ray.intersectsBox(b)).map(i=>i.triangle)){const hit=ray.intersectTriangle(t.a,t.b,t.c,false,new THREE.Vector3());if(hit)distance=Math.min(distance,hit.distanceTo(ray.origin));}}return distance;}
  sweep(from,to,size,head,exclude){
    // A midpoint box expanded by bounds on translation, rotation and scale encloses
    // the entire interpolation. Subdivide only occupied envelopes, never step over walls.
    if(!this.valid(from,size,head,exclude,{sight:false}))return {pose:copyPose(from),fraction:0};
    let accepted=0;
    const advance=(lo,hi,depth)=>{
      const a=mixPose(from,to,lo),b=mixPose(from,to,hi),mid=mixPose(a,b,.5),box=panelBox(mid,size);
      const radius=Math.hypot(size.width,size.height+(size.handle?.08:0))*.5;
      const expansion=a.position.distanceTo(b.position)/2+radius*Math.max(a.scale,b.scale)*a.quaternion.angleTo(b.quaternion)/2+radius*Math.abs(a.scale-b.scale)/2;
      box.halfSize.addScalar(expansion);
      const headHit=head&&box.clampPoint(head,new THREE.Vector3()).distanceTo(head)<.45;
      if(!headHit&&!this.intersects(box,exclude)){accepted=hi;return true;}
      if(depth>=14||expansion<.0005)return false;
      const middle=(lo+hi)/2;return advance(lo,middle,depth+1)&&advance(middle,hi,depth+1);
    };
    advance(0,1,0);return {pose:mixPose(from,to,accepted),fraction:accepted};
  }
  move(from,to,size,head,exclude){
    let result=this.sweep(from,to,size,head,exclude);
    if(result.fraction<1){for(const axis of ['x','z','y']){const target=copyPose(result.pose);target.position[axis]=to.position[axis];const slide=this.sweep(result.pose,target,size,head,exclude);result.pose=slide.pose;}}
    return result;
  }
}
