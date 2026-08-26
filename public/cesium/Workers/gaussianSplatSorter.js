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

import{b as t,c as f}from"./chunk-OBYHY7FI.js";import{a as s}from"./chunk-BUKMP3AW.js";import{e as o}from"./chunk-4TAASUQ2.js";async function m(i,e){let n=i.webAssemblyConfig;if(o(n)&&o(n.wasmBinary))return f({module:n.wasmBinary}),!0}function c(i,e){let n=i.webAssemblyConfig;if(o(n))return m(i,e);let{primitive:r,sortType:a}=i;if(a==="Index")return t(r.positions,r.modelView,r.count)}var y=s(c);export{y as default};
