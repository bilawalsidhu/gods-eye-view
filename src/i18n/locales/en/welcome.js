/** First-launch welcome launcher (templates/welcome.html + firstRunExperience). */
export default {
  kicker: 'MISSION CONTROL · FIRST LAUNCH',
  title: 'Choose your first view',
  description:
    'It feels like a forbidden cockpit—then you realize the sources are public and the data is real.',
  missions: {
    contacts: {
      label: 'LIVE CONTACTS',
      subcopy: 'Aircraft, vessels and nearby intelligence',
    },
    spaceMissions: {
      label: 'SPACE MISSIONS',
      subcopy: 'Launches, spacecraft and orbital context',
    },
    environmental: {
      label: 'ENVIRONMENTAL',
      subcopy: 'Live earthquakes and active fires, from USGS and NASA',
      choices: {
        environmental: 'ENVIRONMENTAL',
        earthWatch: 'EARTH WATCH',
        activeEvents: 'ACTIVE EVENTS',
      },
    },
    explore: {
      label: 'EXPLORE MANUALLY',
      subcopy: 'Begin with a clean globe',
    },
  },
  suppress: "Don't show this again",
  escToDismiss: 'ESC to dismiss',
  tip: 'Tip: the GEV MIC button in the dock lets you talk to the map.',
  busy: {
    contacts: 'Starting live contacts…',
    spaceMissions: 'Opening space missions…',
    environmental: 'Scanning active events…',
    fallback: 'Working…',
  },
  failure: {
    missionOpen:
      'Could not open that mission{detail}. Retry or explore manually.',
    storageBlocked:
      'This browser is blocking storage, so that could not be saved.',
  },
};
