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

import{a as c}from"./chunk-S4VBGY2U.js";import{b as t}from"./chunk-G75U3WZT.js";import{e as g}from"./chunk-3THTQ4QB.js";function f(){this.high=c.clone(c.ZERO),this.low=c.clone(c.ZERO)}f.encode=function(n,o){t.typeOf.number("value",n),g(o)||(o={high:0,low:0});let h;return n>=0?(h=Math.floor(n/65536)*65536,o.high=h,o.low=n-h):(h=Math.floor(-n/65536)*65536,o.high=-h,o.low=n+h),o};var e={high:0,low:0};f.fromCartesian=function(n,o){t.typeOf.object("cartesian",n),g(o)||(o=new f);let h=o.high,i=o.low;return f.encode(n.x,e),h.x=e.high,i.x=e.low,f.encode(n.y,e),h.y=e.high,i.y=e.low,f.encode(n.z,e),h.z=e.high,i.z=e.low,o};var m=new f;f.writeElements=function(n,o,h){t.defined("cartesianArray",o),t.typeOf.number("index",h),t.typeOf.number.greaterThanOrEquals("index",h,0),f.fromCartesian(n,m);let i=m.high,w=m.low;o[h]=i.x,o[h+1]=i.y,o[h+2]=i.z,o[h+3]=w.x,o[h+4]=w.y,o[h+5]=w.z};var O=f;export{O as a};
