/** Command dock: visual presets tray, location tray, map source tray. */
export default {
  aria: 'Navigation, voice, and visual preset controls',
  presets: {
    title: 'VISUAL PRESETS',
    pin: 'Pin visual presets',
    pinTitle: 'Keep visual presets open',
  },
  styles: {
    normal: {
      label: 'Normal',
      title: 'Show the globe without a visual filter.',
    },
    retro: {
      label: 'CRT',
      title:
        'Emulate a green phosphor CRT with scanlines and screen curvature.',
    },
    surveillance: {
      label: 'NVG',
      title:
        'Simulate night-vision goggles with green intensification and a tube vignette.',
    },
    thermal: {
      label: 'FLIR',
      title: 'Simulate FLIR-style thermal contrast. Turn up Ironbow for color.',
    },
    anime: {
      label: 'Anime',
      title: 'Apply bright cel-shaded color and illustrated outlines.',
    },
    noir: {
      label: 'Noir',
      title: 'Apply high-contrast monochrome film-noir grading.',
    },
    snow: {
      label: 'Snow',
      title: 'Add a cold, snowy whiteout treatment to the scene.',
    },
  },
  mapSource: {
    title: 'MAP SOURCE',
    chipsAria: 'Map source',
  },
  mini: {
    styleLabel: 'Style',
  },
  location: {
    title: 'LOCATION',
    pin: 'Pin location tray',
    pinTitle: 'Keep location tray open',
    searchToggleTitle: 'Search any location',
    searchPlaceholder: 'Search any location...',
    searchAria: 'Search location by name or coordinates',
  },
};
