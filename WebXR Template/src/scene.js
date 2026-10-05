import {brand,brandLogo} from './brand.js';
import {createGlassWorkspace} from './workspace.js';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
const material=color=>new THREE.MeshStandardMaterial({color,roughness:.65,metalness:.05});
export function createStarterScene(scene,{onHaptics,onProbe}={}) {
 const world=new CANNON.World({gravity:new CANNON.Vec3(0,-9.82,0)});world.broadphase=new CANNON.SAPBroadphase(world);
 const grabbables=[],targets=[],blockers=[],roomMeshes=[];scene.background=new THREE.Color(brand.colors.sceneBackground);scene.fog=new THREE.Fog(brand.colors.sceneBackground,7,20);scene.add(new THREE.HemisphereLight('#f4fffd','#253631',2));
 const sun=new THREE.DirectionalLight('#fff6e7',2.5);sun.position.set(-4,7,3);sun.castShadow=true;scene.add(sun);
 const floor=new THREE.Mesh(new THREE.PlaneGeometry(20,20),material(brand.colors.sceneFloor));floor.rotation.x=-Math.PI/2;floor.receiveShadow=true;scene.add(floor);roomMeshes.push(floor);const floorBody=new CANNON.Body({mass:0,shape:new CANNON.Plane()});floorBody.quaternion.setFromEuler(-Math.PI/2,0,0);world.addBody(floorBody);
 const boundary=(position,size)=>{const mesh=new THREE.Mesh(new THREE.BoxGeometry(...size),material(brand.colors.sceneWall));mesh.position.set(...position);mesh.castShadow=mesh.receiveShadow=true;scene.add(mesh);roomMeshes.push(mesh);const body=new CANNON.Body({mass:0,shape:new CANNON.Box(new CANNON.Vec3(size[0]/2,size[1]/2,size[2]/2))});body.position.set(...position);world.addBody(body);blockers.push({min:{x:position[0]-size[0]/2,y:position[1]-size[1]/2,z:position[2]-size[2]/2},max:{x:position[0]+size[0]/2,y:position[1]+size[1]/2,z:position[2]+size[2]/2}})};
 boundary([0,1,-5],[10,2,.2]);boundary([-5,1,0],[.2,2,10]);boundary([5,1,0],[.2,2,10]);boundary([0,.4,-2],[.9,.8,.9]);
 const pedestal=new THREE.Mesh(new THREE.CylinderGeometry(.65,.75,.8,32),material(brand.colors.scenePedestal));pedestal.position.set(0,.4,-2);pedestal.castShadow=pedestal.receiveShadow=true;scene.add(pedestal);
 // A tabletop workspace on the pedestal, so the shared glass surface is exercised here rather than
 // only in the projects that use it. The root carries the pose; the sheet is its child, which is
 // what setHands() expects when it maps a world-space hand into the surface plane.
 const workspaceRoot=new THREE.Group();workspaceRoot.position.set(0,.805,-2);scene.add(workspaceRoot);
 const workspace=createGlassWorkspace({width:.9,depth:.9});workspaceRoot.add(workspace.mesh);
 const brandCanvas=document.createElement('canvas');brandCanvas.width=1024;brandCanvas.height=300;const c=brandCanvas.getContext('2d');c.fillStyle=brand.colors.background;c.fillRect(0,0,1024,300);c.fillStyle=brand.colors.accent;c.fillRect(0,288,1024,12);
 if(brandLogo?.naturalWidth){c.drawImage(brandLogo,48,38,650,650*brandLogo.naturalHeight/brandLogo.naturalWidth)}
 else{c.font=`700 54px "${brand.fonts.display.family}"`;c.fillStyle=brand.colors.text;c.fillText(brand.name,48,145,930)}
 c.font=`500 26px "${brand.fonts.body.family}"`;c.fillStyle=brand.colors.muted;c.fillText(brand.tagline,48,245,930);
 const texture=new THREE.CanvasTexture(brandCanvas);texture.colorSpace=THREE.SRGBColorSpace;const plaque=new THREE.Mesh(new THREE.PlaneGeometry(1.3,.381),new THREE.MeshBasicMaterial({map:texture,toneMapped:false}));plaque.position.set(0,2,-2.6);scene.add(plaque);
 // Three pads on the pedestal. Each one proves a different thing, so a tester can tell which part
 // of the input path is working: a plain select, a select that reaches hardware, and a scene reset.
 const pad=(x,color,action)=>{const mesh=new THREE.Mesh(new THREE.CylinderGeometry(.16,.16,.07,32),material(color));mesh.position.set(x,1.42,-2);mesh.rotation.x=Math.PI/2;mesh.castShadow=true;mesh.userData.action=action;targets.push(mesh);scene.add(mesh);return mesh};
 const reset=pad(0,'#e76850',()=>resetBlocks());
 // The only place in the repository that drives a haptic actuator. Absence is reported, not
 // silently ignored: a controller without haptics is a real and valid configuration.
 const haptics=pad(.42,'#e3b45e',input=>{const actuator=input?.source?.gamepad?.hapticActuators?.[0];if(actuator?.pulse){actuator.pulse(.85,140);onHaptics?.(true)}else onHaptics?.(false)});
 const probe=pad(-.42,'#74b9a4',()=>onProbe?.());
 for(const [mesh,text] of [[probe,'SELECT'],[reset,'RESET'],[haptics,'HAPTICS']]){
  const canvas=document.createElement('canvas');canvas.width=256;canvas.height=64;const ctx=canvas.getContext('2d');ctx.fillStyle=brand.colors.background;ctx.fillRect(0,0,256,64);ctx.fillStyle=brand.colors.text;ctx.font='bold 30px sans-serif';ctx.textAlign='center';ctx.fillText(text,128,43);const map=new THREE.CanvasTexture(canvas);map.colorSpace=THREE.SRGBColorSpace;const label=new THREE.Mesh(new THREE.PlaneGeometry(.32,.08),new THREE.MeshBasicMaterial({map,toneMapped:false}));label.position.set(mesh.position.x,1.67,-1.95);scene.add(label);
 }
 haptics.userData.station='haptics';probe.userData.station='probe';reset.userData.station='reset';
 const addBlock=(position,color)=>{const object=new THREE.Mesh(new THREE.BoxGeometry(.28,.28,.28),material(color));object.position.set(...position);object.castShadow=object.receiveShadow=true;scene.add(object);const body=new CANNON.Body({mass:.45,shape:new CANNON.Box(new CANNON.Vec3(.14,.14,.14)),linearDamping:.08,angularDamping:.15});body.position.copy(object.position);world.addBody(body);const item={object,body,start:object.position.clone(),startQuaternion:object.quaternion.clone(),held:null};object.userData.grabbable=item;object.userData.label='Demonstration block';grabbables.push(item)};
 // A visible tray keeps the blocks at grabbing height in both VR and passthrough.
 const tray=new THREE.Mesh(new THREE.BoxGeometry(2.1,.08,.65),material(brand.colors.scenePedestal));tray.position.set(0,.94,-1);tray.receiveShadow=true;scene.add(tray);
 const trayBody=new CANNON.Body({mass:0,shape:new CANNON.Box(new CANNON.Vec3(1.05,.04,.325))});trayBody.position.copy(tray.position);world.addBody(trayBody);
 blockers.push({min:{x:-1.05,y:.9,z:-1.325},max:{x:1.05,y:.98,z:-.675}});
 addBlock([-.75,1.2,-1],'#e3b45e');addBlock([0,1.2,-1],'#74b9a4');addBlock([.75,1.2,-1],'#91a8e6');
 function resetBlocks(){for(const item of grabbables){// A hand is asked to let go rather than having the block taken out of it: the desktop carry
 // holds its object on a physics constraint, which has to come off with it.
 if(item.held){const holder=item.held;holder.release?.(false);holder.held=null;holder.tracker?.clear()}item.held=null;item.body.type=CANNON.Body.DYNAMIC;item.body.position.copy(item.start);item.body.quaternion.copy(item.startQuaternion);item.body.velocity.setZero();item.body.angularVelocity.setZero();item.body.updateMassProperties();item.body.aabbNeedsUpdate=true;item.body.wakeUp();item.object.position.copy(item.start);item.object.quaternion.copy(item.startQuaternion)}}
 return {world,grabbables,targets,blockers,resetBlocks,plaque,workspace,workspaceRoot,sun,setMixedReality(active){roomMeshes.forEach(mesh=>mesh.visible=!active)}};
}
