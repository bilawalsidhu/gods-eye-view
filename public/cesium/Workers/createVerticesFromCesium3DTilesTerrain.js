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

import{a as u}from"./chunk-KFTRXUKD.js";import"./chunk-OXTEQVCI.js";import"./chunk-TJPKIFSX.js";import{a as f}from"./chunk-BUKMP3AW.js";import"./chunk-ATZCLKEP.js";import"./chunk-5K4QFLQS.js";import"./chunk-KCM7BPUF.js";import"./chunk-4U4JDPPY.js";import"./chunk-D5QCMU6T.js";import"./chunk-JKEOJFWC.js";import"./chunk-FWQONNTL.js";import"./chunk-Z7UZ2XGJ.js";import"./chunk-OXROQHTA.js";import"./chunk-GQG3G4OP.js";import"./chunk-4JSGO3Z7.js";import"./chunk-V62DYOIH.js";import"./chunk-54IT5KT4.js";import"./chunk-E6GK7MVP.js";import"./chunk-YQTAAITT.js";import"./chunk-WV2SHQ7E.js";import"./chunk-TODZU3UG.js";import"./chunk-3XRQCEHV.js";import"./chunk-VIWNLE3Z.js";import"./chunk-4TAASUQ2.js";function a(c,d){return u.createMesh(c).then(function(e){let t=e.vertices.buffer,r=e.indices.buffer,s=e.westIndicesSouthToNorth.buffer,o=e.southIndicesEastToWest.buffer,i=e.eastIndicesNorthToSouth.buffer,n=e.northIndicesWestToEast.buffer;return d.push(t,r,s,o,i,n),{verticesBuffer:t,indicesBuffer:r,vertexCountWithoutSkirts:e.vertexCountWithoutSkirts,indexCountWithoutSkirts:e.indexCountWithoutSkirts,encoding:e.encoding,westIndicesBuffer:s,southIndicesBuffer:o,eastIndicesBuffer:i,northIndicesBuffer:n}})}var T=f(a);export{T as default};
