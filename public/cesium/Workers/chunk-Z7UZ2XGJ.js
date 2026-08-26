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

import{a as N}from"./chunk-E6GK7MVP.js";import{a}from"./chunk-3XRQCEHV.js";import{a as t}from"./chunk-VIWNLE3Z.js";import{e as i}from"./chunk-4TAASUQ2.js";var r={UNSIGNED_BYTE:N.UNSIGNED_BYTE,UNSIGNED_SHORT:N.UNSIGNED_SHORT,UNSIGNED_INT:N.UNSIGNED_INT};r.getSizeInBytes=function(e){switch(e){case r.UNSIGNED_BYTE:return Uint8Array.BYTES_PER_ELEMENT;case r.UNSIGNED_SHORT:return Uint16Array.BYTES_PER_ELEMENT;case r.UNSIGNED_INT:return Uint32Array.BYTES_PER_ELEMENT}throw new t("indexDatatype is required and must be a valid IndexDatatype constant.")};r.fromSizeInBytes=function(e){switch(e){case 2:return r.UNSIGNED_SHORT;case 4:return r.UNSIGNED_INT;case 1:return r.UNSIGNED_BYTE;default:throw new t("Size in bytes cannot be mapped to an IndexDatatype")}};r.validate=function(e){return i(e)&&(e===r.UNSIGNED_BYTE||e===r.UNSIGNED_SHORT||e===r.UNSIGNED_INT)};r.createTypedArray=function(e,n){if(!i(e))throw new t("numberOfVertices is required.");return e>=a.SIXTY_FOUR_KILOBYTES?new Uint32Array(n):new Uint16Array(n)};r.createTypedArrayFromArrayBuffer=function(e,n,E,o){if(!i(e))throw new t("numberOfVertices is required.");if(!i(n))throw new t("sourceArray is required.");if(!i(E))throw new t("byteOffset is required.");return e>=a.SIXTY_FOUR_KILOBYTES?new Uint32Array(n,E,o):new Uint16Array(n,E,o)};r.fromTypedArray=function(e){if(e instanceof Uint8Array)return r.UNSIGNED_BYTE;if(e instanceof Uint16Array)return r.UNSIGNED_SHORT;if(e instanceof Uint32Array)return r.UNSIGNED_INT;throw new t("array must be a Uint8Array, Uint16Array, or Uint32Array.")};var u=Object.freeze(r);export{u as a};
