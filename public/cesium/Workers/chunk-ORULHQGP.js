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

import{a as C}from"./chunk-3XRQCEHV.js";import{b as g}from"./chunk-VIWNLE3Z.js";import{e as f}from"./chunk-4TAASUQ2.js";var d=C.EPSILON10;function x(e,r,h,n){if(g.defined("equalsEpsilon",r),!f(e))return;h=h??!1;let c=f(n),l=e.length;if(l<2)return e;let i,s=e[0],o,t,p=0,m=-1;for(i=1;i<l;++i)o=e[i],r(s,o,d)?(f(t)||(t=e.slice(0,i),p=i-1,m=0),c&&n.push(i)):(f(t)&&(t.push(o),p=i,c&&(m=n.length)),s=o);return h&&r(e[0],e[l-1],d)&&(c&&(f(t)?n.splice(m,0,p):n.push(l-1)),f(t)?t.length-=1:t=e.slice(0,-1)),f(t)?t:e}var k=x;export{k as a};
