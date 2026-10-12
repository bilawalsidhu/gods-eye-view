/** Classical local filter only. Work on a copy and yield so Cancel can interrupt. */
export async function enhanceSnapshotPixels(
  source,
  width,
  height,
  {
    signal,
    progress = () => {},
    yieldTask = () => new Promise((resolve) => setTimeout(resolve, 0)),
  } = {},
) {
  const pixels = new Uint8ClampedArray(source);
  const canceled = () => {
    if (signal?.aborted)
      throw Object.assign(new Error('Local enhancement canceled'), {
        name: 'AbortError',
      });
  };
  canceled();
  await yieldTask();
  canceled();
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = (y * width + x) * 4;
      for (let k = 0; k < 3; k++) {
        const sharp =
          1.8 * source[i + k] -
          0.2 *
            (source[i - 4 + k] +
              source[i + 4 + k] +
              source[i - width * 4 + k] +
              source[i + width * 4 + k]);
        pixels[i + k] = (sharp - 128) * 1.15 + 128;
      }
    }
    if (y % 24 === 0) {
      progress(Math.round((y / height) * 100));
      await yieldTask();
      canceled();
    }
  }
  canceled();
  progress(100);
  return pixels;
}
