- Draw the globe in device pixels on high-DPI screens. The viewer used Cesium's
  browser-recommended resolution, so a 2x screen showed a pixel-doubled 1x frame
  with stair-stepped lines. It now draws at up to 2 device pixels per CSS pixel
  and at most a 4K drawing buffer, with 2x MSAA from ratio 1.5 up. A frame-time
  governor steps the ratio down by 0.25, never below the old 1x, while frames
  run over 20 ms. Each drawing-buffer side stays within the GPU's texture limit,
  below 1x if it must, so large windows on GPUs with a 2048 limit no longer stop
  rendering (#905). DPR 1 screens are otherwise unchanged. Sharpen and the
  pixel-sized styles keep their look; `?maxPixelRatio=1` restores the old
  drawing (jasas1, #1320).
