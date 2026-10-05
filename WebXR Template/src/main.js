import {detectXR,sessionOptions,attachXR} from './xr-capabilities.js';
import './style.css';
import './desktop.css';
import {applyBrand,brand,brandReady,brandLogo} from './brand.js';
await brandReady;
applyBrand();
import * as THREE from 'three';
import {createStarterScene} from './scene.js';
import {XRToolkit} from './xr-toolkit.js';
import {validFloor} from './locomotion.js';
import {trackedHandPose} from './xr-hands.js';
import {Diagnostics,createDiagnosticsPanel} from './diagnostics.js';
import {createSurfacePlacement,HIT_TEST_STATES} from './mr-placement.js';
import {createSettings,labelFor} from './settings.js';
import {createPanelBench} from './panels/bench.js';
import {createDesktopControls} from './desktop-controls.js';
import {createDesktopCarry} from './desktop-carry.js';
import {applyRenderQuality,createFrameBudget,sessionTargetHz,nextSmoother,qualityLevel} from './xr-quality.js';
import {watchSession} from './xr-lifecycle.js';
const canvas=document.querySelector('#viewport'),toast=document.querySelector('#toast'),button=document.querySelector('#enter-vr'),stationList=document.querySelector('#stations'),readout=document.querySelector('#readout'),settingButton=document.querySelector('#setting-controller-hands'),qualityButton=document.querySelector('#setting-render-quality');
const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(58,innerWidth/innerHeight,.025,100),rig=new THREE.Group();scene.add(rig);rig.add(camera);camera.position.set(0,1.65,3.5);
const renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:true,powerPreference:'high-performance'});renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.setSize(innerWidth,innerHeight);renderer.xr.enabled=true;renderer.xr.setReferenceSpaceType('local-floor');renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
// The shadow depth pass is re-rendered only when the loop asks (see shadowClock below), not on
// every display frame. It is shared by both eyes, but at 90 Hz it was still the second largest
// cost after the eye buffers themselves.
renderer.shadowMap.autoUpdate=false;renderer.shadowMap.needsUpdate=true;

function say(message){toast.textContent=message;toast.classList.add('visible');clearTimeout(say.timer);say.timer=setTimeout(()=>toast.classList.remove('visible'),2600)}
const diagnostics=new Diagnostics();
const starter=createStarterScene(scene,{
 onHaptics(fired){if(fired){diagnostics.complete('haptics','haptic pulse');say('Haptic pulse sent.')}else{diagnostics.note('no haptic actuator');say('This input has no haptic actuator.')}},
 onProbe(){diagnostics.note('probe pad')},
});
const panel=createDiagnosticsPanel(scene,diagnostics,brand);
const placement=createSurfacePlacement(scene,{onPlace(){diagnostics.complete('mr-placement','surface placement')}});
// Scene settings persist in this browser; the in-scene board and the bench button are two views of
// the same store, so a change from either lands in both.
const settings=createSettings();
const panelBench=createPanelBench({scene,camera,renderer,brand,logo:brandLogo,starter,settings,onStatus:say});
const panels=panelBench.manager;
panelBench.mount();
// Render quality. The runtime allocates the eye buffers at session entry from the framebuffer
// scale set here, so that part of a level is only felt on the next entry; shadow map size,
// filtering and cadence apply immediately. A session whose frames run long steps the persisted
// level down, so the next entry starts where this one settled instead of rediscovering the lag.
const shadowTypes={soft:THREE.PCFSoftShadowMap,basic:THREE.PCFShadowMap};
let quality=applyRenderQuality(renderer,settings.get('renderQuality'),{shadowLights:[starter.sun],shadowTypes,scene});
let frameBudget=createFrameBudget(),shadowClock=0;

// Interaction outcomes arrive through the toolkit's optional observer, so the checklist never has
// to reach into toolkit internals. Which station a grab or select proves depends on the input that
// produced it -- that distinction is the whole point of the hand/controller rows.
const isHand=input=>Boolean(input?.source?.hand);
const THROW_SPEED=1.2;
const xr=new XRToolkit({...starter,renderer,scene,rig,onToast:say,panelInput:panelBench.input,controllerVisual:settings.get('controllerVisual'),microgestures:settings.get('microgestures')==='on',onEvent(name,detail){
 if(name==='select')diagnostics.complete(isHand(detail.input)?'hand-select':'controller-select',isHand(detail.input)?'pinch select':'trigger select');
 else if(name==='grab')diagnostics.complete(isHand(detail.input)?'hand-grab':'controller-grab',isHand(detail.input)?'pinch grab':'grip grab');
 else if(name==='release'){if(detail.throwObject&&detail.speed>THROW_SPEED)diagnostics.complete('throw',`throw ${detail.speed.toFixed(1)} m/s`);else diagnostics.note('release')}
 else if(name==='teleport')diagnostics.complete('teleport','teleport');
 else if(name==='teleport-rejected')diagnostics.complete('teleport-rejected','teleport blocked');
 else if(name==='snapturn')diagnostics.complete('snap-turn','snap turn');
}});
function syncSettingsDom(){const value=settings.get('controllerVisual');settingButton.textContent=labelFor('controllerVisual',value);settingButton.setAttribute('aria-pressed',String(value==='hand'));qualityButton.textContent=labelFor('renderQuality',settings.get('renderQuality'))}
settingButton.onclick=()=>settings.toggle('controllerVisual');qualityButton.onclick=()=>settings.toggle('renderQuality');
settings.subscribe((name,value)=>{
 if(name==='renderQuality'){quality=applyRenderQuality(renderer,value,{shadowLights:[starter.sun],shadowTypes,scene});renderer.shadowMap.needsUpdate=true;frameBudget.reset();diagnostics.note(`render quality ${value}`)}
 if(name==='microgestures'){xr.setMicrogestures(value==='on');diagnostics.note(`thumb microgestures ${value}`)}
 if(name==='controllerVisual'){xr.setControllerVisual(value);const holding=xr.inputs.some(input=>input.source?.gamepad&&!input.source.hand);if(value==='hand'&&holding)diagnostics.complete('controller-hands','controller hands on');else diagnostics.note(`controller hands ${value==='hand'?'on':'off'}`)}
 syncSettingsDom();
});
syncSettingsDom();

