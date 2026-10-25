- Aircraft 3D models (Flights, Military Flights, Local ADS-B) skip Cesium's
  dynamic environment map, a sky render and GPU readback per model. With
  ~150 models in the scene at Atlanta on Google 3D, GPU time per frame at
  rest falls from 14.3-14.8 ms to 12.1-12.5 ms; a same-model comparison
  showed no visible change (quanticsoul4772, #1366).
