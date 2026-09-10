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

import{b as r}from"./chunk-HHFPYI7Q.js";import{c as m}from"./chunk-SWCW4GSU.js";import{a as i}from"./chunk-3MNKUQ6L.js";import{f as t}from"./chunk-J4SK6SKL.js";function d(e){if(e=e??m.EMPTY_OBJECT,!t(e.geometry))throw new i("options.geometry is required.");this.geometry=e.geometry,this.modelMatrix=r.clone(e.modelMatrix??r.IDENTITY),this.id=e.id,this.pickPrimitive=e.pickPrimitive,this.attributes=e.attributes??{},this.westHemisphereGeometry=void 0,this.eastHemisphereGeometry=void 0}var a=d;export{a};
