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

import{a as l}from"./chunk-LFBA5RLZ.js";import"./chunk-IHTR4QEI.js";import"./chunk-4DLB7LPO.js";import"./chunk-OX6OW7LH.js";import"./chunk-SXFPISI4.js";import"./chunk-QVQR4MNN.js";import"./chunk-3BERLVP2.js";import{a as m}from"./chunk-ER474XE6.js";import"./chunk-Q2AGSIFJ.js";import"./chunk-4XQS6KUO.js";import"./chunk-CVUC3Z4F.js";import"./chunk-WF6KNLYB.js";import"./chunk-VGKISNF5.js";import"./chunk-VPJRLZMB.js";import"./chunk-635BMVFD.js";import"./chunk-Y7Z6CVXH.js";import"./chunk-HHFPYI7Q.js";import"./chunk-SSZI3JCE.js";import"./chunk-LP5YXEIX.js";import"./chunk-AMKKUAL3.js";import{c as s}from"./chunk-WORPNHJT.js";import{a,c as _}from"./chunk-SWCW4GSU.js";import"./chunk-PZM5FOOW.js";import{b as p}from"./chunk-3MNKUQ6L.js";import{f as d}from"./chunk-J4SK6SKL.js";function n(e){e=e??_.EMPTY_OBJECT;let r=e.radius;p.typeOf.number("radius",r);let o={center:e.center,semiMajorAxis:r,semiMinorAxis:r,ellipsoid:e.ellipsoid,height:e.height,extrudedHeight:e.extrudedHeight,granularity:e.granularity,vertexFormat:e.vertexFormat,stRotation:e.stRotation,shadowVolume:e.shadowVolume};this._ellipseGeometry=new l(o),this._workerName="createCircleGeometry"}n.packedLength=l.packedLength;n.pack=function(e,r,o){return p.typeOf.object("value",e),l.pack(e._ellipseGeometry,r,o)};var h=new l({center:new a,semiMajorAxis:1,semiMinorAxis:1}),t={center:new a,radius:void 0,ellipsoid:s.clone(s.default),height:void 0,extrudedHeight:void 0,granularity:void 0,vertexFormat:new m,stRotation:void 0,semiMajorAxis:void 0,semiMinorAxis:void 0,shadowVolume:void 0};n.unpack=function(e,r,o){let i=l.unpack(e,r,h);return t.center=a.clone(i._center,t.center),t.ellipsoid=s.clone(i._ellipsoid,t.ellipsoid),t.ellipsoid=s.clone(i._ellipsoid,h._ellipsoid),t.height=i._height,t.extrudedHeight=i._extrudedHeight,t.granularity=i._granularity,t.vertexFormat=m.clone(i._vertexFormat,t.vertexFormat),t.stRotation=i._stRotation,t.shadowVolume=i._shadowVolume,d(o)?(t.semiMajorAxis=i._semiMajorAxis,t.semiMinorAxis=i._semiMinorAxis,o._ellipseGeometry=new l(t),o):(t.radius=i._semiMajorAxis,new n(t))};n.createGeometry=function(e){return l.createGeometry(e._ellipseGeometry)};n.createShadowVolume=function(e,r,o){let i=e._ellipseGeometry._granularity,u=e._ellipseGeometry._ellipsoid,f=r(i,u),x=o(i,u);return new n({center:e._ellipseGeometry._center,radius:e._ellipseGeometry._semiMajorAxis,ellipsoid:u,stRotation:e._ellipseGeometry._stRotation,granularity:i,extrudedHeight:f,height:x,vertexFormat:m.POSITION_ONLY,shadowVolume:!0})};Object.defineProperties(n.prototype,{rectangle:{get:function(){return this._ellipseGeometry.rectangle}},textureCoordinateRotationPoints:{get:function(){return this._ellipseGeometry.textureCoordinateRotationPoints}}});var c=n;function g(e,r){return d(r)&&(e=c.unpack(e,r)),e._ellipseGeometry._center=a.clone(e._ellipseGeometry._center),e._ellipseGeometry._ellipsoid=s.clone(e._ellipseGeometry._ellipsoid),c.createGeometry(e)}var V=g;export{V as default};
