/** Scene Director panel (templates/layer-panels.html + scene controls/sharing). */
export default {
  panel: {
    title: 'SCENES',
    selectAria: 'Scene recipe',
    new: 'NEW',
    delete: 'DEL',
    capture: 'CAPTURE SHOT',
    updateShot: 'UPDATE SHOT',
    start: 'START',
    stop: 'STOP',
    next: 'NEXT',
    exportPresets: 'EXPORT PRESETS',
    import: 'IMPORT',
    runLog: 'RUN LOG',
  },
  // The initial "Ready" status reuses `common.ready`.
  status: {
    failed: 'Scene action failed',
    stopped: 'Stopped',
    stoppedEsc: 'Stopped (Esc)',
  },
  prompt: {
    newName: 'New scene name',
    defaultName: 'Scene {n}',
  },
  confirm: {
    deleteScene: 'Delete scene "{title}" and all shots?',
    deleteShot: 'Delete shot "{title}"?',
  },
  shots: {
    empty: 'No shots yet. Use CAPTURE SHOT to save current look.',
    renameHint: 'Double-click to rename',
    nameAria: 'Shot name',
    load: 'LOAD',
    delete: 'DEL',
  },
  authoring: {
    editDetails: 'EDIT DETAILS',
    share: 'SHARE SCENE',
  },
};
