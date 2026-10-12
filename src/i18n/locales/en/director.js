/**
 * Scene director, authoring, sharing and document-flow messages.
 * English values are verbatim with the strings these flows showed before
 * localization. Field-level document validation (documentFields.js and the
 * packs/cameras/interactions validators) intentionally stays English — it is
 * diagnostic text.
 */
export default {
  status: {
    storageCorrupt:
      'Saved project could not be read; storage preserved. Import a valid file to resume saving.',
    loaded: 'Loaded: {scene} / {shot}',
    seeked: 'Seeked: {scene} / {shot}',
    cannotLeaveScene: 'Could not leave scene: {scene}',
    cameraNotReady: 'Cannot capture shot: camera not ready',
    captured: 'Captured: {scene} / {shot}',
    selectShotFirst: 'Select a shot first',
    updated: 'Updated: {scene} / {shot}',
    cameraUnavailable: 'Camera unavailable — exit cockpit first',
    noShots: 'No shots to run',
    runError: 'Error: {message}',
    runFailed: 'run failed',
    exportFailed: 'Export failed: {message}',
    projectExported: 'Project exported',
    imported: 'Imported {file}',
    importFailed: 'Import failed: {message}',
    importFailedJson: 'Import failed (could not read JSON file)',
    layersRefused: 'Layers refused: {layers}',
    contextExitFailed: 'Could not exit {mode} — scene layers may be refused',
    transitionLimit: 'Scene transition limit reached — load a shot to reset',
    // Stop reasons produced by the director itself. They are state-held
    // statuses; translating at production keeps the panel honest in either
    // locale (the UI-supplied reasons arrive already translated).
    stoppedCameraOwnership: 'Camera ownership changed',
    stoppedLayerOff: 'Scene layer turned off',
    stoppedImporting: 'Importing project',
    stoppedSeeking: 'Seeking scene clock',
    stoppedCameraMove: 'Camera move interrupted',
    stoppedMediaTimeout: 'Scene media timed out',
  },
  storage: {
    notSavedStorage: 'Scene not saved — browser storage unavailable',
    notSavedCorrupt:
      'Scene not saved — existing saved project could not be read. Export edits or import a valid file.',
    notSaved: 'Scene not saved — {message}',
  },
  titles: {
    untitledScene: 'Untitled Scene',
    defaultShot: 'Shot {n}',
  },
  run: {
    editableTitle: 'Editable Scene Run',
  },
  media: {
    windowExceeded:
      'Scene media did not finish within its bounded playback window',
  },
  append: {
    updateInventoryMismatch: 'Cannot update {title}: shot inventory changed',
    updateBeatsMismatch: 'Cannot update {title}: evidence beats changed',
    updateBindingsIncomplete:
      'Cannot update {title}: shot bindings are incomplete',
    updatedShots: {
      one: 'Updated {count} shot: {title}',
      other: 'Updated {count} shots: {title}',
    },
    appendedShots: 'Appended {count} shots: {title}',
  },
  authoring: {
    selectSceneShot: 'Select a scene and shot first',
    selectScene: 'Select a scene first',
    unsupportedSceneDetail: 'Unsupported scene detail',
    unsupportedShotDetail: 'Unsupported shot detail',
  },
  document: {
    unsupportedVersion: 'unsupported scene project version',
    tooManyShots: 'too many shots in project',
    fileTooLarge: 'file exceeds 5 MiB',
    invalidJson: 'invalid JSON',
  },
  bundle: {
    shareTooLarge: 'share exceeds 50 MiB',
    invalidJson: 'invalid JSON',
    unsupportedVersion: 'unsupported bundle version',
    invalidAsset: 'invalid or oversized base64 asset',
    assetTooLarge: 'asset byte limit exceeded',
    unsupportedMedia: 'unsupported media type',
    duplicatePath: 'duplicate asset path',
    integrityMismatch: 'asset integrity mismatch',
    incompletePack: 'bundle must include every declared pack',
    missingAsset: 'missing or mismatched bundle asset',
    unreferencedAsset: 'unreferenced bundle asset',
    tooManyAssets: 'too many bundled assets',
    selectFiles: 'select a file for every declared data pack',
    fileMismatch: 'selected file does not match declared integrity',
    conflictingIntegrity: 'conflicting shared asset integrity',
    unavailable: 'Bundle asset unavailable — reimport the bundle',
  },
  preview: {
    includedInBundle: 'Included in bundle',
    missingBundleFile: 'Missing bundle file — reimport its bundle',
    sourceConfigured: 'Source configured; file checked when loaded',
    sourceUnavailable: 'Source unavailable',
  },
  sharing: {
    genericFailure:
      'Could not complete this action. Check the file, references and selected assets.',
    inventorySummary: '{scenes} scenes · {shots} shots · {packs} data packs',
    packLine:
      '{scene} / {id}: {status}. File: {path}. {attribution} · {license}',
    unavailableLayers: 'Unavailable layers: {layers}',
    externalContent:
      'This scene uses registered content or linked media. Those external files are not included in a scene bundle. Their original notices still apply.',
    bundledBytes:
      '{bytes} bundled bytes verified. Files stay in memory for this session. Reimport the bundle after reloading the app.',
    reviewTitle: 'Review scene import',
    nothingApplied: 'Nothing is loaded or changed until you apply this file.',
    readyToImport: 'Ready to import',
    applyWarning:
      'Apply replaces the current project. Export your current project first if you want to keep both.',
    applyImport: 'Apply import',
    projectChanged: 'Project changed',
    notApplied: 'Import was not applied. The current project may have changed.',
    editTitle: 'Edit scene details',
    editIntro:
      'Camera positions use degrees and meters above the ellipsoid. Drafts are validated before they replace your saved scene.',
    anchorsInput: 'Anchors and data packs',
    shotInput: 'Shot camera, timing, packs and actions',
    anchorIdInput: 'New anchor ID',
    captureAnchor: 'Capture camera as anchor',
    cameraUnavailable: 'Camera unavailable',
    duplicateAnchor: 'Duplicate anchor',
    anchorAdded: 'Anchor added to draft',
    setMoveStart: 'Set move start to current camera',
    moveAdded: 'Move added to draft; destination remains the shot camera',
    ordinaryFlight: 'Use ordinary flight',
    invalidShotJson: 'Invalid shot JSON',
    applyDetails: 'Apply details',
    shareTitle: 'Share selected scene',
    shareIntro:
      'Scene JSON preserves authored settings and attribution. It does not include asset files. Bundles include only pack files you choose here or previously imported bundle files.',
    downloadJson: 'Download scene JSON',
    chooseFiles: 'Choose data-pack files',
    chooseFolder: 'Or choose a data-pack folder',
    downloadBundle: 'Download asset bundle',
    missingFile: 'Missing or ambiguous file',
    assetSizeLimit: 'Asset size limit',
    bundleDownloaded: 'Asset bundle downloaded',
    detailsName: 'scene details',
  },
  interactions: {
    title: 'Scene actions',
    hint: 'Select a feature or use Tab and Enter to choose an action.',
    selectedFeature: 'Selected feature: {feature}. Choose an action.',
    complete: 'Action complete',
    unavailable: 'Action unavailable or cancelled',
    missingFeature: 'Interaction feature is missing from the loaded pack',
  },
  session: {
    tooManyPacks: 'Too many data packs',
    loadFailed:
      'Data pack could not load: check its source, format, size or integrity',
  },
  labels: {
    source: 'Source',
  },
  recipes: {
    nepalFloodIncident: 'Nepal Flood Incident',
    bhoteKoshiEvidence: 'Bhote Koshi Evidence Sequence',
    flightsRadar: 'Global Flights Radar',
    orbitalWatch: 'Orbital Watch',
    thermalThreats: 'Thermal Threat Board',
    cityOverload: 'City Overload',
    omnisciencePullback: 'Omniscience Pullback',
  },
};
