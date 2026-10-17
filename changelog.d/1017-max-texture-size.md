- Clamp `viewer.resolutionScale` to the WebGL context's maximum texture size
  (`Cesium.ContextLimits.maximumTextureSize`) on high-resolution (2K/4K) and fullscreen
  displays, preventing GlobeDepth and framebuffer texture allocation crashes.
  Preserves requested scaling when the viewport shrinks. Thanks to
  [xiehuanyi](https://github.com/xiehuanyi) (#940) for separating requested and effective scale (#1017).
