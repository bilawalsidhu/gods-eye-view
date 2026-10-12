/** Explicit single-image API port; credential remains in the existing server. */
export async function cameraImageCapability(signal) {
  const response = await fetch('/api/openai/camera-image', {
    signal,
    cache: 'no-store',
  });
  const status = await response.json();
  if (!response.ok || !status.available)
    return {
      model: 'Unavailable',
      error: status.error || 'OpenAI image capability could not be verified.',
    };
  return {
    model: status.model,
    reasoning: status.reasoning,
    warning: status.warning,
    access: status.access,
    async ask({ original, question, marks, focus, selectedRegion, signal }) {
      const image = original.toDataURL('image/png');
      if (image.length > 7 * 1024 * 1024)
        throw new Error(
          'Original PNG is too large for the bounded image request. Save it locally instead.',
        );
      const response = await fetch('/api/openai/camera-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          provider: 'OpenAI',
          confirmOriginal: true,
          model: status.model,
          image,
          question,
          marks,
          focus,
          selectedRegion,
        }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || 'OpenAI image Q&A failed.');
      return data.answer;
    },
  };
}
