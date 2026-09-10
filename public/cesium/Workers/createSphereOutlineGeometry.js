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

import{a as t}from"./chunk-25AFYL5M.js";import"./chunk-3BERLVP2.js";import"./chunk-CVUC3Z4F.js";import"./chunk-WF6KNLYB.js";import"./chunk-VGKISNF5.js";import"./chunk-VPJRLZMB.js";import"./chunk-635BMVFD.js";import"./chunk-Y7Z6CVXH.js";import"./chunk-HHFPYI7Q.js";import"./chunk-SSZI3JCE.js";import"./chunk-LP5YXEIX.js";import"./chunk-AMKKUAL3.js";import"./chunk-WORPNHJT.js";import{a as c}from"./chunk-SWCW4GSU.js";import"./chunk-PZM5FOOW.js";import{b as u}from"./chunk-3MNKUQ6L.js";import{f as a}from"./chunk-J4SK6SKL.js";function s(i){let e=i.radius??1,r={radii:new c(e,e,e),stackPartitions:i.stackPartitions,slicePartitions:i.slicePartitions,subdivisions:i.subdivisions};this._ellipsoidGeometry=new t(r),this._workerName="createSphereOutlineGeometry"}s.packedLength=t.packedLength;s.pack=function(i,e,o){return u.typeOf.object("value",i),t.pack(i._ellipsoidGeometry,e,o)};var l=new t,n={radius:void 0,radii:new c,stackPartitions:void 0,slicePartitions:void 0,subdivisions:void 0};s.unpack=function(i,e,o){let r=t.unpack(i,e,l);return n.stackPartitions=r._stackPartitions,n.slicePartitions=r._slicePartitions,n.subdivisions=r._subdivisions,a(o)?(c.clone(r._radii,n.radii),o._ellipsoidGeometry=new t(n),o):(n.radius=r._radii.x,new s(n))};s.createGeometry=function(i){return t.createGeometry(i._ellipsoidGeometry)};var d=s;function m(i,e){return a(e)&&(i=d.unpack(i,e)),d.createGeometry(i)}var h=m;export{h as default};
