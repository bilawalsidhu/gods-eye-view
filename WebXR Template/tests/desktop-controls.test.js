import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

// The module reaches for the browser globals a canvas application has. Stub them before it is
// imported so the whole desktop surface -- listeners, crosshair and pointer lock included -- can
// be driven in bare node. The stub is deliberately thin: only what the module actually touches.
globalThis.innerWidth=1600;globalThis.innerHeight=1000;
const windowHandlers=new Map();
globalThis.addEventListener=(type,fn)=>{if(!windowHandlers.has(type))windowHandlers.set(type,[]);windowHandlers.get(type).push(fn)};
globalThis.removeEventListener=(type,fn)=>{const list=windowHandlers.get(type)||[],index=list.indexOf(fn);if(index>=0)list.splice(index,1)};
const emitWindow=(type,event={})=>{for(const fn of [...(windowHandlers.get(type)||[])])fn(event)};

function fakeElement(tag='div'){
 const handlers=new Map();
 const node={
  tagName:tag,dataset:{},style:{},hidden:false,className:'',type:'',innerHTML:'',textContent:'',children:[],removed:false,
  setAttribute(){},getAttribute(){return null},
  append(...kids){node.children.push(...kids)},
  remove(){node.removed=true},
  querySelector(){return fakeElement('span')},
  addEventListener(type,fn){if(!handlers.has(type))handlers.set(type,[]);handlers.get(type).push(fn)},
  removeEventListener(type,fn){const list=handlers.get(type)||[],index=list.indexOf(fn);if(index>=0)list.splice(index,1)},
  emit(type,event={}){for(const fn of [...(handlers.get(type)||[])])fn(event)},
  listeners:type=>(handlers.get(type)||[]).length,
 };
 return node;
}
const documentHandlers=new Map();
let openDialog=false;
globalThis.document={
 body:fakeElement('body'),
 createElement:fakeElement,
 querySelector:selector=>selector==='dialog[open]'&&openDialog?{}:null,
 addEventListener(type,fn){if(!documentHandlers.has(type))documentHandlers.set(type,[]);documentHandlers.get(type).push(fn)},
 removeEventListener(type,fn){const list=documentHandlers.get(type)||[],index=list.indexOf(fn);if(index>=0)list.splice(index,1)},
 pointerLockElement:null,
 exitPointerLock(){document.pointerLockElement=null;emitDocument('pointerlockchange')},
};
const emitDocument=(type,event={})=>{for(const fn of [...(documentHandlers.get(type)||[])])fn(event)};

const {createDesktopControls}=await import('../src/desktop-controls.js');

// `lock` decides what the browser does with a capture request: 'grant' is the desktop case,
// 'refuse' is the cross-origin embed that has no allow="pointer-lock".
function fakeCanvas({lock='grant'}={}){
 const canvas=fakeElement('canvas');
 canvas.setPointerCapture=()=>{};
 canvas.lock=lock;
 canvas.requestPointerLock=()=>{
  if(canvas.lock==='refuse')return Promise.reject(new Error('refused'));
  document.pointerLockElement=canvas;emitDocument('pointerlockchange');
  return Promise.resolve();
 };
 return canvas;
}

