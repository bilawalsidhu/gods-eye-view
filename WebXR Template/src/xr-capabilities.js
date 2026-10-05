import {framebufferScaleFor} from './xr-quality.js';
export async function detectXR(xr){
 if(!xr)return {ar:false,vr:false,mode:null};
 const supported=async mode=>{try{return await xr.isSessionSupported(mode)}catch{return false}};
 const [ar,vr]=await Promise.all([supported('immersive-ar'),supported('immersive-vr')]);
 return {ar,vr,mode:ar?'immersive-ar':vr?'immersive-vr':null};
}
export function sessionOptions(mode){
 return {optionalFeatures:['local-floor','hand-tracking',...(mode==='immersive-ar'?['hit-test','plane-detection','mesh-detection']:[])]};
}
// Probes the runtime's recommended eye-buffer size for THIS session before entry, and scales it to
// the quality level's pixel budget (xr-quality.js). This is what fixes the framebuffer on the
// FIRST entry: the adaptive step-down in main.js still watches sustained frame time as a backstop,
// but it can only act on the SECOND entry, after a session has already run long once. Guarded on
// every side -- WebGL2 without makeXRCompatible, a runtime with no XRWebGLLayer at all (tests, and
// any future non-three renderer), and a probe layer construction the spec allows to throw -- so a
// renderer or session that cannot answer just skips the probe and keeps the level's flat scale.
async function probeFramebuffer(renderer,session,quality){
 if(!quality||!renderer.getContext||!globalThis.XRWebGLLayer)return null;
 const gl=renderer.getContext();
 try{await gl.makeXRCompatible?.();}catch{return null}
 let layer=null;
 // Only the size is read, and the layer is never attached, so it is built without multisampling,
 // depth or stencil: a full-size MSAA probe is a second eye buffer's worth of GPU memory held until
 // it is collected, on a headset that is about to allocate the real one.
 try{layer=new XRWebGLLayer(session,gl,{antialias:false,depth:false,stencil:false,alpha:false});}catch{return null}
 const width=layer?.framebufferWidth,height=layer?.framebufferHeight;
 const scale=framebufferScaleFor(width,height,quality);
 renderer.xr.setFramebufferScaleFactor?.(scale);
 return {width,height,scale};
}
export async function attachXR(renderer,session,{quality}={}){
 let floor=true;
 try{await session.requestReferenceSpace('local-floor')}catch{floor=false}
 renderer.xr.setReferenceSpaceType(floor?'local-floor':'local');
 const framebuffer=await probeFramebuffer(renderer,session,quality);
 await renderer.xr.setSession(session);
 if(!floor){const local=await session.requestReferenceSpace('local');renderer.xr.setReferenceSpace(local.getOffsetReferenceSpace(new XRRigidTransform({y:-1.6})));}
 return {floor,framebuffer};
}
export function isSpatialPointer(source){return source?.targetRayMode==='transient-pointer'||source?.targetRayMode==='gaze';}
