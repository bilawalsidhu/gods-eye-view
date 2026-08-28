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

import{a as O}from"./chunk-JR7WFPVR.js";import{a as I}from"./chunk-4BYMTYMT.js";import{a as m}from"./chunk-34ULWVZF.js";import{a as w}from"./chunk-D5HNP2LB.js";import"./chunk-UCTPWOTZ.js";import"./chunk-54PMPXZ4.js";import{a as A}from"./chunk-R62IKKEC.js";import"./chunk-N3A5CZ2S.js";import"./chunk-G75U3WZT.js";import{d as D,e as d}from"./chunk-3THTQ4QB.js";var b=D(O(),1),o;function F(t,e){let i=t.num_points(),a=t.num_faces(),n=new o.DracoInt32Array,s=a*3,r=m.createTypedArray(i,s),u=0;for(let c=0;c<a;++c)e.GetFaceFromMesh(t,c,n),r[u+0]=n.GetValue(0),r[u+1]=n.GetValue(1),r[u+2]=n.GetValue(2),u+=3;return o.destroy(n),{typedArray:r,numberOfIndices:s}}function U(t,e,i,a,n){let s,r;a.quantizationBits<=8?(r=new o.DracoUInt8Array,s=new Uint8Array(n),e.GetAttributeUInt8ForAllPoints(t,i,r)):a.quantizationBits<=16?(r=new o.DracoUInt16Array,s=new Uint16Array(n),e.GetAttributeUInt16ForAllPoints(t,i,r)):(r=new o.DracoFloat32Array,s=new Float32Array(n),e.GetAttributeFloatForAllPoints(t,i,r));for(let u=0;u<n;++u)s[u]=r.GetValue(u);return o.destroy(r),s}function k(t,e,i,a){let n,s;switch(i.data_type()){case 1:case 11:s=new o.DracoInt8Array,n=new Int8Array(a),e.GetAttributeInt8ForAllPoints(t,i,s);break;case 2:s=new o.DracoUInt8Array,n=new Uint8Array(a),e.GetAttributeUInt8ForAllPoints(t,i,s);break;case 3:s=new o.DracoInt16Array,n=new Int16Array(a),e.GetAttributeInt16ForAllPoints(t,i,s);break;case 4:s=new o.DracoUInt16Array,n=new Uint16Array(a),e.GetAttributeUInt16ForAllPoints(t,i,s);break;case 5:case 7:s=new o.DracoInt32Array,n=new Int32Array(a),e.GetAttributeInt32ForAllPoints(t,i,s);break;case 6:case 8:s=new o.DracoUInt32Array,n=new Uint32Array(a),e.GetAttributeUInt32ForAllPoints(t,i,s);break;case 9:case 10:s=new o.DracoFloat32Array,n=new Float32Array(a),e.GetAttributeFloatForAllPoints(t,i,s);break}for(let r=0;r<a;++r)n[r]=s.GetValue(r);return o.destroy(s),n}function p(t,e,i){let a=t.num_points(),n=i.num_components(),s,r=new o.AttributeQuantizationTransform;if(r.InitFromAttribute(i)){let y=new Array(n);for(let f=0;f<n;++f)y[f]=r.min_value(f);s={quantizationBits:r.quantization_bits(),minValues:y,range:r.range(),octEncoded:!1}}o.destroy(r),r=new o.AttributeOctahedronTransform,r.InitFromAttribute(i)&&(s={quantizationBits:r.quantization_bits(),octEncoded:!0}),o.destroy(r);let u=a*n,c;d(s)?c=U(t,e,i,s,u):c=k(t,e,i,u);let l=w.fromTypedArray(c);return{array:c,data:{componentsPerAttribute:n,componentDatatype:l,byteOffset:i.byte_offset(),byteStride:w.getSizeInBytes(l)*n,normalized:i.normalized(),quantization:s}}}function _(t){let e=new o.Decoder;t.dequantizeInShader&&(e.SkipAttributeTransform(o.POSITION),e.SkipAttributeTransform(o.NORMAL));let i=new o.DecoderBuffer;if(i.Init(t.buffer,t.buffer.length),e.GetEncodedGeometryType(i)!==o.POINT_CLOUD)throw new A("Draco geometry type must be POINT_CLOUD.");let n=new o.PointCloud,s=e.DecodeBufferToPointCloud(i,n);if(!s.ok()||n.ptr===0)throw new A(`Error decoding draco point cloud: ${s.error_msg()}`);o.destroy(i);let r={},u=t.properties;for(let c in u)if(u.hasOwnProperty(c)){let l;if(c==="POSITION"||c==="NORMAL"){let y=e.GetAttributeId(n,o[c]);l=e.GetAttribute(n,y)}else{let y=u[c];l=e.GetAttributeByUniqueId(n,y)}r[c]=p(n,e,l)}return o.destroy(n),o.destroy(e),r}function g(t){let e=new o.Decoder,i=["POSITION","NORMAL","COLOR","TEX_COORD"];if(t.dequantizeInShader)for(let f=0;f<i.length;++f)e.SkipAttributeTransform(o[i[f]]);let a=t.bufferView,n=new o.DecoderBuffer;if(n.Init(t.array,a.byteLength),e.GetEncodedGeometryType(n)!==o.TRIANGULAR_MESH)throw new A("Unsupported draco mesh geometry type.");let r=new o.Mesh,u=e.DecodeBufferToMesh(n,r);if(!u.ok()||r.ptr===0)throw new A(`Error decoding draco mesh geometry: ${u.error_msg()}`);o.destroy(n);let c={},l=t.compressedAttributes;for(let f in l)if(l.hasOwnProperty(f)){let P=l[f],T=e.GetAttributeByUniqueId(r,P);c[f]=p(r,e,T)}let y={indexArray:F(r,e),attributeData:c};return o.destroy(r),o.destroy(e),y}async function z(t,e){return d(t.bufferView)?g(t):_(t)}async function C(t,e){let i=t.webAssemblyConfig;return d(i)&&d(i.wasmBinaryFile)?o=await(0,b.default)(i):o=await(0,b.default)(),!0}async function G(t,e){let i=t.webAssemblyConfig;return d(i)?C(t,e):z(t,e)}var h=I(G);export{h as default};
