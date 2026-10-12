/** Provider Settings key setup (templates/provider-settings.html + keySetup). */
export default {
  kicker: 'GROUND STATION · PROVIDER SETTINGS',
  closeAria: 'Close key setup',
  title: 'Power up the globe',
  description:
    "The globe already flies keyless. Every key below switches on another real feed — paste one and it's saved into this app's local configuration, then the server restarts itself. Server-side keys stay on this machine; Google Maps and Cesium ion run in the browser and must be provider-restricted. Keys you configured elsewhere are shown but never touched.",
  apply: 'SAVE KEYS',
  escToClose: 'ESC to close',
  status: {
    // Painted by keySetup.js (say()/close()), never by the static binder.
    default:
      'The Google Maps key buys the photorealistic planet — everything else stacks on top.',
  },
  chip: {
    waiting: {
      one: 'POWER UP · {count} KEY WAITING',
      other: 'POWER UP · {count} KEYS WAITING',
    },
    ready: 'POWERED UP',
    projectKeys: 'Project keys: {label}',
  },
  tier: {
    metered: 'Metered — a billing-enabled account',
    free: 'Free key — register, paste, done',
  },
  badge: {
    browserSide: 'browser-side',
    browserSideTip:
      'This key runs in the browser by design — restrict it at the provider (see SECURITY.md)',
    external: 'configured externally',
    externalTip:
      'Supplied by your environment, Keychain, or launcher — change it where it was set',
  },
  row: {
    manage: 'MANAGE ↗',
    getKey: 'GET KEY ↗',
    remove: 'REMOVE',
    removeTip: "Remove {title} from this app's saved keys",
  },
  field: {
    paste: 'paste {envVar}',
    replace: '{envVar} saved — paste to replace',
  },
  keys: {
    googleMaps: {
      title: 'GOOGLE MAPS',
      unlocks: 'The photorealistic 3D planet + place search',
    },
    googleMapsServer: {
      title: 'GOOGLE MAPS — SERVER',
      unlocks: 'Places context + Street View fallback; optional separate key',
    },
    openai: {
      title: 'OPENAI',
      unlocks: 'Voice control — API key or ChatGPT OAuth',
    },
    aisstream: {
      title: 'AISSTREAM',
      unlocks: 'Live ships, worldwide',
    },
    firms: {
      title: 'NASA FIRMS',
      unlocks: 'Live active-fire detections',
    },
    tomtom: {
      title: 'TOMTOM',
      unlocks: 'Real live traffic (keyless runs a simulation)',
    },
    cesiumIon: {
      title: 'CESIUM ION',
      unlocks: 'Bing imagery map stacks + world terrain',
    },
    opensky: {
      title: 'OPENSKY',
      unlocks: 'More flight-polling credits (anonymous works without)',
    },
    mapillary: {
      title: 'MAPILLARY',
      unlocks:
        'Street-level imagery and coverage in the Street Level layer. Free: register an app in the Mapillary developer dashboard and paste its Client Token',
    },
    launchLibrary: {
      title: 'LAUNCH LIBRARY',
      unlocks: 'Higher space-missions request allowance',
    },
  },
  requirement: {
    tooltip: 'Needs {envVars} — add it in Provider Settings',
  },
  voiceAuth: {
    stateOauth: 'VOICE AUTH · CHATGPT OAUTH',
    stateApiKey: 'VOICE AUTH · API KEY',
    useApiKey: 'USE API KEY',
    useOauth: 'USE CHATGPT OAUTH',
    useApiKeyTip: 'Use OPENAI_API_KEY for the next cloud voice session',
    useOauthTip:
      'Use the signed-in local ChatGPT/Codex OAuth session for the next cloud voice session',
    switchedToApiKey:
      'Cloud voice will use OPENAI_API_KEY on the next session.',
  },
  store: {
    appConfig: 'your app configuration',
    localEnv: 'your local .env',
  },
  save: {
    saving: 'Saving…',
    savedTo: 'Saved to {store}. Restarting — this page reloads itself.',
    removedFrom: 'Removed from {store}. Restarting — this page reloads itself.',
    failedStatus: 'Save failed ({status}).',
    failedMessage: 'Save failed: {message}',
    pasteFirst: 'Paste at least one key first.',
  },
  remove: {
    confirm: 'Remove this key from your saved configuration?',
  },
  oauth: {
    checking: 'Checking local ChatGPT OAuth sign-in…',
    checkFailed: 'OAuth check failed: {message}',
    checkFailedShort: 'Could not check ChatGPT sign-in.',
    checkFailedRetry: 'Could not check ChatGPT sign-in. Try again.',
    selected:
      'ChatGPT OAuth selected for cloud voice. Your API key stays saved and available.',
    expired: 'ChatGPT sign-in expired. Opening sign-in again…',
    opening: 'Opening ChatGPT sign-in in your browser…',
    startFailed: 'Could not start ChatGPT sign-in on this machine.',
    waiting:
      'Finish ChatGPT sign-in in the browser. Waiting for it to complete…',
    timedOut: 'ChatGPT sign-in timed out. Click {button} to try again.',
    complete:
      'ChatGPT sign-in complete. OAuth will be used for the next cloud voice session.',
  },
};