// The desktop station is only satisfied once all three of its parts have actually been used,
// and the pickup station once a block has been carried and its distance changed.
let desktopLook=false,desktopMove=false,desktopClick=false,pickedUp=false,pushedPulled=false;
// Looking, walking, pointing and carrying come from the shared modules so every application
// behaves the same way on a mouse. The bench is a room you walk around in, so it runs the
// roomScale profile: the mouse is captured and the crosshair is the aim point. Esc hands the
// cursor back for the panel on the right, and clicking the scene takes it again.
const desktopCarry=createDesktopCarry({world:starter.world,camera});
const desktop=createDesktopControls({
 canvas,camera,rig,
 profile:'roomScale',
 carry:desktopCarry,
 targets:()=>starter.targets,
 grabbables:()=>starter.grabbables,
 blockers:()=>starter.blockers,
 floorTest:validFloor,
 captureTitle:'Click to play',
 captureLines:['WASD to move','E to pick up a block','Scroll to push and pull','R and mouse to turn it','Esc for the cursor'],
 onEvent(name,detail){
  if(name==='look')desktopLook=true;
  else if(name==='move')desktopMove=true;
  else if(name==='use')desktopClick=true;
  else if(name==='grab'){pickedUp=true;say('Block picked up. Scroll to push it out or pull it in.')}
  else if(name==='release'&&detail.thrown)diagnostics.note('desktop throw');
 },
});
desktop.setAngles(0,-.12);

const capabilities=await detectXR(navigator.xr);let activeSession=null,lifecycle=null,pending=false;
const desktopBackground=scene.background,desktopFog=scene.fog;
diagnostics.setSession({mode:'desktop',referenceSpace:null,hitTest:HIT_TEST_STATES.unavailable});
const entryLabel=()=>{button.disabled=!capabilities.mode;button.textContent=capabilities.mode==='immersive-ar'?'Enter MR':capabilities.mode==='immersive-vr'?'Enter VR':'Headset unavailable';};entryLabel();
button.onclick=async()=>{
 if(pending||activeSession)return;pending=true;button.disabled=true;let next=null;
 try{next=await navigator.xr.requestSession(capabilities.mode,sessionOptions(capabilities.mode));activeSession=next;
  // Frames around the system menu are not a frame rate: sampling restarts when focus returns.
  lifecycle=watchSession(next,{onVisibility:state=>{if(state==='visible')frameBudget.reset()}});
  const mr=capabilities.mode==='immersive-ar',desktopRigPosition=rig.position.clone(),desktopRigRotation=rig.quaternion.clone();
  next.addEventListener('end',()=>{activeSession=lifecycle=null;rig.position.copy(desktopRigPosition);rig.quaternion.copy(desktopRigRotation);scene.background=desktopBackground;scene.fog=desktopFog;starter.setMixedReality(false);xr.setMixedReality(false);placement.stop();panel.setMixedReality(false,camera);panels.room.stop();panelBench.preferences.setPose({position:[1.05,1.55,-1.45],quaternion:new THREE.Quaternion().setFromEuler(new THREE.Euler(0,-.62,0)).toArray()});diagnostics.setSession({mode:'desktop',referenceSpace:null,hitTest:HIT_TEST_STATES.unavailable});diagnostics.setFramebuffer(null);desktop.setEnabled(true);document.body.classList.remove('xr-active');entryLabel();},{once:true});
  // A select with no target under it, on a real surface, places a marker. Registered on the
  // session so MR placement stays independent of the toolkit's target raycast.
  next.addEventListener('select',event=>{const input=xr.inputs.find(input=>input.source===event.inputSource);if(mr&&placement.hasSurface&&input&&!input.held&&!panels.captured(input)&&!input.aimHit)placement.place()});
  // The desktop controls own the keyboard now, so disabling them is what clears held keys.
  scene.background=mr?null:desktopBackground;scene.fog=mr?null:desktopFog;starter.setMixedReality(mr);xr.setMixedReality(mr);rig.position.set(0,0,0);rig.rotation.set(0,0,0);desktop.setEnabled(false);document.body.classList.add('xr-active');
  const {floor,framebuffer}=await attachXR(renderer,next,{quality:qualityLevel(settings.get('renderQuality'))});
  diagnostics.setFramebuffer(framebuffer);
  frameBudget=createFrameBudget({targetHz:sessionTargetHz(next)});shadowClock=0;renderer.shadowMap.needsUpdate=true;
  diagnostics.setSession({mode:capabilities.mode,referenceSpace:floor?'local-floor':'local (1.6 m estimate)',hitTest:await placement.start(next,mr)});
  panel.setMixedReality(mr,camera);panels.room.start(next,mr);panels.prepare(renderer.xr.getCamera(),null,null,rig);panelBench.preferences.recenter();panels.discontinuity();
  const referenceSpace=renderer.xr.getReferenceSpace();referenceSpace?.addEventListener('reset',()=>{panels.room.reset();panels.discontinuity();});
 }catch(error){if(next)await next.end().catch(()=>{});if(error.name==='NotSupportedError'&&capabilities.mode==='immersive-ar'&&capabilities.vr){capabilities.mode='immersive-vr';say('MR unavailable. Select Enter VR.')}else say('Could not enter headset: '+error.message);}
 finally{pending=false;entryLabel();}
};
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight)});

