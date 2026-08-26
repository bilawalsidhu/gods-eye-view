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

import{a as N}from"./chunk-E6GK7MVP.js";import{a}from"./chunk-VIWNLE3Z.js";import{e as T}from"./chunk-4TAASUQ2.js";var r={BYTE:N.BYTE,UNSIGNED_BYTE:N.UNSIGNED_BYTE,SHORT:N.SHORT,UNSIGNED_SHORT:N.UNSIGNED_SHORT,INT:N.INT,UNSIGNED_INT:N.UNSIGNED_INT,FLOAT:N.FLOAT,DOUBLE:N.DOUBLE};r.getSizeInBytes=function(n){if(!T(n))throw new a("value is required.");switch(n){case r.BYTE:return Int8Array.BYTES_PER_ELEMENT;case r.UNSIGNED_BYTE:return Uint8Array.BYTES_PER_ELEMENT;case r.SHORT:return Int16Array.BYTES_PER_ELEMENT;case r.UNSIGNED_SHORT:return Uint16Array.BYTES_PER_ELEMENT;case r.INT:return Int32Array.BYTES_PER_ELEMENT;case r.UNSIGNED_INT:return Uint32Array.BYTES_PER_ELEMENT;case r.FLOAT:return Float32Array.BYTES_PER_ELEMENT;case r.DOUBLE:return Float64Array.BYTES_PER_ELEMENT;default:throw new a("componentDatatype is not a valid value.")}};r.fromTypedArray=function(n){if(n instanceof Int8Array)return r.BYTE;if(n instanceof Uint8Array)return r.UNSIGNED_BYTE;if(n instanceof Int16Array)return r.SHORT;if(n instanceof Uint16Array)return r.UNSIGNED_SHORT;if(n instanceof Int32Array)return r.INT;if(n instanceof Uint32Array)return r.UNSIGNED_INT;if(n instanceof Float32Array)return r.FLOAT;if(n instanceof Float64Array)return r.DOUBLE;throw new a("array must be an Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, or Float64Array.")};r.validate=function(n){return T(n)&&(n===r.BYTE||n===r.UNSIGNED_BYTE||n===r.SHORT||n===r.UNSIGNED_SHORT||n===r.INT||n===r.UNSIGNED_INT||n===r.FLOAT||n===r.DOUBLE)};r.createTypedArray=function(n,e){if(!T(n))throw new a("componentDatatype is required.");if(!T(e))throw new a("valuesOrLength is required.");switch(n){case r.BYTE:return new Int8Array(e);case r.UNSIGNED_BYTE:return new Uint8Array(e);case r.SHORT:return new Int16Array(e);case r.UNSIGNED_SHORT:return new Uint16Array(e);case r.INT:return new Int32Array(e);case r.UNSIGNED_INT:return new Uint32Array(e);case r.FLOAT:return new Float32Array(e);case r.DOUBLE:return new Float64Array(e);default:throw new a("componentDatatype is not a valid value.")}};r.createArrayBufferView=function(n,e,E,t){if(!T(n))throw new a("componentDatatype is required.");if(!T(e))throw new a("buffer is required.");switch(E=E??0,t=t??(e.byteLength-E)/r.getSizeInBytes(n),n){case r.BYTE:return new Int8Array(e,E,t);case r.UNSIGNED_BYTE:return new Uint8Array(e,E,t);case r.SHORT:return new Int16Array(e,E,t);case r.UNSIGNED_SHORT:return new Uint16Array(e,E,t);case r.INT:return new Int32Array(e,E,t);case r.UNSIGNED_INT:return new Uint32Array(e,E,t);case r.FLOAT:return new Float32Array(e,E,t);case r.DOUBLE:return new Float64Array(e,E,t);default:throw new a("componentDatatype is not a valid value.")}};r.fromName=function(n){switch(n){case"BYTE":return r.BYTE;case"UNSIGNED_BYTE":return r.UNSIGNED_BYTE;case"SHORT":return r.SHORT;case"UNSIGNED_SHORT":return r.UNSIGNED_SHORT;case"INT":return r.INT;case"UNSIGNED_INT":return r.UNSIGNED_INT;case"FLOAT":return r.FLOAT;case"DOUBLE":return r.DOUBLE;default:throw new a("name is not a valid value.")}};var A=Object.freeze(r);export{A as a};