// A pad at the centre of the view 2 m ahead, and a grabbable crate a little to its left.
function fixture({action=()=>{},blockers=[],profile='tabletop',carry=null,canGrab=()=>true,lock='grant'}={}){
 const canvas=fakeCanvas({lock}),rig=new THREE.Group(),camera=new THREE.PerspectiveCamera(58,innerWidth/innerHeight,.025,100);
 rig.add(camera);camera.position.set(0,1.6,0);
 const pad=new THREE.Mesh(new THREE.BoxGeometry(.4,.4,.1),new THREE.MeshBasicMaterial());
 pad.position.set(0,1.6,-2);pad.userData.action=action;pad.userData.label='Reset pad';rig.add(pad);
 const item={kind:'crate',body:{position:{x:0,y:1.6,z:-1.2},quaternion:{x:0,y:0,z:0,w:1},shapes:[{halfExtents:{x:.1,y:.1,z:.1}}],shapeOffsets:[{x:0,y:0,z:0}]}};
 const crate=new THREE.Mesh(new THREE.BoxGeometry(.2,.2,.2),new THREE.MeshBasicMaterial());
 crate.position.set(0,1.6,-1.2);crate.userData.grabbable=item;crate.userData.label='Crate';crate.visible=false;item.object=crate;rig.add(crate);
 rig.updateMatrixWorld(true);
 const events=[];
 const controls=createDesktopControls({canvas,camera,rig,profile,carry,canGrab,
  targets:()=>[pad],grabbables:()=>[item],blockers:()=>blockers,
  onEvent:(name,detail)=>events.push({name,detail})});
 return {canvas,camera,rig,pad,crate,item,controls,events};
}
const drag=(canvas,from,to)=>{canvas.emit('pointerdown',{clientX:from[0],clientY:from[1],pointerId:1});canvas.emit('pointermove',{clientX:to[0],clientY:to[1]});canvas.emit('pointerup',{clientX:to[0],clientY:to[1]})};
const click=(canvas,at)=>{canvas.emit('pointerdown',{clientX:at[0],clientY:at[1],pointerId:1});canvas.emit('pointerup',{clientX:at[0],clientY:at[1]})};

/* -- tabletop: today's behaviour, unchanged ------------------------------- */

test('a press that does not move is a click; one that moves is a look',()=>{
 let fired=0;const {canvas,controls,events}=fixture({action:()=>fired++});
 click(canvas,[800,500]);
 assert.equal(fired,1,'the pad under the centre of the view is selected');
 assert.equal(controls.yaw,0,'a click does not turn the camera');
 const before=controls.yaw;
 drag(canvas,[800,500],[900,500]);
 assert.ok(controls.yaw<before,'dragging right turns to the right, which is negative yaw');
 assert.equal(fired,1,'and does not also fire the target it started on');
 assert.deepEqual(events.map(e=>e.name),['use','look']);
});

test('a drag under the threshold is still a click, so a shaky hand can press a button',()=>{
 let fired=0;const {canvas,controls}=fixture({action:()=>fired++});
 canvas.emit('pointerdown',{clientX:800,clientY:500,pointerId:1});
 canvas.emit('pointermove',{clientX:802,clientY:501});
 canvas.emit('pointerup',{clientX:802,clientY:501});
 assert.equal(fired,1);
 assert.equal(controls.yaw,0);
});

test('a click on empty space selects nothing and reports nothing',()=>{
 let fired=0;const {canvas,events}=fixture({action:()=>fired++});
 click(canvas,[20,20]);
 assert.equal(fired,0);
 assert.deepEqual(events,[]);
});

test('onSelect takes over dispatch for applications whose actions are descriptors',()=>{
 const dispatched=[];
 const canvas=fakeCanvas(),rig=new THREE.Group(),camera=new THREE.PerspectiveCamera(58,1.6,.025,100);
 rig.add(camera);camera.position.set(0,1.6,0);
 const pad=new THREE.Mesh(new THREE.BoxGeometry(.4,.4,.1),new THREE.MeshBasicMaterial());
 pad.position.set(0,1.6,-2);pad.userData.action={type:'terminal',id:'B1+'};rig.add(pad);rig.updateMatrixWorld(true);
 createDesktopControls({canvas,camera,rig,targets:()=>[pad],onSelect:({action})=>{dispatched.push(action)}});
 click(canvas,[800,500]);
 assert.deepEqual(dispatched,[{type:'terminal',id:'B1+'}]);
});

test('pitch is clamped so the view never rolls over the top',()=>{
 const {canvas,controls}=fixture();
 drag(canvas,[800,500],[800,-40000]);
 assert.ok(controls.pitch<=1.2+1e-9&&controls.pitch>0,`clamped up: ${controls.pitch}`);
 drag(canvas,[800,500],[800,40000]);
 assert.ok(controls.pitch>=-1.2-1e-9&&controls.pitch<0,`clamped down: ${controls.pitch}`);
});

