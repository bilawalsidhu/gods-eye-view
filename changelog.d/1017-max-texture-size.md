- Clamp `viewer.resolutionScale` to the WebGL maximum texture size
  (`Cesium.ContextLimits.maximumTextureSize`) on high-resolution (2K/4K) and
  fullscreen displays, preventing GlobeDepth and framebuffer texture allocation
  crashes. The requested scale is kept separately and restored when the
  viewport shrinks; code that changes the scale should save and set
  `viewer.requestedResolutionScale`. Thanks to djabhi31 (#940) for separating
  requested and effective scale (VG31OP, #1017).
