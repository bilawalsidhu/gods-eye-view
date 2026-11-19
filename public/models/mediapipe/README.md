# MediaPipe Hand Landmarker

`hand_landmarker.task` is Google's MediaPipe Hand Landmarker model (float16,
version 1), downloaded unchanged from
`https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`.

- License: [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0),
  © Google LLC. See the
  [MediaPipe model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20(Lite_Full)%20with%20Fairness%20Oct%202021.pdf).
- Used by: `src/handControl/tracker.js` (UTILITIES ▸ Hands). The model runs in
  the browser through `@mediapipe/tasks-vision`; it is served by the app so
  hand control works offline and no webcam frame is sent anywhere.
- SHA-256: `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`