test('a tabletop scene captures nothing and shows no crosshair',()=>{
 const {controls}=fixture();
 assert.equal(controls.captured,false);
 assert.equal(controls.overlay.root.hidden,true);
 assert.equal(controls.reticle.root.hidden,true);
});

/* -- walking -------------------------------------------------------------- */

test('WASD walks where the camera looks and stops at the valid-floor rule',()=>{
 const {controls,rig,events}=fixture();
 controls.keys.add('KeyW');
 controls.update(.5);
 assert.ok(rig.position.z<-.9&&rig.position.z>-1.1,`a second of walking at 2 m/s covers a metre: ${rig.position.z}`);
 assert.ok(Math.abs(rig.position.x)<1e-9,'and does not drift sideways');
 assert.ok(events.some(e=>e.name==='move'));
 controls.keys.delete('KeyW');
 const held=rig.position.clone();
 assert.equal(controls.update(.5),false,'no keys is no movement');
 assert.ok(rig.position.equals(held));
});

test('walking into a wall slides along it instead of sticking to it',()=>{
 // A wall across -z. Pushing diagonally into it must still carry the x component through, which
 // a single combined valid-floor test would reject outright.
 const wall={min:{x:-5,y:0,z:-2.2},max:{x:5,y:2,z:-2}};
 const {controls,rig}=fixture({blockers:[wall]});
 rig.position.set(0,0,-1.5);
 controls.keys.add('KeyW');controls.keys.add('KeyD');
 controls.update(.5);
 assert.ok(rig.position.x>.3,`slid along the wall: ${rig.position.x}`);
 assert.ok(rig.position.z>-1.6&&rig.position.z<=-1.5+1e-9,`and did not pass into it: ${rig.position.z}`);
});

/* -- locks ---------------------------------------------------------------- */

test('a locked mode freezes movement and look, and lifting it hands them back',()=>{
 const {canvas,controls,rig}=fixture();
 controls.modes.register('multimeter',{key:'KeyM'});
 controls.keys.add('KeyW');
 controls.modes.set('multimeter');
 assert.equal(controls.update(.5),false,'standing still in an instrument mode');
 assert.ok(rig.position.equals(new THREE.Vector3(0,0,0)));
 const facing=controls.yaw;
 drag(canvas,[800,500],[900,500]);
 assert.equal(controls.yaw,facing,'and looking is frozen with it');
 controls.modes.clear();
 assert.equal(controls.update(.5),true);
});

test('an application freeze uses the same lock as a mode',()=>{
 const {controls}=fixture();
 controls.keys.add('KeyW');
 controls.suppress('menu');
 assert.equal(controls.update(.5),false);
 controls.suppress('menu',false);
 assert.equal(controls.update(.5),true);
});

test('keys are ignored while a dialog is open, and dropped when the window loses focus',()=>{
 const {controls,rig}=fixture();
 openDialog=true;
 emitWindow('keydown',{code:'KeyW'});
 assert.equal(controls.keys.has('KeyW'),false,'typing into a dialog does not walk the scene');
 openDialog=false;
 emitWindow('keydown',{code:'KeyW'});
 assert.equal(controls.keys.has('KeyW'),true);
 emitWindow('blur');
 assert.equal(controls.keys.size,0,'alt-tabbing away does not leave you walking forever');
 assert.equal(controls.update(.5),false);
 assert.ok(rig.position.equals(new THREE.Vector3(0,0,0)));
});

test('a mode key toggles its mode from anywhere',()=>{
 const {controls}=fixture();
 controls.modes.register('multimeter',{key:'KeyM'});
 emitWindow('keydown',{code:'KeyM'});
 assert.equal(controls.modes.active,'multimeter');
 emitWindow('keydown',{code:'KeyM'});
 assert.equal(controls.modes.active,null);
});

