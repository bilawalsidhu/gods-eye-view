/**
 * Hand control: webcam + MediaPipe Hand Landmarker, entirely in the browser.
 *
 * The runtime, its WASM and the model are served by this app (the model lives
 * in public/models/mediapipe), so nothing is fetched from Google at run time
 * and no video frame leaves the machine. MediaPipe loads only when the person
 * turns hand control on.
 *
 * @module handControl/tracker
 */
import wasmLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';

export const HAND_MODEL_URL = '/models/mediapipe/hand_landmarker.task';

/** Detection rate cap: enough for smooth control, light on the GPU. */
const MIN_FRAME_MS = 1000 / 30;

/**
 * Typed failure so the panel can say what went wrong.
 * `code`: 'denied' | 'no-camera' | 'model' | 'unsupported'.
 */
export class HandTrackerError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.code = code;
    this.cause = cause;
  }
}

async function createLandmarker() {
  const vision = await import('@mediapipe/tasks-vision');
  const fileset = {
    wasmLoaderPath: wasmLoaderUrl,
    wasmBinaryPath: wasmBinaryUrl,
  };
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.6,
    minHandPresenceConfidence: 0.6,
    minTrackingConfidence: 0.5,
  });
  try {
    return await vision.HandLandmarker.createFromOptions(
      fileset,
      options('GPU'),
    );
  } catch {
    // Some drivers refuse the WebGL delegate; the CPU path is slower but works.
    return vision.HandLandmarker.createFromOptions(fileset, options('CPU'));
  }
}

/**
 * Start the webcam and the landmarker.
 * @param {{video: HTMLVideoElement, onFrame: (hands: {key:string, landmarks:object[]}[], tMs:number, aspect:number) => void}} options
 * @returns {Promise<{stop: () => void}>}
 */
export async function startHandTracker({ video, onFrame }) {
  if (!navigator.mediaDevices?.getUserMedia)
    throw new HandTrackerError('unsupported', 'getUserMedia unavailable');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        facingMode: 'user',
      },
      audio: false,
    });
  } catch (error) {
    const code =
      error?.name === 'NotAllowedError' || error?.name === 'SecurityError'
        ? 'denied'
        : 'no-camera';
    throw new HandTrackerError(code, error?.message || code, error);
  }
  const stopStream = () => stream.getTracks().forEach((track) => track.stop());
  let landmarker;
  try {
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    landmarker = await createLandmarker();
  } catch (error) {
    stopStream();
    video.srcObject = null;
    throw new HandTrackerError('model', error?.message || 'model', error);
  }

  let stopped = false;
  let frame = 0;
  let lastRun = 0;
  let lastVideoTime = -1;
  const loop = (now) => {
    if (stopped) return;
    frame = requestAnimationFrame(loop);
    if (now - lastRun < MIN_FRAME_MS) return;
    if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
    lastRun = now;
    lastVideoTime = video.currentTime;
    let result;
    try {
      result = landmarker.detectForVideo(video, now);
    } catch {
      return; // a dropped frame; the next one retries
    }
    const hands = (result.landmarks || []).map((landmarks, i) => ({
      key: result.handedness?.[i]?.[0]?.categoryName || `hand${i}`,
      landmarks,
    }));
    const aspect =
      video.videoWidth && video.videoHeight
        ? video.videoWidth / video.videoHeight
        : 4 / 3;
    onFrame(hands, now, aspect);
  };
  frame = requestAnimationFrame(loop);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(frame);
      stopStream();
      video.srcObject = null;
      try {
        landmarker.close();
      } catch {
        /* already closed */
      }
    },
  };
}
