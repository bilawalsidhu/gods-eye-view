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

import{a as w}from"./chunk-3XRQCEHV.js";var C={};C.computePositions=function(I,f,b,n,e){let m=I*.5,i=-m,s=n+n,P=e?2*s:s,t=new Float64Array(P*3),r,c=0,o=0,p=e?s*3:0,a=e?(s+n)*3:n*3;for(r=0;r<n;r++){let y=r/n*w.TWO_PI,x=Math.cos(y),h=Math.sin(y),u=x*b,M=h*b,O=x*f,d=h*f;t[o+p]=u,t[o+p+1]=M,t[o+p+2]=i,t[o+a]=O,t[o+a+1]=d,t[o+a+2]=m,o+=3,e&&(t[c++]=u,t[c++]=M,t[c++]=i,t[c++]=O,t[c++]=d,t[c++]=m)}return t};var Y=C;export{Y as a};
