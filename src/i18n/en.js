/**
 * English translations dictionary for God's Eye View.
 */
export default Object.freeze({
  // App chrome & Title
  'app.title': "GOD'S EYE VIEW",
  'app.subtitle': 'NO PLACE LEFT BEHIND',
  'app.activeStyle': 'ACTIVE STYLE',

  // Top navigation & actions
  'actions.clearLayers': 'Turn off all selected data layers',
  'actions.clearLayersAria': 'Clear selected data layers',
  'actions.share': 'Copy share link',
  'actions.tilt': 'Toggle straight-down and tilted map views',
  'actions.tiltAria': 'Tilt map to oblique view',
  'actions.northUp': 'Reset map bearing to north',
  'actions.northUpAria': 'Reset map to north up',
  'actions.resetGlobe': 'Reset camera and return to full globe view',
  'actions.resetGlobeAria': 'Reset to full globe view',
  'actions.switchLang': 'Switch Language / 切換語系 (繁中 / EN)',

  // Loading & Sync
  'loading.global': 'LOADING LIVE DATA',
  'loading.traffic': 'syncing road network',
  'loading.cctv': 'loading frames',

  // Bottom Command Dock
  'dock.presets': 'VISUAL PRESETS',
  'dock.pinPresets': 'Keep visual presets open',
  'dock.mapSource': 'MAP SOURCE',
  'dock.powerUp': 'POWER UP',
  'dock.searchPlaceholder': 'Search city, landmark, or coordinates...',
  'dock.flightTracking': 'FLIGHT TRACKING',
  'dock.vesselTracking': 'VESSEL TRACKING',

  // Visual Styles
  'style.normal': 'Normal',
  'style.normalDesc': 'Show the globe without a visual filter.',
  'style.retro': 'CRT',
  'style.retroDesc':
    'Emulate a green phosphor CRT with scanlines and screen curvature.',
  'style.surveillance': 'NVG',
  'style.surveillanceDesc':
    'Simulate night-vision goggles with green intensification and a tube vignette.',
  'style.thermal': 'FLIR',
  'style.thermalDesc':
    'Simulate FLIR-style thermal contrast. Turn up Ironbow for color.',
  'style.anime': 'Anime',
  'style.animeDesc': 'Apply bright cel-shaded color and illustrated outlines.',
  'style.noir': 'Noir',
  'style.noirDesc': 'Apply high-contrast monochrome film-noir grading.',
  'style.snow': 'Snow',
  'style.snowDesc': 'Add a cold, snowy whiteout treatment to the scene.',

  // Data Layer Groups
  'layers.title': 'DATA LAYERS',
  'layers.groups.Movement': 'Movement',
  'layers.groups.Cameras': 'Cameras',
  'layers.groups.Infrastructure': 'Infrastructure',
  'layers.groups.Events': 'Events',
  'layers.groups.Utilities': 'Utilities',
  'layers.groups.Other': 'Other layers',

  // Layer Names
  'layers.items.satellites': 'Satellites',
  'layers.items.flights': 'Live Flights',
  'layers.items.military': 'Military Flights',
  'layers.items.aisLiveVessels': 'Live Vessels',
  'layers.items.traffic': 'Traffic',
  'layers.items.transit': 'Transit',
  'layers.items.bikeshare': 'Bike Share',
  'layers.items.cctv': 'Cameras',
  'layers.items.alprCameras': 'Mapped ALPR Cameras',
  'layers.items.militaryInstallations': 'Mapped Installations',
  'layers.items.localDatacenters': 'Data Centers',
  'layers.items.submarineCables': 'Submarine Cables',
  'layers.items.localDams': 'Dams',
  'layers.items.rocketLaunches': 'Space Missions (30d)',
  'layers.items.earthquakes': 'Earthquakes (24h)',
  'layers.items.localFirms': 'Active Fires',
  'layers.items.directions': 'Directions',
  'layers.items.radio': 'Radio',

  // Layer Feed Statuses
  'layers.status.nominal': 'ON',
  'layers.status.loading': 'LOADING',
  'layers.status.degraded': 'DEGRADED',
  'layers.status.stale': 'STALE',
  'layers.status.partial': 'PARTIAL',
  'layers.status.fallback': 'FALLBACK',
  'layers.status.unavailable': 'UNAVAILABLE',

  // CCTV Panel
  'cctv.title': 'CCTV',
  'cctv.sourceUnknown': 'SOURCE · UNKNOWN',
  'cctv.enableHint': 'Enable CCTV to load camera intersections',
  'cctv.off': 'CCTV OFF',
  'cctv.on': 'CCTV ON',
  'cctv.nearest': 'NEAREST',
  'cctv.prev': 'PREV',
  'cctv.next': 'NEXT',
  'cctv.focus': 'FOCUS',
  'cctv.coverageOff': 'COVERAGE OFF',
  'cctv.coverageOn': 'COVERAGE ON',
  'cctv.autoHopOff': 'AUTO HOP OFF',
  'cctv.autoHopOn': 'AUTO HOP ON',
  'cctv.projectionOn': 'PROJECTION ON',
  'cctv.projectionOff': 'PROJECTION OFF',
  'cctv.calibration': 'CALIBRATION',
  'cctv.adjust': 'ADJUST',
  'cctv.adjustTitle':
    'Drag the camera in the world: rings rotate, arrows move, handles set range/FOV',
  'cctv.saveCal': 'SAVE CAL',
  'cctv.resetCal': 'RESET CAL',
  'cctv.sceneSummary': 'SCENE SUMMARY',
  'cctv.summaryHint':
    'Enable CCTV to start camera-linked intelligence summaries.',

  // Scene Director
  'scenes.title': 'SCENES',
  'scenes.new': 'NEW',
  'scenes.delete': 'DEL',
  'scenes.captureShot': 'CAPTURE SHOT',
  'scenes.updateShot': 'UPDATE SHOT',
  'scenes.start': 'START',
  'scenes.stop': 'STOP',
  'scenes.next': 'NEXT',
  'scenes.export': 'EXPORT PRESETS',
  'scenes.import': 'IMPORT',
  'scenes.runLog': 'RUN LOG',
  'scenes.ready': 'Ready',

  // Cockpit HUD
  'cockpit.pitch': 'PITCH',
  'cockpit.roll': 'ROLL',
  'cockpit.alt': 'ALT',
  'cockpit.spd': 'SPD',
  'cockpit.target': 'TARGET',
  'cockpit.exit': 'EXIT COCKPIT',

  // Display Controls
  'display.title': 'DISPLAY',
  'display.hud': 'HUD',
  'display.layout': 'Layout',
  'display.detect': 'DETECT',
  'display.density': 'Density',
  'display.allocation': 'Allocation',
  'display.fade': 'Fade',
  'display.outside': 'Outside',
  'display.params': 'PARAMETERS',
  'display.3d': '3D',
  'display.models': 'Models',
  'display.proximity': 'Proximity',
  'display.all': 'All',
  'display.scope': 'Scope',
  'display.feather': 'Feather',
  'display.draw': 'Draw',
  'display.shape': 'Shape',
  'display.area': 'Area',
  'display.line': 'Line',

  // Welcome / First Launch
  'welcome.kicker': 'MISSION CONTROL · FIRST LAUNCH',
  'welcome.title': 'Choose your first view',
  'welcome.desc':
    'It feels like a forbidden cockpit—then you realize the sources are public and the data is real.',
  'welcome.contacts': 'LIVE CONTACTS',
  'welcome.contactsDesc': 'Aircraft, vessels and nearby intelligence',
  'welcome.space': 'SPACE MISSIONS',
  'welcome.spaceDesc': 'Launches, spacecraft and orbital context',
  'welcome.environmental': 'ENVIRONMENTAL',
  'welcome.environmentalDesc':
    'Live earthquakes and active fires, from USGS and NASA',
  'welcome.explore': 'EXPLORE MANUALLY',
  'welcome.exploreDesc': 'Begin with a clean globe',
  'welcome.dontShow': "Don't show this again",
  'welcome.esc': 'ESC to dismiss',
  'welcome.tip':
    'Tip: the GEV MIC button in the dock lets you talk to the map.',

  // Provider Settings (POWER UP)
  'powerup.kicker': 'GROUND STATION · PROVIDER SETTINGS',
  'powerup.title': 'Power up the globe',
  'powerup.desc':
    "The globe already flies keyless. Every key below switches on another real feed — paste one and it's saved into this app's local configuration, then the server restarts itself. Server-side keys stay on this machine; Google Maps and Cesium ion run in the browser and must be provider-restricted. Keys you configured elsewhere are shown but never touched.",
  'powerup.save': 'SAVE KEYS',
  'powerup.hint': 'ESC to close',
  'powerup.note':
    'The Google Maps key buys the photorealistic planet — everything else stacks on top.',
});
