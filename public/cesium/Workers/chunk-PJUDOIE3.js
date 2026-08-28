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

import{a as L,b as x}from"./chunk-K2M3OJ7Z.js";import{h as R}from"./chunk-M3A6SPGI.js";import{b as d,c as O,d as g}from"./chunk-S4VBGY2U.js";import{a as w}from"./chunk-N3A5CZ2S.js";import{b as m}from"./chunk-G75U3WZT.js";import{e as f}from"./chunk-3THTQ4QB.js";function t(i,h,o,n){this.x=w(i,0),this.y=w(h,0),this.width=w(o,0),this.height=w(n,0)}t.packedLength=4;t.pack=function(i,h,o){return m.typeOf.object("value",i),m.defined("array",h),o=w(o,0),h[o++]=i.x,h[o++]=i.y,h[o++]=i.width,h[o]=i.height,h};t.unpack=function(i,h,o){return m.defined("array",i),h=w(h,0),f(o)||(o=new t),o.x=i[h++],o.y=i[h++],o.width=i[h++],o.height=i[h],o};t.fromPoints=function(i,h){if(f(h)||(h=new t),!f(i)||i.length===0)return h.x=0,h.y=0,h.width=0,h.height=0,h;let o=i.length,n=i[0].x,c=i[0].y,e=i[0].x,y=i[0].y;for(let p=1;p<o;p++){let b=i[p],j=b.x,M=b.y;n=Math.min(j,n),e=Math.max(j,e),c=Math.min(M,c),y=Math.max(M,y)}return h.x=n,h.y=c,h.width=e-n,h.height=y-c,h};var X=new L,Y=new d,k=new d;t.fromRectangle=function(i,h,o){if(f(o)||(o=new t),!f(i))return o.x=0,o.y=0,o.width=0,o.height=0,o;X._ellipsoid=g.default,h=w(h,X);let n=h.project(R.southwest(i,Y)),c=h.project(R.northeast(i,k));return O.subtract(c,n,c),o.x=n.x,o.y=n.y,o.width=c.x,o.height=c.y,o};t.clone=function(i,h){if(f(i))return f(h)?(h.x=i.x,h.y=i.y,h.width=i.width,h.height=i.height,h):new t(i.x,i.y,i.width,i.height)};t.union=function(i,h,o){m.typeOf.object("left",i),m.typeOf.object("right",h),f(o)||(o=new t);let n=Math.min(i.x,h.x),c=Math.min(i.y,h.y),e=Math.max(i.x+i.width,h.x+h.width),y=Math.max(i.y+i.height,h.y+h.height);return o.x=n,o.y=c,o.width=e-n,o.height=y-c,o};t.expand=function(i,h,o){m.typeOf.object("rectangle",i),m.typeOf.object("point",h),o=t.clone(i,o);let n=h.x-o.x,c=h.y-o.y;return n>o.width?o.width=n:n<0&&(o.width-=n,o.x=h.x),c>o.height?o.height=c:c<0&&(o.height-=c,o.y=h.y),o};t.intersect=function(i,h){m.typeOf.object("left",i),m.typeOf.object("right",h);let o=i.x,n=i.y,c=h.x,e=h.y;return o>c+h.width||o+i.width<c||n+i.height<e||n>e+h.height?x.OUTSIDE:x.INTERSECTING};t.equals=function(i,h){return i===h||f(i)&&f(h)&&i.x===h.x&&i.y===h.y&&i.width===h.width&&i.height===h.height};t.prototype.clone=function(i){return t.clone(this,i)};t.prototype.intersect=function(i){return t.intersect(this,i)};t.prototype.equals=function(i){return t.equals(this,i)};var a=t;export{a};