/* -- roomScale: capture --------------------------------------------------- */

test('a roomScale scene asks for the mouse and shows the crosshair',()=>{
 const {canvas,controls}=fixture({profile:'roomScale'});
 assert.equal(controls.overlay.root.hidden,false,'the click-to-play panel is up until a gesture arrives');
 assert.equal(controls.reticle.root.hidden,false);
 // Clicking the scene is the gesture, not clicking the panel: the panel takes no pointer events
 // so the application's own buttons stay reachable behind it.
 click(canvas,[800,500]);
 assert.equal(controls.captured,true);
 assert.equal(controls.overlay.root.hidden,true,'and it steps aside once the mouse is captured');
});

test('captured, raw mouse movement turns the camera with no drag gesture',()=>{
 const {canvas,controls}=fixture({profile:'roomScale'});
 controls.requestCapture();
 assert.equal(controls.captured,true);
 canvas.emit('pointermove',{movementX:100,movementY:0});
 assert.ok(controls.yaw<0,'moving the mouse right turns right without a button held');
 const turned=controls.yaw;
 canvas.emit('pointermove',{movementX:-100,movementY:0});
 assert.ok(controls.yaw>turned);
});

test('losing capture tells the application, and brings the overlay back',()=>{
 const {controls,events}=fixture({profile:'roomScale'});
 controls.requestCapture();
 events.length=0;
 document.exitPointerLock();                       // what Esc does, since Esc never reaches keydown
 assert.equal(controls.captured,false);
 assert.deepEqual(events.map(e=>e.name),['capture']);
 assert.equal(events[0].detail.captured,false);
 assert.equal(controls.overlay.root.hidden,false);
});

test('a refused lock steps aside so drag-to-look carries the scene',()=>{
 // The cross-origin embed case. Nothing may depend on capture, and the learner must not be left
 // staring at a click-to-play panel that will never do anything.
 const {canvas,controls}=fixture({profile:'roomScale',lock:'refuse'});
 controls.requestCapture();
 return Promise.resolve().then(()=>{
  assert.equal(controls.captured,false);
  assert.equal(controls.lockRefused,true);
  assert.equal(controls.overlay.root.hidden,true,'the panel stops asking for a gesture it cannot use');
  const before=controls.yaw;
  drag(canvas,[800,500],[900,500]);
  assert.ok(controls.yaw<before,'and looking still works by dragging');
 });
});

test('a mode that needs the cursor gives the mouse back, and taking it away asks again',()=>{
 const {controls}=fixture({profile:'roomScale'});
 controls.modes.register('multimeter',{key:'KeyM',pointer:'cursor'});
 controls.requestCapture();
 assert.equal(controls.captured,true);
 controls.modes.set('multimeter');
 assert.equal(controls.captured,false,'you cannot drag a probe with a captured mouse');
 assert.equal(controls.overlay.root.hidden,true,'and the panel does not fight the mode for the click');
 assert.equal(controls.reticle.root.hidden,true);
 controls.modes.clear();
 assert.equal(controls.overlay.root.hidden,false,'leaving the mode asks for the mouse back rather than seizing it');
});

/* -- roomScale: aiming ---------------------------------------------------- */

test('the crosshair reads the centre of the view, not the cursor',()=>{
 const {controls,crate}=fixture({profile:'roomScale'});
 crate.visible=true;
 controls.update(1/60);
 assert.equal(controls.aim.item.kind,'crate','the nearer crate wins over the pad behind it');
 assert.equal(controls.reticle.state,'grab');
 crate.visible=false;
 controls.update(1/60);
 assert.equal(controls.aim.item,null,'with the crate hidden, the pad behind it is what the ray reaches');
 assert.equal(controls.aim.object.userData.label,'Reset pad');
 assert.equal(controls.reticle.state,'use');
});

