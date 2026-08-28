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

import{b as d}from"./chunk-K2M3OJ7Z.js";import{a as i}from"./chunk-S4VBGY2U.js";import{a as z}from"./chunk-N3A5CZ2S.js";import{b as r}from"./chunk-G75U3WZT.js";import{e as c}from"./chunk-3THTQ4QB.js";function t(m,n,e){this.minimum=i.clone(z(m,i.ZERO)),this.maximum=i.clone(z(n,i.ZERO)),c(e)?e=i.clone(e):e=i.midpoint(this.minimum,this.maximum,new i),this.center=e}t.fromCorners=function(m,n,e){return r.defined("minimum",m),r.defined("maximum",n),c(e)||(e=new t),e.minimum=i.clone(m,e.minimum),e.maximum=i.clone(n,e.maximum),e.center=i.midpoint(m,n,e.center),e};t.fromPoints=function(m,n){if(c(n)||(n=new t),!c(m)||m.length===0)return n.minimum=i.clone(i.ZERO,n.minimum),n.maximum=i.clone(i.ZERO,n.maximum),n.center=i.clone(i.ZERO,n.center),n;let e=m[0].x,a=m[0].y,u=m[0].z,o=m[0].x,y=m[0].y,l=m[0].z,I=m.length;for(let E=1;E<I;E++){let M=m[E],p=M.x,Z=M.y,q=M.z;e=Math.min(p,e),o=Math.max(p,o),a=Math.min(Z,a),y=Math.max(Z,y),u=Math.min(q,u),l=Math.max(q,l)}let f=n.minimum;f.x=e,f.y=a,f.z=u;let x=n.maximum;return x.x=o,x.y=y,x.z=l,n.center=i.midpoint(f,x,n.center),n};t.clone=function(m,n){if(c(m))return c(n)?(n.minimum=i.clone(m.minimum,n.minimum),n.maximum=i.clone(m.maximum,n.maximum),n.center=i.clone(m.center,n.center),n):new t(m.minimum,m.maximum,m.center)};t.equals=function(m,n){return m===n||c(m)&&c(n)&&i.equals(m.center,n.center)&&i.equals(m.minimum,n.minimum)&&i.equals(m.maximum,n.maximum)};var h=new i;t.intersectPlane=function(m,n){r.defined("box",m),r.defined("plane",n),h=i.subtract(m.maximum,m.minimum,h);let e=i.multiplyByScalar(h,.5,h),a=n.normal,u=e.x*Math.abs(a.x)+e.y*Math.abs(a.y)+e.z*Math.abs(a.z),o=i.dot(m.center,a)+n.distance;return o-u>0?d.INSIDE:o+u<0?d.OUTSIDE:d.INTERSECTING};t.prototype.clone=function(m){return t.clone(this,m)};t.prototype.intersectPlane=function(m){return t.intersectPlane(this,m)};t.prototype.equals=function(m){return t.equals(this,m)};var P=t;export{P as a};
