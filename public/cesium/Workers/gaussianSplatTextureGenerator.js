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

import{a,c}from"./chunk-OBYHY7FI.js";import{a as i}from"./chunk-BUKMP3AW.js";import{e as n}from"./chunk-4TAASUQ2.js";async function u(t,s){let e=t.webAssemblyConfig;return n(e)&&n(e.wasmBinary)?(c({module:e.wasmBinary}),!0):!1}async function l(t,s){let e=t.webAssemblyConfig;if(n(e))return u(t,s);let{attributes:r,count:f}=t,o=a(r.positions,r.scales,r.rotations,r.colors,f);return{data:o.data,width:o.width,height:o.height}}var w=i(l);export{w as default};