test('the click that asks for the mouse does nothing else, and the next one uses the crosshair',()=>{
 let fired=0;const {canvas,controls}=fixture({profile:'roomScale',action:()=>fired++});
 controls.update(1/60);
 click(canvas,[800,500]);
 assert.equal(controls.captured,true);
 assert.equal(fired,0,'starting the scene does not also press whatever was under the crosshair');
 controls.update(1/60);
 canvas.emit('pointerup',{button:0,clientX:0,clientY:0});
 assert.equal(fired,1,'even though the cursor position is meaningless while captured');
});

test('an object out of reach reads as out of reach rather than as nothing',()=>{
 const {controls,crate,item,pad}=fixture({profile:'roomScale'});
 // The pad would otherwise be the nearer hit and answer for the crosshair itself.
 pad.visible=false;
 crate.visible=true;crate.position.set(0,1.6,-4);item.body.position.z=-4;
 crate.parent.updateMatrixWorld(true);
 controls.update(1/60);
 assert.equal(controls.aim.beyondReach,true);
 assert.equal(controls.reticle.state,'far');
});

/* -- roomScale: carrying -------------------------------------------------- */

const fakeCarry=()=>{
 const carry={held:null,pushes:0,released:[],updates:0,
  grab(item){carry.held=item;return true},
  release(thrown){carry.released.push({item:carry.held,thrown});carry.held=null},
  push(notches){carry.pushes+=notches},
  update(){carry.updates++},
 };
 return carry;
};

test('E picks up what the crosshair offers and puts it down again',()=>{
 const carry=fakeCarry();
 const {controls,crate,item,events}=fixture({profile:'roomScale',carry});
 crate.visible=true;
 controls.update(1/60);
 emitWindow('keydown',{code:'KeyE'});
 assert.equal(carry.held,item);
 assert.ok(events.some(e=>e.name==='grab'));
 controls.update(1/60);
 assert.equal(controls.reticle.state,'holding');
 assert.equal(controls.aim,null,'a full hand stops offering new pickups');
 emitWindow('keydown',{code:'KeyE'});
 assert.equal(carry.held,null);
 assert.deepEqual(carry.released.map(r=>r.thrown),[false],'E puts down, it does not throw');
});

test('the wheel only takes the page scroll while something is in hand',()=>{
 const carry=fakeCarry();
 const {canvas,controls,crate}=fixture({profile:'roomScale',carry});
 let prevented=0;const wheel=deltaY=>canvas.emit('wheel',{deltaY,preventDefault:()=>prevented++});
 wheel(-100);
 assert.equal(prevented,0,'empty-handed, an embedded page keeps its own scrolling');
 assert.equal(carry.pushes,0);
 crate.visible=true;controls.update(1/60);emitWindow('keydown',{code:'KeyE'});
 wheel(-100);wheel(100);
 assert.equal(prevented,2);
 assert.equal(carry.pushes,0,'scrolling out then in returns to where it started');
 wheel(-100);
 assert.equal(carry.pushes,-1,'scrolling away pushes the hold point out');
});

test('G and the right button throw; a refused grab leaves the hand empty',()=>{
 const carry=fakeCarry();
 const {canvas,controls,crate}=fixture({profile:'roomScale',carry,canGrab:()=>false});
 crate.visible=true;
 controls.update(1/60);
 assert.equal(controls.reticle.state,'idle','an object that cannot be taken right now offers nothing');
 emitWindow('keydown',{code:'KeyE'});
 assert.equal(carry.held,null);
 carry.held={kind:'crate'};
 emitWindow('keydown',{code:'KeyG'});
 assert.deepEqual(carry.released.at(-1).thrown,true);
 carry.held={kind:'crate'};
 canvas.emit('pointerup',{button:2});
 assert.deepEqual(carry.released.at(-1).thrown,true);
});

test('switching profile or disabling the controls puts down what is being carried',()=>{
 const carry=fakeCarry();
 const {controls,crate}=fixture({profile:'roomScale',carry});
 crate.visible=true;controls.update(1/60);emitWindow('keydown',{code:'KeyE'});
 assert.ok(carry.held);
 controls.setProfile('tabletop');
 assert.equal(carry.held,null,'a tabletop scene has no crosshair to carry with');
 assert.equal(controls.reticle.root.hidden,true);
});

