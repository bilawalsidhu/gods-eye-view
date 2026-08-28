/**
 * @license
 * Cesium - https://github.com/CesiumGS/cesium
 * Version 1.124
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

import{b as t}from"./chunk-M3A6SPGI.js";import{a as r}from"./chunk-N3A5CZ2S.js";import{a as m}from"./chunk-G75U3WZT.js";import{e as i}from"./chunk-3THTQ4QB.js";function d(e){if(e=r(e,r.EMPTY_OBJECT),!i(e.geometry))throw new m("options.geometry is required.");this.geometry=e.geometry,this.modelMatrix=t.clone(r(e.modelMatrix,t.IDENTITY)),this.id=e.id,this.pickPrimitive=e.pickPrimitive,this.attributes=r(e.attributes,{}),this.westHemisphereGeometry=void 0,this.eastHemisphereGeometry=void 0}var s=d;export{s as a};
