import test from 'node:test';import assert from 'node:assert/strict';
import {detectXR,sessionOptions,attachXR,isSpatialPointer} from '../src/xr-capabilities.js';
test('prefers MR, falls back to VR, handles absent and rejected capabilities',async()=>{
 for(const [ar,vr,mode]of [[true,true,'immersive-ar'],[false,true,'immersive-vr'],[false,false,null]])assert.deepEqual(await detectXR({isSessionSupported:async m=>m==='immersive-ar'?ar:vr}),{ar,vr,mode});
 assert.equal((await detectXR(null)).mode,null);assert.equal((await detectXR({isSessionSupported:async()=>{throw Error()}})).mode,null);
});
test('hands and floor optional; VR never requests hit testing',()=>{assert.equal(sessionOptions('immersive-vr').requiredFeatures,undefined);assert.equal(sessionOptions('immersive-vr').optionalFeatures.includes('hit-test'),false);assert.equal(sessionOptions('immersive-ar').optionalFeatures.includes('hit-test'),true);assert.equal(isSpatialPointer({targetRayMode:'transient-pointer'}),true)});
test('renderer uses local-floor when available and eye-height local fallback otherwise',async()=>{
 globalThis.XRRigidTransform=class{constructor(position){this.position=position}};
 for(const floor of [true,false]){let type,offset;const space={getOffsetReferenceSpace:t=>{offset=t.position.y;return space}};const session={requestReferenceSpace:async t=>{if(t==='local-floor'&&!floor)throw Error();return space}};const renderer={xr:{setReferenceSpaceType:t=>type=t,setSession:async()=>{},setReferenceSpace:()=>{}}};await attachXR(renderer,session);assert.equal(type,floor?'local-floor':'local');if(!floor)assert.equal(offset,-1.6);}
 delete globalThis.XRRigidTransform;
});
test('without a quality level, nothing is probed and setSession still happens',async()=>{
 let sessionSet=false,scaleCalls=0;
 const renderer={getContext(){throw new Error('should not be called')},xr:{setReferenceSpaceType(){},setFramebufferScaleFactor(){scaleCalls++},async setSession(){sessionSet=true}}};
 const session={requestReferenceSpace:async()=>({})};
 const {framebuffer}=await attachXR(renderer,session);
 assert.equal(framebuffer,null);assert.equal(scaleCalls,0);assert.equal(sessionSet,true);
});
test('the probe reads the recommended buffer, sets the budgeted scale, and returns it before setSession',async()=>{
 class FakeXRWebGLLayer{constructor(session,gl){this.framebufferWidth=3360;this.framebufferHeight=1760;}}
 globalThis.XRWebGLLayer=FakeXRWebGLLayer;
 let scale=null,sessionSetAfterScale=false,order=[];
 const renderer={getContext(){return {makeXRCompatible:async()=>{order.push('compatible')}}},xr:{setReferenceSpaceType(){},setFramebufferScaleFactor(v){scale=v;order.push('scale')},async setSession(){order.push('session');sessionSetAfterScale=order.includes('scale')}}};
 const session={requestReferenceSpace:async()=>({})};
 const {framebuffer}=await attachXR(renderer,session,{quality:{framebufferScale:.9,pixelBudget:6.0e6}});
 assert.ok(Math.abs(scale-.9)<1e-6);
 assert.deepEqual(framebuffer,{width:3360,height:1760,scale});
 assert.equal(sessionSetAfterScale,true,'the probe runs, and the scale is applied, before setSession');
 delete globalThis.XRWebGLLayer;
});
test('a throwing XRWebGLLayer constructor is swallowed and setSession still happens',async()=>{
 globalThis.XRWebGLLayer=class{constructor(){throw new Error('no XR device')}};
 let sessionSet=false,scaleCalls=0;
 const renderer={getContext(){return {makeXRCompatible:async()=>{}}},xr:{setReferenceSpaceType(){},setFramebufferScaleFactor(){scaleCalls++},async setSession(){sessionSet=true}}};
 const session={requestReferenceSpace:async()=>({})};
 const {framebuffer}=await attachXR(renderer,session,{quality:{framebufferScale:.9,pixelBudget:6.0e6}});
 assert.equal(framebuffer,null);assert.equal(scaleCalls,0);assert.equal(sessionSet,true);
 delete globalThis.XRWebGLLayer;
});
