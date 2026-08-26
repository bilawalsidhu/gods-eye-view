/**
 * @license
 * Cesium - https://github.com/CesiumGS/cesium
 * Version 1.138.0
 *
 * Copyright 2011-2022 Cesium Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Columbus View (Pat. Pend.)
 *
 * Portions licensed separately.
 * See https://github.com/CesiumGS/cesium/blob/main/LICENSE.md for full licensing details.
 */

var r,u=typeof TextDecoder<"u"?new TextDecoder("utf-8",{ignoreBOM:!0,fatal:!0}):{decode:()=>{throw Error("TextDecoder not available")}};typeof TextDecoder<"u"&&u.decode();var a=null;function h(){return(a===null||a.byteLength===0)&&(a=new Uint8Array(r.memory.buffer)),a}function b(e,t){return e=e>>>0,u.decode(h().subarray(e,e+t))}var o=null;function g(){return(o===null||o.byteLength===0)&&(o=new Uint32Array(r.memory.buffer)),o}function m(e,t){return e=e>>>0,g().subarray(e/4,e/4+t)}var y=0;function x(e,t){let n=t(e.length*4,4)>>>0;return g().set(e,n/4),y=e.length,n}function c(e){let t=r.__wbindgen_export_0.get(e);return r.__externref_table_dealloc(e),t}function U(e,t,n,i,_){let s=r.generate_splat_texture(e,t,n,i,_);if(s[2])throw c(s[1]);return f.__wrap(s[0])}function M(e,t,n){let i=r.radix_sort_gaussians_indexes(e,t,n);if(i[2])throw c(i[1]);return c(i[0])}var w=typeof FinalizationRegistry>"u"?{register:()=>{},unregister:()=>{}}:new FinalizationRegistry(e=>r.__wbg_texturedata_free(e>>>0,1)),f=class e{static __wrap(t){t=t>>>0;let n=Object.create(e.prototype);return n.__wbg_ptr=t,w.register(n,n.__wbg_ptr,n),n}__destroy_into_raw(){let t=this.__wbg_ptr;return this.__wbg_ptr=0,w.unregister(this),t}free(){let t=this.__destroy_into_raw();r.__wbg_texturedata_free(t,0)}get data(){let t=r.texturedata_data(this.__wbg_ptr);var n=m(t[0],t[1]).slice();return r.__wbindgen_free(t[0],t[1]*4,4),n}get width(){return r.texturedata_width(this.__wbg_ptr)>>>0}get height(){return r.texturedata_height(this.__wbg_ptr)>>>0}static new(t,n,i){let _=x(t,r.__wbindgen_malloc),s=y,p=r.texturedata_new(_,s,n,i);return e.__wrap(p)}};async function A(e,t){if(typeof Response=="function"&&e instanceof Response){if(typeof WebAssembly.instantiateStreaming=="function")try{return await WebAssembly.instantiateStreaming(e,t)}catch(i){if(e.headers.get("Content-Type")!="application/wasm")console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n",i);else throw i}let n=await e.arrayBuffer();return await WebAssembly.instantiate(n,t)}else{let n=await WebAssembly.instantiate(e,t);return n instanceof WebAssembly.Instance?{instance:n,module:e}:n}}function d(){let e={};return e.wbg={},e.wbg.__wbg_buffer_609cc3eee51ed158=function(t){return t.buffer},e.wbg.__wbg_length_3b4f022188ae8db6=function(t){return t.length},e.wbg.__wbg_length_a446193dc22c12f8=function(t){return t.length},e.wbg.__wbg_new_780abee5c1739fd7=function(t){return new Float32Array(t)},e.wbg.__wbg_new_a12002a7f91c75be=function(t){return new Uint8Array(t)},e.wbg.__wbg_new_e3b321dcfef89fc7=function(t){return new Uint32Array(t)},e.wbg.__wbg_newwithbyteoffsetandlength_f1dead44d1fc7212=function(t,n,i){return new Uint32Array(t,n>>>0,i>>>0)},e.wbg.__wbg_set_10bad9bee0e9c58b=function(t,n,i){t.set(n,i>>>0)},e.wbg.__wbg_set_65595bdd868b3009=function(t,n,i){t.set(n,i>>>0)},e.wbg.__wbindgen_init_externref_table=function(){let t=r.__wbindgen_export_0,n=t.grow(4);t.set(0,void 0),t.set(n+0,void 0),t.set(n+1,null),t.set(n+2,!0),t.set(n+3,!1)},e.wbg.__wbindgen_memory=function(){return r.memory},e.wbg.__wbindgen_string_new=function(t,n){return b(t,n)},e.wbg.__wbindgen_throw=function(t,n){throw new Error(b(t,n))},e}function l(e,t){return r=e.exports,W.__wbindgen_wasm_module=t,o=null,a=null,r.__wbindgen_start(),r}function O(e){if(r!==void 0)return r;typeof e<"u"&&(Object.getPrototypeOf(e)===Object.prototype?{module:e}=e:console.warn("using deprecated parameters for `initSync()`; pass a single object instead"));let t=d();e instanceof WebAssembly.Module||(e=new WebAssembly.Module(e));let n=new WebAssembly.Instance(e,t);return l(n,e)}async function W(e){if(r!==void 0)return r;typeof e<"u"&&(Object.getPrototypeOf(e)===Object.prototype?{module_or_path:e}=e:console.warn("using deprecated parameters for the initialization function; pass a single object instead")),typeof e>"u"&&(e=new URL("wasm_splats_bg.wasm",import.meta.url));let t=d();(typeof e=="string"||typeof Request=="function"&&e instanceof Request||typeof URL=="function"&&e instanceof URL)&&(e=fetch(e));let{instance:n,module:i}=await A(await e,t);return l(n,i)}export{U as a,M as b,O as c};
