- Fix rendering stopping for good after a wheel zoom with the pointer on the
  centre of a whole-globe view. Cesium's zoom could ask the camera to rotate
  about a zero axis; that rotation is now ignored, and a render loop stopped by
  any error is restarted from the last drawn camera pose, up to three times in
  ten seconds (mazy1998, #1704).
