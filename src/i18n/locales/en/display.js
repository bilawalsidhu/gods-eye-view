/**
 * Display panel: static labels plus the dynamic labels the settings owner
 * repaints (style status, detection states, sonar toggle).
 */
export default {
  title: 'DISPLAY',
  hud: {
    toggleTitle: 'Intelligence HUD (H)',
    layout: 'Layout',
    layoutAria: 'HUD layout',
    layouts: {
      tactical: 'Tactical',
      operator: 'Operator',
      minimal: 'Minimal',
      cyber: 'Cyber',
    },
  },
  sonar: {
    label: 'Sonar',
    scanner: 'Cyber sonar contact scanner',
    rings: 'Rings',
    ringsAria: 'Sonar ring count',
    range: 'Range',
    rangeAria: 'Sonar ring range',
    power: 'Power',
    powerAria: 'Sonar intensity',
    opacity: 'Opacity',
    opacityAria: 'Cyber contact and label opacity',
    opacityTitle:
      'Minimum opacity for map dots, icons, models, brackets, and labels between sonar passes',
    sector: 'Sector',
    sectorAria: 'Sonar sector width',
  },
  detection: {
    toggleTitle: 'Detection Overlay (D)',
    label: {
      detect: 'DETECT',
      sparse: 'SPARSE',
      balanced: 'BALANCED',
      dense: 'DENSE',
    },
    ariaOn: 'Detection overlay: {mode}',
    ariaOff: 'Detection overlay: off',
    modes: {
      off: 'off',
      sparse: 'sparse',
      balanced: 'balanced',
      dense: 'dense',
    },
    density: 'Density',
    densityAria: 'Detection label density',
    allocation: 'Allocation',
    allocationAria: 'Detection label allocation',
    elastic: 'Elastic',
    weighted: 'Weighted',
    fade: 'Fade',
    fadeAria: 'Detection fade distance',
    fadeTitle:
      'World-overlay fade distance outside the keyhole as a percentage of its radius',
    outside: 'Outside',
    outsideAria: 'Detection opacity outside the keyhole',
    outsideTitle:
      'World-overlay label and card opacity beyond the fade distance',
  },
  params: {
    title: 'PARAMETERS',
  },
  models: {
    toggleTitle: '3D aircraft — flat icons zoomed out, 3D models up close',
    label: 'Models',
    coverageAria: '3D model coverage',
    proximity: 'Proximity',
    all: 'All',
  },
  scope: {
    label: 'Scope',
    toggleTitle: 'Scope — the circular viewport mask',
    feather: 'Feather',
    featherAria: 'Scope edge feather',
    featherTitle: 'Scope edge feather as a percentage of the keyhole radius',
  },
  draw: {
    toggleTitle:
      'Draw on the world — click vertices, double-click or Enter to finish, Esc to cancel',
    label: 'Draw',
    shape: 'Shape',
    shapeAria: 'Shape to draw',
    area: 'Area',
    line: 'Line',
    pin: 'Pin',
    labelPlaceholder: 'Label (optional)',
    labelAria: 'Label for the drawn shape',
    colorAria: 'Colour of the drawn shape',
    colors: {
      primary: 'Primary',
      amber: 'Amber',
      cyan: 'Cyan',
      green: 'Green',
      red: 'Red',
    },
    clearTitle: 'Remove every mark from the board',
  },
  celestial: {
    label: 'Celestial',
    title: 'Celestial ring — reveal the full globe',
    titleNormalOnly: 'Celestial ring — available in Normal style',
  },
  clean: {
    label: 'Clean UI',
    toggleTitle: 'Hide UI chrome',
    exit: 'EXIT CLEAN VIEW',
    exitTitle: 'Return UI controls',
  },
  bloom: {
    label: 'Bloom',
    toggleTitle: 'Bloom / Glow',
    intensityAria: 'Bloom intensity',
  },
  sharpen: {
    label: 'Sharpen',
    toggleTitle: 'Sharpening',
    intensityAria: 'Sharpen intensity',
  },
  imagerySplit: {
    valueText: 'A {before} percent, B {after} percent',
  },
  styleStatus: {
    normal: 'NORMAL',
    retro: 'CRT',
    surveillance: 'NVG',
    thermal: 'FLIR',
    anime: 'ANIME',
    noir: 'NOIR',
    snow: 'SNOW',
  },
};