/* -- lifecycle ------------------------------------------------------------ */

test('syncFromCamera picks up a heading the application aimed itself',()=>{
 const {camera,controls}=fixture();
 camera.lookAt(new THREE.Vector3(5,1.6,0));
 const {yaw}=controls.syncFromCamera();
 // Increasing yaw turns left, so facing +x is a quarter turn to the right.
 assert.ok(Math.abs(yaw+Math.PI/2)<1e-6,`facing +x is a quarter turn right: ${yaw}`);
 assert.equal(controls.yaw,yaw);
});

test('dispose removes every listener it added and takes its crosshair with it',()=>{
 const {canvas,controls}=fixture();
 const canvasTypes=['pointerdown','pointermove','pointerup','pointercancel','contextmenu','wheel'];
 const windowTypes=['keydown','keyup','blur'],documentTypes=['pointerlockchange','pointerlockerror'];
 const before=canvasTypes.map(t=>canvas.listeners(t));
 const windowBefore=windowTypes.map(t=>(windowHandlers.get(t)||[]).length);
 const documentBefore=documentTypes.map(t=>(documentHandlers.get(t)||[]).length);
 controls.dispose();
 assert.deepEqual(canvasTypes.map(t=>canvas.listeners(t)),before.map(n=>n-1));
 assert.deepEqual(windowTypes.map(t=>(windowHandlers.get(t)||[]).length),windowBefore.map(n=>n-1));
 assert.deepEqual(documentTypes.map(t=>(documentHandlers.get(t)||[]).length),documentBefore.map(n=>n-1));
 assert.equal(controls.reticle.root.removed,true);
 assert.equal(controls.overlay.root.removed,true);
});

test('an unknown profile fails fast rather than silently behaving like a tabletop',()=>{
 const {controls}=fixture();
 assert.equal(controls.profile,'tabletop');
 controls.setProfile('roomScale');
 assert.equal(controls.profile,'roomScale');
 assert.throws(()=>controls.setProfile('firstPerson'),/Unknown desktop profile/);
});

test('walking moves whatever the application says it moves',()=>{
 // A rig-based scene walks the rig; one that flies the camera directly walks the camera.
 const canvas=fakeCanvas(),rig=new THREE.Group(),camera=new THREE.PerspectiveCamera(58,1.6,.025,100);
 rig.add(camera);camera.position.set(0,1.6,0);rig.updateMatrixWorld(true);
 const controls=createDesktopControls({canvas,camera,rig,mover:camera});
 controls.keys.add('KeyW');
 controls.update(.5);
 assert.ok(camera.position.z<-.9,`the camera walked: ${camera.position.z}`);
 assert.ok(rig.position.equals(new THREE.Vector3(0,0,0)),'and the rig stayed put');
 assert.ok(Math.abs(camera.position.y-1.6)<1e-9,'walking is level; height is the application\'s business');
});

test('a cursor mode owns the pointer: no crosshair aim, no crosshair select',()=>{
 // Dragging a probe onto a terminal is the mode's gesture. If the controls also fired whatever
 // the centre of the view happened to be resting on, every drag would trip something behind it.
 let fired=0;const {canvas,controls,crate}=fixture({profile:'roomScale',action:()=>fired++});
 controls.modes.register('multimeter',{key:'KeyM',pointer:'cursor'});
 crate.visible=true;
 controls.modes.set('multimeter');
 controls.update(1/60);
 assert.equal(controls.aim,null,'nothing is being aimed at');
 assert.equal(controls.reticle.root.hidden,true);
 click(canvas,[800,500]);
 assert.equal(fired,0);
 controls.modes.clear();
 controls.update(1/60);
 assert.ok(controls.aim,'and the crosshair comes back when the mode does');
});
