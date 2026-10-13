/** English feature copy, following the application language. */
export const AREA_COPY = {
  launcher: '◎ Area insights',
  panel: 'Area insights',
  close: 'Close area insights',
  eyebrow: 'GOD’S EYE · AREA INSIGHTS',
  title: 'What is life like here?',
  intro:
    'Select parameters and adjust their weights. Scores run from 0 to 100: higher is better. Missing selected data contributes 0, lowering the index. The index reflects your preferences, not residents’ wealth.',
  noPoint: 'No area analyzed',
  instruction: 'Move the map to an area of interest.',
  analyze: 'Analyze map center',
  pick: 'Choose a point',
  index: 'AREA INDEX · HIGHER IS BETTER',
  selectPoint: 'Choose a point to acquire real data.',
  details: 'Details and source',
  weight: 'Weight',
  include: 'Include',
  budget: 'Reference budget',
  budgetLabel: 'Housing budget',
  unitWaiting: 'Unit shown with the price',
  source: 'View source',
  loading: 'Acquiring real data…',
  notLoaded: 'Not acquired',
  sourceAfter: 'Sources appear after acquisition.',
  missingService: 'not mapped',
  pointHint:
    'Sampled point · each source specifies its actual geographic area.',
  skyHint:
    'Point the camera at the ground: the center of this view shows the sky.',
  pickHint: 'Click a point on the ground. Esc cancels.',
  noWeights: 'Select at least one parameter with a positive weight.',
  partial: 'Partial index',
  progress: 'acquisition in progress',
  reference: 'Reference',
  acquired: 'Retrieved',
  noDate: 'date not supplied',
  sales: 'sales',
  margin: 'Margin of error',
  years: 'years',
  sample: 'Search sample',
  metrics: {
    air: 'Air quality',
    housing: 'Housing prices',
    services: 'Service access',
    seismic: 'Seismic hazard',
  },
  categories: {
    health: 'Health',
    education: 'Schools',
    food: 'Groceries',
    transit: 'Public transport',
  },
  methodTitle: 'How it works · sources and coverage',
  method:
    'Weighted mean of selected scores. Weight 0 excludes a parameter. Missing selected data contributes zero in this conservative index and reduces coverage. Low scores can therefore reflect missing evidence, not measured poor conditions.',
  formulas:
    'Air: 100 − US AQI/3. Housing: 100 × budget/(budget + price) (50 at budget); OMI uses the quoted range midpoint. Services: mean of 100 × (1 − distance/3 km) across four mapped categories. Seismic: 100 × (1 − PGA/0.6 g). Scores are clamped to 0–100. These are app preference rules, not official indices.',
  coverageNote:
    'Air and services: worldwide, with variable resolution and completeness. Housing: Italy (OMI), France, UK and USA; other countries show missing data. Seismic: global GEM, with coverage gaps. Dates and geographic areas differ: inspect details before comparing indices. A service search sample is approximate, not an exhaustive inventory.',
  licences:
    'GEM 2023.1: Johnson et al. · CC BY-NC-SA 4.0. Open-Meteo and CAMS · CC BY 4.0, free noncommercial use. OpenStreetMap © contributors · ODbL. Housing: Agenzia delle Entrate OMI attribution, DVF Open Licence, UK HPI OGL, US Census public domain.',
};

export function areaPanelMarkup(copy) {
  return `<header><div><span class="area-eyebrow" data-copy="eyebrow">${copy.eyebrow}</span><h2 data-copy="title">${copy.title}</h2></div><button type="button" data-close aria-label="${copy.close}">×</button></header>
    <div class="area-scroll"><p class="area-intro" data-copy="intro">${copy.intro}</p>
    <div class="area-location"><strong data-point>${copy.noPoint}</strong><span data-place>${copy.instruction}</span></div>
    <div class="area-actions"><button type="button" data-analyze data-copy="analyze">${copy.analyze}</button><button type="button" data-pick data-copy="pick">${copy.pick}</button></div>
    <div class="area-index" aria-live="polite"><span data-copy="index">${copy.index}</span><strong data-index>—</strong><p data-coverage>${copy.selectPoint}</p><div class="area-coverage-track"><i data-coverage-bar></i></div></div><div class="area-map-legend"><span>Map colors: <i class="area-low"></i>Low <i class="area-mid"></i>Medium <i class="area-high"></i>High <i class="area-unknown"></i>No index</span><p>Colored points: indices of analyzed locations. Small service dots use category colors, not area scores. Click any dot to analyze that location; all saved areas recalculate with your weights.</p></div><details class="area-nearby"><summary>Find the best place nearby</summary><p>Compare 9 sampled locations using your selected parameters and weights. Choose the nearest result within 2 points of the highest score. Only locations with all selected parameters available are ranked.</p><label>Search radius <select data-search-radius aria-label="Nearby search radius"><option value="500">500 m</option><option value="1500" selected>1.5 km</option><option value="3000">3 km</option></select></label><button type="button" data-search>Find best nearby area</button><p data-search-status role="status">Analyze or choose a point first. This compares places, not available homes. Source coverage and resolution limit the result.</p><button type="button" data-use-best hidden>Analyze this result</button></details><div data-metrics></div>
    <details class="area-method"><summary data-copy="methodTitle">${copy.methodTitle}</summary><p data-copy="method">${copy.method}</p><p data-copy="formulas">${copy.formulas}</p><p data-copy="coverageNote">${copy.coverageNote}</p><p data-copy="licences">${copy.licences}</p></details></div>`;
}
