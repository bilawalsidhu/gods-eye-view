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

import{a as C}from"./chunk-UCTPWOTZ.js";import{a as g}from"./chunk-N3A5CZ2S.js";import{b as d}from"./chunk-G75U3WZT.js";import{e as i}from"./chunk-3THTQ4QB.js";var u=C.EPSILON10;function x(e,r,h,l){if(d.defined("equalsEpsilon",r),!i(e))return;h=g(h,!1);let m=i(l),n=e.length;if(n<2)return e;let f,s=e[0],o,t,p=0,c=-1;for(f=1;f<n;++f)o=e[f],r(s,o,u)?(i(t)||(t=e.slice(0,f),p=f-1,c=0),m&&l.push(f)):(i(t)&&(t.push(o),p=f,m&&(c=l.length)),s=o);return h&&r(e[0],e[n-1],u)&&(m&&(i(t)?l.splice(c,0,p):l.push(n-1)),i(t)?t.length-=1:t=e.slice(0,-1)),i(t)?t:e}var a=x;export{a};
