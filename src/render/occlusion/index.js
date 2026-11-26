/**
 * @module render/occlusion
 * @description The query port's `occlusionTest` for any WebGL renderer that
 * hands over its frame's depth (`createDepthOcclusionTest`, `DepthSource`).
 */
export { createDepthOcclusionTest, DepthOcclusionProbe } from './depthProbe.js';
