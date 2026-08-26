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

import{a as k}from"./chunk-Z7UZ2XGJ.js";import{a as T}from"./chunk-3XRQCEHV.js";import{a as d}from"./chunk-VIWNLE3Z.js";import{e as E}from"./chunk-4TAASUQ2.js";function a(){d.throwInstantiationError()}Object.defineProperties(a.prototype,{errorEvent:{get:d.throwInstantiationError},credit:{get:d.throwInstantiationError},tilingScheme:{get:d.throwInstantiationError},hasWaterMask:{get:d.throwInstantiationError},hasVertexNormals:{get:d.throwInstantiationError},availability:{get:d.throwInstantiationError}});var b=[];a.getRegularGridIndices=function(t,n){if(t*n>=T.FOUR_GIGABYTES)throw new d("The total number of vertices (width * height) must be less than 4,294,967,296.");let r=b[t];E(r)||(b[t]=r=[]);let e=r[n];return E(e)||(t*n<T.SIXTY_FOUR_KILOBYTES?e=r[n]=new Uint16Array((t-1)*(n-1)*6):e=r[n]=new Uint32Array((t-1)*(n-1)*6),v(t,n,e,0)),e};var N=[];a.getRegularGridIndicesAndEdgeIndices=function(t,n){if(t*n>=T.FOUR_GIGABYTES)throw new d("The total number of vertices (width * height) must be less than 4,294,967,296.");let r=N[t];E(r)||(N[t]=r=[]);let e=r[n];if(!E(e)){let i=a.getRegularGridIndices(t,n),s=w(t,n),o=s.westIndicesSouthToNorth,c=s.southIndicesEastToWest,I=s.eastIndicesNorthToSouth,u=s.northIndicesWestToEast;e=r[n]={indices:i,westIndicesSouthToNorth:o,southIndicesEastToWest:c,eastIndicesNorthToSouth:I,northIndicesWestToEast:u}}return e};var R=[];a.getRegularGridAndSkirtIndicesAndEdgeIndices=function(t,n){if(t*n>=T.FOUR_GIGABYTES)throw new d("The total number of vertices (width * height) must be less than 4,294,967,296.");let r=R[t];E(r)||(R[t]=r=[]);let e=r[n];if(!E(e)){let i=t*n,s=(t-1)*(n-1)*6,o=t*2+n*2,c=Math.max(0,o-4)*6,I=i+o,u=s+c,l=w(t,n),h=l.westIndicesSouthToNorth,x=l.southIndicesEastToWest,m=l.eastIndicesNorthToSouth,S=l.northIndicesWestToEast,g=k.createTypedArray(I,u);v(t,n,g,0),a.addSkirtIndices(h,x,m,S,i,g,s),e=r[n]={indices:g,westIndicesSouthToNorth:h,southIndicesEastToWest:x,eastIndicesNorthToSouth:m,northIndicesWestToEast:S,indexCountWithoutSkirts:s}}return e};a.getSkirtVertexCount=function(t,n,r,e){return t.length+n.length+r.length+e.length};a.getSkirtIndexCount=function(t){return(t-4)*2*3};a.getSkirtIndexCountWithFilledCorners=function(t){return((t-4)*2+4)*3};a.addSkirtIndices=function(t,n,r,e,i,s,o){let c=i;o=p(t,c,s,o),c+=t.length,o=p(n,c,s,o),c+=n.length,o=p(r,c,s,o),c+=r.length,p(e,c,s,o)};a.addSkirtIndicesWithFilledCorners=function(t,n,r,e,i,s,o){a.addSkirtIndices(t,n,r,e,i,s,o);let c=a.getSkirtVertexCount(t,n,r,e),I=a.getSkirtIndexCount(c),u=o+I,l=t[0],h=e[0],x=r[0],m=n[0],S=i,g=S+t.length-1,y=g+1,A=y+n.length-1,W=A+1,C=W+r.length-1,G=C+1,F=G+e.length-1;s[u+0]=l,s[u+1]=S,s[u+2]=A,s[u+3]=m,s[u+4]=y,s[u+5]=C,s[u+6]=x,s[u+7]=W,s[u+8]=F,s[u+9]=h,s[u+10]=G,s[u+11]=g};function w(t,n){let r=new Array(n),e=new Array(t),i=new Array(n),s=new Array(t),o;for(o=0;o<t;++o)s[o]=o,e[o]=t*n-1-o;for(o=0;o<n;++o)i[o]=(o+1)*t-1,r[o]=(n-o-1)*t;return{westIndicesSouthToNorth:r,southIndicesEastToWest:e,eastIndicesNorthToSouth:i,northIndicesWestToEast:s}}function v(t,n,r,e){let i=0;for(let s=0;s<n-1;++s){for(let o=0;o<t-1;++o){let c=i,I=c+t,u=I+1,l=c+1;r[e++]=c,r[e++]=I,r[e++]=l,r[e++]=l,r[e++]=I,r[e++]=u,++i}++i}}function p(t,n,r,e){let i=t[0],s=t.length;for(let o=1;o<s;++o){let c=t[o];r[e++]=i,r[e++]=c,r[e++]=n,r[e++]=n,r[e++]=c,r[e++]=n+1,i=c,++n}return e}a.heightmapTerrainQuality=.25;a.getEstimatedLevelZeroGeometricErrorForAHeightmap=function(t,n,r){return t.maximumRadius*2*Math.PI*a.heightmapTerrainQuality/(n*r)};a.prototype.requestTileGeometry=d.throwInstantiationError;a.prototype.getLevelMaximumGeometricError=d.throwInstantiationError;a.prototype.getTileDataAvailable=d.throwInstantiationError;a.prototype.loadTileDataAvailability=d.throwInstantiationError;var M=a;export{M as a};