stationList.innerHTML=diagnostics.checklist.entries().map(station=>`<li data-station="${station.id}"><span class="mark">○</span><b>${station.label}</b><span class="hint">${station.hint}</span></li>`).join('');
function paintDom(){
 for(const station of diagnostics.checklist.entries()){const item=stationList.querySelector(`[data-station="${station.id}"]`);item.classList.toggle('done',station.done);item.querySelector('.mark').textContent=station.done?'✓':'○'}
 readout.innerHTML=diagnostics.lines().map(([label,value])=>`<dt>${label}</dt><dd>${value}</dd>`).join('');
}
paintDom();

const clock=new THREE.Clock();
renderer.setAnimationLoop((time,frame)=>{
 const seconds=time/1000,dt=Math.min(clock.getDelta(),.05);
 diagnostics.frame(seconds);
 // Shadows refresh at the level's cadence, not the display's. Held blocks move between refreshes,
 // but at 12-30 Hz the lag sits below what a viewer notices while the depth pass drops from every
 // frame to a fraction of them.
 shadowClock+=dt;if(shadowClock>=1/quality.shadowUpdateHz){shadowClock=0;renderer.shadowMap.needsUpdate=true}
 if(renderer.xr.isPresenting&&lifecycle?.visible){frameBudget.push(dt*1000);if(frameBudget.strained){const current=settings.get('renderQuality'),next=nextSmoother(current);if(next!==current){settings.set('renderQuality',next);say(`Frames running long: render quality set to ${next}. Re-enter the headset for the full effect.`)}frameBudget.reset()}}
 if(!renderer.xr.isPresenting){
  const carriedAt=desktopCarry.distance;
  desktop.update(dt);
  if(desktopCarry.held&&Math.abs(desktopCarry.distance-carriedAt)>1e-6)pushedPulled=true;
  if(desktopLook&&desktopMove&&desktopClick)diagnostics.complete('desktop','desktop controls');
  if(pickedUp&&pushedPulled)diagnostics.complete('desktop-pickup','desktop pickup');
 }
 panels.prepare(renderer.xr.isPresenting?renderer.xr.getCamera():camera,frame,renderer.xr.getReferenceSpace(),renderer.xr.isPresenting?rig:null);
 xr.update(seconds);

 starter.workspace.setHands(xr.inputs.map(input=>{
  const pose=input.source?.hand?trackedHandPose(input.hand):null;
  return pose?.position||(input.grip?.visible?input.grip.getWorldPosition(new THREE.Vector3()):null);
 }),starter.workspaceRoot);
 placement.update(frame,renderer.xr.getReferenceSpace());
 starter.world.step(1/72,dt,4);desktopCarry.sync();
 for(const item of starter.grabbables)if(!item.held){item.object.position.copy(item.body.position);item.object.quaternion.copy(item.body.quaternion);if(item.body.position.y<-.5)starter.resetBlocks()}
 // Gathering input and hand state allocates, so it happens on the redraw tick rather than every
 // frame -- the panel exists to measure frame timing, not to spend it.
 if(diagnostics.shouldRedraw(seconds)){
  diagnostics.setInputs(xr.inputs.map(input=>input.source).filter(Boolean));
  diagnostics.setHands(xr.inputs.map(input=>{const pose=input.source?.hand?trackedHandPose(input.hand):null;return pose?{...pose,pinching:input.pinching}:null}));
  panel.draw();paintDom();
 }
 panels.collision.refresh(panels.panels);
 panels.updateHover();panels.update(dt);panels.updateDomStatus();
 renderer.render(scene,camera);
});
say('Test bench ready — desktop controls are active.');
