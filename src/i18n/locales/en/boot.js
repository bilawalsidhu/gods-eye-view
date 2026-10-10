/** Boot-time strings: loading screen, startup status lines, init errors. */
export default {
  loader: {
    title: "GOD'S EYE VIEW",
    status: 'Initializing photorealistic world...',
    errorPrefix: 'Error: {message}',
  },
  scene: {
    configuringViewer: 'Configuring viewer...',
    loadingGoogle3d: 'Loading Google 3D Tiles...',
    loadingKeyless: 'Loading the keyless globe...',
    google3dUnavailable:
      'Google 3D Tiles unavailable ({detail}). Loading the keyless globe...',
    initializingSystems: 'Initializing systems...',
    flyAustin: 'Flying to Austin, TX...',
    restoringShare: 'Restoring shared view...',
  },
  errors: {
    unknownInit: 'Unknown initialization error',
    init: 'Initialization error',
  },
  language: {
    /** Browser tab title stays the brand name in every locale. */
    documentTitle: "God's Eye View",
  },
};
