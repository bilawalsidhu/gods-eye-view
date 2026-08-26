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

import{a as g}from"./chunk-OXROQHTA.js";import{a as d}from"./chunk-GQG3G4OP.js";import{j as x}from"./chunk-4JSGO3Z7.js";import{a as p,b as M,c as O}from"./chunk-WV2SHQ7E.js";import{b as m}from"./chunk-VIWNLE3Z.js";import{e as f}from"./chunk-4TAASUQ2.js";function n(i,h,o,t){this.x=i??0,this.y=h??0,this.width=o??0,this.height=t??0}n.packedLength=4;n.pack=function(i,h,o){return m.typeOf.object("value",i),m.defined("array",h),o=o??0,h[o++]=i.x,h[o++]=i.y,h[o++]=i.width,h[o]=i.height,h};n.unpack=function(i,h,o){return m.defined("array",i),h=h??0,f(o)||(o=new n),o.x=i[h++],o.y=i[h++],o.width=i[h++],o.height=i[h],o};n.fromPoints=function(i,h){if(f(h)||(h=new n),!f(i)||i.length===0)return h.x=0,h.y=0,h.width=0,h.height=0,h;let o=i.length,t=i[0].x,c=i[0].y,e=i[0].x,w=i[0].y;for(let y=1;y<o;y++){let R=i[y],b=R.x,j=R.y;t=Math.min(b,t),e=Math.max(b,e),c=Math.min(j,c),w=Math.max(j,w)}return h.x=t,h.y=c,h.width=e-t,h.height=w-c,h};var L=new g,X=new p,Y=new p;n.fromRectangle=function(i,h,o){if(f(o)||(o=new n),!f(i))return o.x=0,o.y=0,o.width=0,o.height=0,o;L._ellipsoid=O.default,h=h??L;let t=h.project(x.southwest(i,X)),c=h.project(x.northeast(i,Y));return M.subtract(c,t,c),o.x=t.x,o.y=t.y,o.width=c.x,o.height=c.y,o};n.clone=function(i,h){if(f(i))return f(h)?(h.x=i.x,h.y=i.y,h.width=i.width,h.height=i.height,h):new n(i.x,i.y,i.width,i.height)};n.union=function(i,h,o){m.typeOf.object("left",i),m.typeOf.object("right",h),f(o)||(o=new n);let t=Math.min(i.x,h.x),c=Math.min(i.y,h.y),e=Math.max(i.x+i.width,h.x+h.width),w=Math.max(i.y+i.height,h.y+h.height);return o.x=t,o.y=c,o.width=e-t,o.height=w-c,o};n.expand=function(i,h,o){m.typeOf.object("rectangle",i),m.typeOf.object("point",h),o=n.clone(i,o);let t=h.x-o.x,c=h.y-o.y;return t>o.width?o.width=t:t<0&&(o.width-=t,o.x=h.x),c>o.height?o.height=c:c<0&&(o.height-=c,o.y=h.y),o};n.intersect=function(i,h){m.typeOf.object("left",i),m.typeOf.object("right",h);let o=i.x,t=i.y,c=h.x,e=h.y;return o>c+h.width||o+i.width<c||t+i.height<e||t>e+h.height?d.OUTSIDE:d.INTERSECTING};n.equals=function(i,h){return i===h||f(i)&&f(h)&&i.x===h.x&&i.y===h.y&&i.width===h.width&&i.height===h.height};n.prototype.clone=function(i){return n.clone(this,i)};n.prototype.intersect=function(i){return n.intersect(this,i)};n.prototype.equals=function(i){return n.equals(this,i)};var S=n;export{S as a};
