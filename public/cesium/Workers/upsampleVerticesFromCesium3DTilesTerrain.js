/**
 * @license
 * Cesium - https://github.com/CesiumGS/cesium
 * Version 1.144.0
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

import{a as f}from"./chunk-HD7DLRTB.js";import"./chunk-E2XJEVRT.js";import"./chunk-DDOE447E.js";import{a as u}from"./chunk-RCKN2G6K.js";import"./chunk-ZBAXXYBT.js";import"./chunk-PQTWLWR6.js";import"./chunk-SXFPISI4.js";import"./chunk-HCBOUAOS.js";import"./chunk-LXB5W3RT.js";import"./chunk-Q2AGSIFJ.js";import"./chunk-4XQS6KUO.js";import"./chunk-CVUC3Z4F.js";import"./chunk-VPJRLZMB.js";import"./chunk-635BMVFD.js";import"./chunk-Y7Z6CVXH.js";import"./chunk-HHFPYI7Q.js";import"./chunk-SSZI3JCE.js";import"./chunk-LP5YXEIX.js";import"./chunk-AMKKUAL3.js";import"./chunk-WORPNHJT.js";import"./chunk-SWCW4GSU.js";import"./chunk-PZM5FOOW.js";import"./chunk-3MNKUQ6L.js";import"./chunk-J4SK6SKL.js";function h(c,d){let e=f.upsampleMesh(c),t=e.vertices.buffer,i=e.indices.buffer,s=e.westIndicesSouthToNorth.buffer,o=e.southIndicesEastToWest.buffer,r=e.eastIndicesNorthToSouth.buffer,n=e.northIndicesWestToEast.buffer;return d.push(t,i,s,o,r,n),{verticesBuffer:t,indicesBuffer:i,vertexCountWithoutSkirts:e.vertexCountWithoutSkirts,indexCountWithoutSkirts:e.indexCountWithoutSkirts,encoding:e.encoding,westIndicesBuffer:s,southIndicesBuffer:o,eastIndicesBuffer:r,northIndicesBuffer:n,minimumHeight:e.minimumHeight,maximumHeight:e.maximumHeight,boundingSphere:e.boundingSphere3D,orientedBoundingBox:e.orientedBoundingBox,horizonOcclusionPoint:e.horizonOcclusionPoint}}var I=u(h);export{I as default};
