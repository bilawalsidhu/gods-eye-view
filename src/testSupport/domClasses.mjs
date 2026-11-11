/** Browser classes used by rendering-library instanceof checks in Node tests. */
export function installDomClasses(t) {
  for (const name of [
    'HTMLCanvasElement',
    'HTMLImageElement',
    'HTMLVideoElement',
    'ImageBitmap',
    'OffscreenCanvas',
  ]) {
    if (name in globalThis) continue;
    globalThis[name] = class {};
    t?.after(() => delete globalThis[name]);
  }
}
