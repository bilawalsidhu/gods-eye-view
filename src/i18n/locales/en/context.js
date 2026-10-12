/** Global Context rail: panel chrome, mode tabs and module toasts. */
export default {
  panel: {
    collapse: 'Collapse panel',
    expand: 'Expand panel',
  },
  panels: {
    weather: {
      title: 'WEATHER',
      countAria: 'Active weather products',
    },
    imagery: {
      title: 'RECENT IMAGERY',
      countAria: 'Imagery days in the box',
    },
    context: {
      title: 'CONTEXT',
    },
  },
  modes: {
    tablistAria: 'Context mode',
    contacts: {
      label: 'CONTACTS',
      tooltip:
        'Cycles the nearest contacts of whatever type you select — planes, vessels, installations. Satellites track independently.',
    },
    spaceMissions: {
      label: 'SPACE MISSIONS',
    },
  },
  modeWord: {
    context: 'Context',
    spaceMissions: 'Space Missions',
  },
  standby: {
    title: 'SELECT CONTEXT',
    contacts: 'CONTACTS — nearest planes · vessels · sites',
    spaceMissions: 'SPACE MISSIONS — launches & orbital assets',
  },
  actions: {
    aria: 'Contact Context actions',
    cockpit: 'COCKPIT',
    searchNearby: 'SEARCH NEARBY SITES',
    tr3bAria: 'Reclassify tracked contact as TR-3B',
    tr3bTitle: 'Reclassify as TR-3B',
  },
  awareness: {
    off: 'CONTACTS CONTEXT OFF',
    hint: 'SELECT CONTACTS TO LOAD OBSERVED / MAPPED PROXIMITY',
  },
  roster: {
    aria: 'Available Space Missions',
    title: 'AVAILABLE MISSIONS',
    hint: 'SELECT A MISSION TO INSPECT',
    loading: 'LOADING 30-DAY MISSION INDEX',
    hintKeys: 'TAB PREVIEWS · ENTER / SPACE SELECTS',
  },
  toast: {
    restoreFailed: 'Context could not restore every layer; try again',
    noneSelected: 'No selected data layers',
    notCleared: {
      one: '{count} data layer could not be cleared',
      other: '{count} data layers could not be cleared',
    },
    cleared: {
      one: 'Cleared {count} data layer',
      other: 'Cleared {count} data layers',
    },
    clearFailed: 'Selected data layers could not be cleared',
    contactsTransition:
      'Contacts could not complete the requested transition; try again',
    missionsTransition:
      'Space Missions could not complete the requested transition; try again',
    installationsRefreshed: 'Nearby installations refreshed',
    installationsFailed:
      'Nearby installations could not be refreshed; try again',
    zoomIn: 'Zoom in to search mapped installations',
    layerUnavailable: 'That layer is unavailable in the current Context mode',
    layerStartFailed: '{layerId} could not start cleanly',
    layerStopFailed: '{layerId} could not stop cleanly',
    missionsRestoreFailed:
      'Space Missions cancellation could not restore the previous layer state',
    startBlocked:
      '{mode} could not start because another layer did not stop cleanly',
  },
};
