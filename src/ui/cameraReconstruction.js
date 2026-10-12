/** Provider-neutral explicit generation; no automatic send or credential setup. */
export async function cameraReconstructionCapability(signal) {
  const response = await fetch('/api/camera-reconstruction', {
      signal,
      cache: 'no-store',
    }),
    status = await response.json();
  if (!response.ok || !status.available)
    return {
      ...status,
      available: false,
      error: status.error || 'AI reconstruction provider is not ready.',
    };
  return {
    ...status,
    async generate({ sourceImage, scope, note, cameraId, signal }) {
      const image = sourceImage.toDataURL('image/png');
      if (image.length > 8 * 1024 * 1024)
        throw Error('Original input is too large. Save it locally instead.');
      const response = await fetch('/api/camera-reconstruction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          confirmReconstruction: true,
          provider: status.provider,
          model: status.model,
          scope,
          note,
          sourceImage: image,
          cameraId,
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw Error(result.error || 'AI reconstruction failed.');
      return result;
    },
  };
}
