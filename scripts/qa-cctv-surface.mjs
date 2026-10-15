/** Evaluate the CCTV sampling contract for the surface actually being rendered. */
export function groundSamplingContract({
  globeVisible,
  tilesReady,
  sampleDelta,
  requirePhotoreal = false,
}) {
  if (globeVisible !== false) {
    if (requirePhotoreal) {
      return {
        name: 'required photoreal surface is active',
        ok: false,
        detail:
          'A terrain globe is active; select a visible 3D tileset before photoreal sign-off.',
      };
    }
    return {
      name: 'terrain-globe uses its ground prior without 3D mesh queries',
      ok: sampleDelta === 0,
      detail: `real mesh samples since enable=${sampleDelta}; terrain-globe requires zero`,
    };
  }
  return {
    name: '>=1 real ground sample once visible tiles loaded (one-shot snap completed)',
    ok: tilesReady ? sampleDelta >= 1 : requirePhotoreal ? false : null,
    detail: tilesReady
      ? `total real samples since enable=${sampleDelta}`
      : 'Visible 3D tiles never reported loaded; photoreal completion is unverified.',
  };
}
