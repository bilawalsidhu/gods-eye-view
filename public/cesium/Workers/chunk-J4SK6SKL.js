/**
 * @license
 * Cesium - https://github.com/CesiumGS/cesium
 * Version 1.144.0
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

var i=Object.create;var t=Object.defineProperty;var r=Object.getOwnPropertyDescriptor;var l=Object.getOwnPropertyNames;var o=Object.getPrototypeOf,c=Object.prototype.hasOwnProperty;var p=(n,e,d)=>e in n?t(n,e,{enumerable:!0,configurable:!0,writable:!0,value:d}):n[e]=d;var b=(n=>typeof require<"u"?require:typeof Proxy<"u"?new Proxy(n,{get:(e,d)=>(typeof require<"u"?require:e)[d]}):n)(function(n){if(typeof require<"u")return require.apply(this,arguments);throw Error('Dynamic require of "'+n+'" is not supported')}),g=n=>e=>{var d=n[e];if(d)return d();throw new Error("Module not found in bundle: "+e)};var h=(n,e)=>()=>{try{return e||n((e={exports:{}}).exports,e),e.exports}catch(d){throw e=0,d}};var x=(n,e,d,u)=>{if(e&&typeof e=="object"||typeof e=="function")for(let f of l(e))!c.call(n,f)&&f!==d&&t(n,f,{get:()=>e[f],enumerable:!(u=r(e,f))||u.enumerable});return n};var j=(n,e,d)=>(d=n!=null?i(o(n)):{},x(e||!n||!n.__esModule?t(d,"default",{value:n,enumerable:!0}):d,n));var k=(n,e,d)=>p(n,typeof e!="symbol"?e+"":e,d);function a(n){return n!=null}var q=a;export{b as a,g as b,h as c,j as d,k as e,q as f};
