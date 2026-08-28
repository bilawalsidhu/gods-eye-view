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

import{a as l,b as d}from"./chunk-M3A6SPGI.js";import{a as t}from"./chunk-S4VBGY2U.js";import{a as s}from"./chunk-UCTPWOTZ.js";import{a as f,b as r}from"./chunk-G75U3WZT.js";import{e as m}from"./chunk-3THTQ4QB.js";function o(e,n){if(r.typeOf.object("normal",e),!s.equalsEpsilon(t.magnitude(e),1,s.EPSILON6))throw new f("normal must be normalized.");r.typeOf.number("distance",n),this.normal=t.clone(e),this.distance=n}o.fromPointNormal=function(e,n,a){if(r.typeOf.object("point",e),r.typeOf.object("normal",n),!s.equalsEpsilon(t.magnitude(n),1,s.EPSILON6))throw new f("normal must be normalized.");let c=-t.dot(n,e);return m(a)?(t.clone(n,a.normal),a.distance=c,a):new o(n,c)};var b=new t;o.fromCartesian4=function(e,n){r.typeOf.object("coefficients",e);let a=t.fromCartesian4(e,b),c=e.w;if(!s.equalsEpsilon(t.magnitude(a),1,s.EPSILON6))throw new f("normal must be normalized.");return m(n)?(t.clone(a,n.normal),n.distance=c,n):new o(a,c)};o.getPointDistance=function(e,n){return r.typeOf.object("plane",e),r.typeOf.object("point",n),t.dot(e.normal,n)+e.distance};var y=new t;o.projectPointOntoPlane=function(e,n,a){r.typeOf.object("plane",e),r.typeOf.object("point",n),m(a)||(a=new t);let c=o.getPointDistance(e,n),p=t.multiplyByScalar(e.normal,c,y);return t.subtract(n,p,a)};var w=new d,j=new l,N=new t;o.transform=function(e,n,a){r.typeOf.object("plane",e),r.typeOf.object("transform",n);let c=e.normal,p=e.distance,u=d.inverseTranspose(n,w),i=l.fromElements(c.x,c.y,c.z,p,j);i=d.multiplyByVector(u,i,i);let O=t.fromCartesian4(i,N);return i=l.divideByScalar(i,t.magnitude(O),i),o.fromCartesian4(i,a)};o.clone=function(e,n){return r.typeOf.object("plane",e),m(n)?(t.clone(e.normal,n.normal),n.distance=e.distance,n):new o(e.normal,e.distance)};o.equals=function(e,n){return r.typeOf.object("left",e),r.typeOf.object("right",n),e.distance===n.distance&&t.equals(e.normal,n.normal)};o.ORIGIN_XY_PLANE=Object.freeze(new o(t.UNIT_Z,0));o.ORIGIN_YZ_PLANE=Object.freeze(new o(t.UNIT_X,0));o.ORIGIN_ZX_PLANE=Object.freeze(new o(t.UNIT_Y,0));var T=o;export{T as a};
