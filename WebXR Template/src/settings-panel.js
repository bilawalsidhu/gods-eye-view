import * as THREE from 'three';
import {SETTINGS,labelFor} from './settings.js';

// The in-scene settings board: a title and one row per setting, nothing else. A row is a button;
// selecting it toggles the setting and the board repaints from the store. Same canvas-texture
// technique as the diagnostics panel, same hit-plane pattern as the rooftop solar lab's board --
// invisible planes in `targets` carrying userData.action, lit to 20% while an aim ray rests on them.
const WIDTH=1024,ROW_H=96,ROW_STEP=130,ROW_TOP=140,BOARD_WIDTH=.56;
const VR_POSE={position:[1.05,1.22,-1.45],rotationY:-.62};
export function createSettingsPanel(scene,settings,brand,{targets=[],definitions=SETTINGS}={}){
 const names=Object.keys(definitions),height=160+ROW_STEP*names.length,boardHeight=BOARD_WIDTH*height/WIDTH;
 const canvas=document.createElement('canvas');canvas.width=WIDTH*2;canvas.height=height*2;
 const context=canvas.getContext('2d');context.scale(2,2);
 const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=4;
 const group=new THREE.Group();group.name='Settings board';scene.add(group);
 const board=new THREE.Mesh(new THREE.PlaneGeometry(BOARD_WIDTH,boardHeight),new THREE.MeshBasicMaterial({map:texture,toneMapped:false,side:THREE.DoubleSide}));group.add(board);
 // One hit plane per row, made once: rows never move, only their labels change.
 const planes=names.map((name,i)=>{
  const plane=new THREE.Mesh(new THREE.PlaneGeometry(BOARD_WIDTH*(WIDTH-88)/WIDTH,boardHeight*ROW_H/height),new THREE.MeshBasicMaterial({color:brand.colors.accent,transparent:true,opacity:0,depthWrite:false}));
  plane.position.set(0,(.5-(ROW_TOP+i*ROW_STEP+ROW_H/2)/height)*boardHeight,.004);
  plane.userData.ui=true;plane.userData.enabled=true;plane.userData.setting=name;plane.userData.action=()=>settings.toggle(name);
  group.add(plane);targets.push(plane);return plane;
 });
 function draw(){
  context.fillStyle=brand.colors.background;context.fillRect(0,0,WIDTH,height);
  context.fillStyle=brand.colors.accent;context.fillRect(0,0,WIDTH,10);
  context.font=`700 40px "${brand.fonts.display.family}"`;context.fillStyle=brand.colors.text;context.fillText('SETTINGS',44,90);
  names.forEach((name,i)=>{
   const y=ROW_TOP+i*ROW_STEP;
   context.beginPath();context.roundRect(44,y,WIDTH-88,ROW_H,12);context.fillStyle=brand.colors.surface;context.fill();context.lineWidth=2;context.strokeStyle=brand.colors.border;context.stroke();
   context.font=`500 34px "${brand.fonts.body.family}"`;context.fillStyle=brand.colors.text;context.fillText(labelFor(name,settings.get(name),definitions),76,y+ROW_H*.62,WIDTH-160);
  });
  texture.needsUpdate=true;
 }
 let hover=null;
 const restore=()=>{group.position.fromArray(VR_POSE.position);group.rotation.set(0,VR_POSE.rotationY,0)};
 restore();draw();
 const unsubscribe=settings.subscribe(()=>draw());
 return {
  group,draw,
  setHover(target){if(hover===target)return;if(hover)hover.material.opacity=0;hover=target?.userData.ui&&target.userData.enabled&&planes.includes(target)?target:null;if(hover)hover.material.opacity=.20},
  // In MR the room is hidden, so the board parks front-right of the viewer, clear of the
  // diagnostics panel that parks straight ahead.
  setMixedReality(active,camera){
   if(!active){restore();return}
   const forward=new THREE.Vector3(0,0,-1).applyQuaternion(camera.quaternion);forward.y=0;forward.normalize();
   const right=new THREE.Vector3().crossVectors(forward,new THREE.Vector3(0,1,0)).normalize();
   group.position.copy(camera.position).addScaledVector(forward,1.3).addScaledVector(right,.55).add(new THREE.Vector3(0,-.3,0));
   group.lookAt(camera.position);
  },
  dispose(){unsubscribe();for(const plane of planes){const at=targets.indexOf(plane);if(at>=0)targets.splice(at,1);plane.geometry.dispose();plane.material.dispose()}board.geometry.dispose();board.material.dispose();texture.dispose();scene.remove(group)},
 };
}
