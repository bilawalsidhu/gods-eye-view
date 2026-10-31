- Clamp `viewer.resolutionScale` to the WebGL maximum texture size
  (`Cesium.ContextLimits.maximumTextureSize`) and renderbuffer size on
  high-resolution displays, preventing oversized drawing-buffer allocations.
  The requested scale is restored when the viewport shrinks. Thanks to
  djabhi31 (#940) for the requested/effective scale distinction (VG31OP, #1017).
