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

import{a as d}from"./chunk-GQG3G4OP.js";import{a as i}from"./chunk-TODZU3UG.js";import{b as a}from"./chunk-VIWNLE3Z.js";import{e as c}from"./chunk-4TAASUQ2.js";function t(m,n,e){this.minimum=i.clone(m??i.ZERO),this.maximum=i.clone(n??i.ZERO),c(e)?e=i.clone(e):e=i.midpoint(this.minimum,this.maximum,new i),this.center=e}t.fromCorners=function(m,n,e){return a.defined("minimum",m),a.defined("maximum",n),c(e)||(e=new t),e.minimum=i.clone(m,e.minimum),e.maximum=i.clone(n,e.maximum),e.center=i.midpoint(m,n,e.center),e};t.fromPoints=function(m,n){if(c(n)||(n=new t),!c(m)||m.length===0)return n.minimum=i.clone(i.ZERO,n.minimum),n.maximum=i.clone(i.ZERO,n.maximum),n.center=i.clone(i.ZERO,n.center),n;let e=m[0].x,u=m[0].y,o=m[0].z,r=m[0].x,h=m[0].y,l=m[0].z,A=m.length;for(let z=1;z<A;z++){let B=m[z],E=B.x,M=B.y,p=B.z;e=Math.min(E,e),r=Math.max(E,r),u=Math.min(M,u),h=Math.max(M,h),o=Math.min(p,o),l=Math.max(p,l)}let x=n.minimum;x.x=e,x.y=u,x.z=o;let f=n.maximum;return f.x=r,f.y=h,f.z=l,n.center=i.midpoint(x,f,n.center),n};t.clone=function(m,n){if(c(m))return c(n)?(n.minimum=i.clone(m.minimum,n.minimum),n.maximum=i.clone(m.maximum,n.maximum),n.center=i.clone(m.center,n.center),n):new t(m.minimum,m.maximum,m.center)};t.equals=function(m,n){return m===n||c(m)&&c(n)&&i.equals(m.center,n.center)&&i.equals(m.minimum,n.minimum)&&i.equals(m.maximum,n.maximum)};var y=new i;t.intersectPlane=function(m,n){a.defined("box",m),a.defined("plane",n),y=i.subtract(m.maximum,m.minimum,y);let e=i.multiplyByScalar(y,.5,y),u=n.normal,o=e.x*Math.abs(u.x)+e.y*Math.abs(u.y)+e.z*Math.abs(u.z),r=i.dot(m.center,u)+n.distance;return r-o>0?d.INSIDE:r+o<0?d.OUTSIDE:d.INTERSECTING};t.intersectAxisAlignedBoundingBox=function(m,n){return a.defined("box",m),a.defined("other",n),m.minimum.x<=n.maximum.x&&m.maximum.x>=n.minimum.x&&m.minimum.y<=n.maximum.y&&m.maximum.y>=n.minimum.y&&m.minimum.z<=n.maximum.z&&m.maximum.z>=n.minimum.z};t.prototype.clone=function(m){return t.clone(this,m)};t.prototype.intersectPlane=function(m){return t.intersectPlane(this,m)};t.prototype.intersectAxisAlignedBoundingBox=function(m){return t.intersectAxisAlignedBoundingBox(this,m)};t.prototype.equals=function(m){return t.equals(this,m)};var O=t;export{O as a};
