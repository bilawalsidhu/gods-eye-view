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

import{a as h}from"./chunk-SOCYD7RP.js";import{a as n,c as y,e as a}from"./chunk-S4VBGY2U.js";import{b as f}from"./chunk-G75U3WZT.js";var x={},b=new n,P=new n,B=new n,M=new n,w=new h;x.validOutline=function(i){f.defined("positions",i);let o=h.fromPoints(i,w).halfAxes,e=a.getColumn(o,0,P),r=a.getColumn(o,1,B),t=a.getColumn(o,2,M),u=n.magnitude(e),s=n.magnitude(r),l=n.magnitude(t);return!(u===0&&(s===0||l===0)||s===0&&l===0)};x.computeProjectTo2DArguments=function(i,c,o,e){f.defined("positions",i),f.defined("centerResult",c),f.defined("planeAxis1Result",o),f.defined("planeAxis2Result",e);let r=h.fromPoints(i,w),t=r.halfAxes,u=a.getColumn(t,0,P),s=a.getColumn(t,1,B),l=a.getColumn(t,2,M),A=n.magnitude(u),d=n.magnitude(s),g=n.magnitude(l),m=Math.min(A,d,g);if(A===0&&(d===0||g===0)||d===0&&g===0)return!1;let p,C;return(m===d||m===g)&&(p=u),m===A?p=s:m===g&&(C=s),(m===A||m===d)&&(C=l),n.normalize(p,o),n.normalize(C,e),n.clone(r.center,c),!0};function z(i,c,o,e,r){let t=n.subtract(i,c,b),u=n.dot(o,t),s=n.dot(e,t);return y.fromElements(u,s,r)}x.createProjectPointsTo2DFunction=function(i,c,o){return function(e){let r=new Array(e.length);for(let t=0;t<e.length;t++)r[t]=z(e[t],i,c,o);return r}};x.createProjectPointTo2DFunction=function(i,c,o){return function(e,r){return z(e,i,c,o,r)}};var O=x;export{O as a};
