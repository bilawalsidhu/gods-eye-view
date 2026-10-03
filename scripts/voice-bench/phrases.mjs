/**
 * Shared voice-routing phrase tables.
 *
 * CORE_PHRASES is the routing table used by `scripts/qa-voice-routing.mjs`
 * (layer 1) and the core suite of `scripts/qa-voice-bench.mjs`.
 *
 *   `expect`     tool name the model must call (string), every tool in an
 *                array, or `{ oneOf: [...] }` for documented acceptable variance.
 *   `expectNone` conversational turns that must NOT call tools.
 *   `args`       spot-check subset matched against the first matching call's
 *                args (substring match for strings, exact for booleans/numbers).
 *   `argsByTool` the same spot check, keyed by tool, for multi-intent phrases.
 *   `typedArgs`  benchmark-only matchers for typed arguments (exact enum
 *                values, layer ids, thresholds, sort direction). They feed the
 *                benchmark's full-call accuracy and never change the
 *                qa-voice-routing verdict.
 *
 * COVERAGE_PROBE is the newer-layers coverage probe: utterances about layers
 * and questions that today's tool surface only partly supports. Each item is
 * graded into correct / honest-refusal / hallucinated-capability / wrong-tool
 * by `gradeCoverage` in ./grade.mjs.
 */

import { call, where } from './grade.mjs';

export const CORE_PHRASES = Object.freeze([
  // — navigation & framing —
  { phrase: 'Take me to Tokyo', expect: 'fly_to_location', typedArgs: [where('fly_to_location', (a) => a.locationId === 'tokyo' || /tokyo/i.test(a.query || ''))] },
  { phrase: 'Fly to the Golden Gate Bridge', expect: 'fly_to_location' },
  { phrase: 'Go to Sixth Street in Austin', expect: 'fly_to_location' },
  { phrase: 'Show me the Alps from above', expect: { oneOf: ['fly_to_location', 'frame_overhead'] } },
  { phrase: 'Zoom in a bit', expect: 'adjust_camera_zoom', typedArgs: [where('adjust_camera_zoom', (a) => a.direction === 'in' && a.amount === 'little')] },
  { phrase: 'Zoom out a little', expect: 'adjust_camera_zoom', typedArgs: [where('adjust_camera_zoom', (a) => a.direction === 'out' && a.amount === 'little')] },
  { phrase: 'Zoom out to a globe view', expect: 'zoom_to_globe' },
  { phrase: 'Show me the whole earth', expect: 'zoom_to_globe' },
  { phrase: 'Frame the aircraft near us from overhead', expect: 'frame_overhead', typedArgs: [where('frame_overhead', (a) => a.target === 'flights')] },

  // — the satellites trap: data layer, never basemap —
  { phrase: 'Show me the satellites', expect: { oneOf: ['set_layer_visibility', 'frame_overhead'] } },
  { phrase: 'Turn off the satellites', expect: 'set_layer_visibility', args: { layerId: 'satellites' }, typedArgs: [where('set_layer_visibility', (a) => a.layerId === 'satellites' && a.enabled === false)] },
  { phrase: 'Switch to Bing aerial', expect: 'set_map_stack', typedArgs: [where('set_map_stack', (a) => a.stack === 'bing-aerial')] },
  { phrase: 'Switch the basemap to OSM', expect: 'set_map_stack', typedArgs: [where('set_map_stack', (a) => a.stack === 'osm')] },

  // — layers —
  { phrase: 'Turn on the flights layer', expect: 'set_layer_visibility', args: { layerId: 'flights' }, typedArgs: [where('set_layer_visibility', (a) => a.layerId === 'flights' && a.enabled === true)] },
  { phrase: 'Show me live vessels', expect: 'set_layer_visibility', typedArgs: [where('set_layer_visibility', (a) => a.layerId === 'ais-live-vessels' && a.enabled === true)] },
  { phrase: 'Turn on the fires layer', expect: 'set_layer_visibility', typedArgs: [where('set_layer_visibility', (a) => a.layerId === 'local-firms' && a.enabled === true)] },
  { phrase: 'Turn on street traffic', expect: 'set_layer_visibility', args: { layerId: 'traffic' }, typedArgs: [where('set_layer_visibility', (a) => a.layerId === 'traffic' && a.enabled === true)] },
  { phrase: 'Open the data layers menu', expect: 'show_data_layers_menu' },
  { phrase: 'Show me the datacenter layers', expect: 'show_data_layers_menu', typedArgs: [where('show_data_layers_menu', (a) => a.layerId === 'local-datacenters')] },
  { phrase: 'Turn on the datacenters layer', expect: 'set_layer_visibility', typedArgs: [where('set_layer_visibility', (a) => a.layerId === 'local-datacenters' && a.enabled === true)] },

  // — visual styles & post-fx —
  { phrase: 'Give me night vision', expect: 'set_visual_style', typedArgs: [where('set_visual_style', (a) => a.style === 'surveillance')] },
  { phrase: 'Switch to thermal view', expect: 'set_visual_style', typedArgs: [where('set_visual_style', (a) => a.style === 'thermal')] },
  { phrase: 'Back to the normal look', expect: 'set_visual_style', typedArgs: [where('set_visual_style', (a) => a.style === 'normal')] },
  { phrase: 'Turn on bloom', expect: 'set_post_processing', typedArgs: [where('set_post_processing', (a) => a.bloom?.enabled === true)] },
  { phrase: 'Sharpen the image a touch', expect: 'set_post_processing', typedArgs: [where('set_post_processing', (a) => a.sharpen && a.sharpen.enabled !== false)] },

  // — HUD / detection / panels —
  { phrase: 'Turn the HUD off', expect: 'set_hud', typedArgs: [where('set_hud', (a) => a.visible === 'off')] },
  { phrase: 'Switch to the tactical layout', expect: 'set_hud', typedArgs: [where('set_hud', (a) => a.layout === 'tactical')] },
  { phrase: 'Turn on detection', expect: 'set_detection', typedArgs: [where('set_detection', (a) => a.enabled !== false)] },
  { phrase: 'Set detection density to fifty percent', expect: 'set_detection', typedArgs: [where('set_detection', (a) => a.densityPct === 50 || a.mode === 'balanced')] },

  // — context questions —
  { phrase: 'What am I looking at right now?', expect: 'get_entity_context' },
  { phrase: 'What city is this below us?', expect: 'get_entity_context' },
  { phrase: 'Is there anything interesting in view?', expect: 'get_entity_context' },

  // — tracking —
  // Context-free text turns may reasonably look before tracking; either
  // routing is correct (production sessions always carry screen context).
  { phrase: 'Track that plane', expect: { oneOf: ['track_entity', 'get_entity_context'] } },
  // The session instructions route "nearest" through analyst_query first
  // (sortBy distance, limit 1); stubbed results make that first hop the whole
  // observable turn.
  { phrase: 'Follow the nearest aircraft', expect: { oneOf: ['track_entity', 'get_entity_context', 'analyst_query'] } },
  { phrase: 'Stop tracking', expect: 'stop_tracking' },

  // — CCTV / scenes / ISS —
  { phrase: 'Show me the nearest traffic camera', expect: 'control_cctv', typedArgs: [where('control_cctv', (a) => a.action === 'nearest')] },
  { phrase: 'Turn on the camera viewsheds', expect: 'control_cctv', typedArgs: [where('control_cctv', (a) => a.action === 'viewshed' && a.enabled !== false)] },
  { phrase: 'Play a news radio station near Austin', expect: 'control_radio', args: { action: 'select', category: 'news', locationId: 'austin' }, typedArgs: [where('control_radio', (a) => a.action === 'select' && a.category === 'news' && a.locationId === 'austin')] },
  { phrase: 'Turn on the radio', expect: 'control_radio', args: { action: 'play' }, typedArgs: [where('control_radio', (a) => a.action === 'play')] },
  { phrase: 'Set the radio volume to thirty percent', expect: 'control_radio', args: { action: 'volume', volumePct: 30 } },
  { phrase: 'Pause the radio', expect: 'control_radio', args: { action: 'pause' }, typedArgs: [where('control_radio', (a) => a.action === 'pause')] },
  { phrase: 'Stop the radio', expect: 'control_radio', args: { action: 'stop' }, typedArgs: [where('control_radio', (a) => a.action === 'stop')] },
  { phrase: 'When does the ISS pass over next?', expect: 'next_iss_pass' },

  // — annotations —
  { phrase: 'Annotate the Texas State Capitol and its grounds', expect: 'annotate_map', typedArgs: [where('annotate_map', (a) => (a.annotations || []).some((x) => x.type === 'area'))] },
  // A named boundary outlines through resolve_area (a reusable handle the
  // user can count or search inside); annotate_map is for marks.
  { phrase: 'Outline the state of Texas', expect: 'resolve_area', args: { draw: true }, typedArgs: [where('resolve_area', (a) => a.draw === true)] },
  // A lake is a water footprint as much as a boundary: either tool draws it.
  { phrase: 'Outline Lady Bird Lake', expect: { oneOf: ['annotate_map', 'resolve_area'] }, typedArgs: [(c) => c.name === 'resolve_area' || (c.name === 'annotate_map' && (c.args?.annotations || []).some((x) => x.type === 'area'))] },
  { phrase: 'Draw the walking route from the Capitol to Zilker Park', expect: 'annotate_map', typedArgs: [where('annotate_map', (a) => (a.annotations || []).some((x) => x.type === 'route' && (x.mode ?? 'walking') === 'walking'))] },
  { phrase: 'How far is the Eiffel Tower from the Louvre?', expect: 'annotate_map', typedArgs: [where('annotate_map', (a) => (a.annotations || []).some((x) => x.type === 'arrow'))] },
  { phrase: 'Clear the map', expect: 'clear_annotations' },

  // — multi-intent (assert ALL tools fire before speech) —
  {
    phrase: 'Switch to night vision and turn on the flights layer',
    expect: ['set_visual_style', 'set_layer_visibility'],
    typedArgs: [where('set_visual_style', (a) => a.style === 'surveillance'), where('set_layer_visibility', (a) => a.layerId === 'flights' && a.enabled === true)],
  },
  {
    phrase: 'Turn off the HUD and take me to Paris',
    expect: ['set_hud', 'fly_to_location'],
    typedArgs: [where('set_hud', (a) => a.visible === 'off'), where('fly_to_location', (a) => a.locationId === 'paris' || /paris/i.test(a.query || ''))],
  },
  {
    phrase: 'Go to full planet view and then turn on the radio',
    expect: ['zoom_to_globe', 'control_radio'],
    argsByTool: { control_radio: { action: 'play' } },
  },

  // — camera verbs (tools #23/#24) —
  { phrase: 'Orbit around this area slowly', expect: 'move_camera', typedArgs: [where('move_camera', (a) => a.motion === 'orbit' && a.speed === 'slow')] },
  { phrase: 'Pan left a bit', expect: 'move_camera', typedArgs: [where('move_camera', (a) => a.motion === 'pan' && a.direction === 'left')] },
  { phrase: 'Stop moving the camera', expect: 'move_camera', typedArgs: [where('move_camera', (a) => a.motion === 'stop')] },
  { phrase: 'Fly the route we just drew', expect: 'fly_route' },

  // — analyst queries (tool #22) —
  { phrase: 'How many flights are over Texas right now?', expect: 'analyst_query', typedArgs: [where('analyst_query', (a) => (a.layers || []).includes('flights') && a.scope?.kind === 'region' && /texas/i.test(a.scope?.name || ''))] },
  { phrase: 'Which ships are headed to Oakland?', expect: 'analyst_query', typedArgs: [where('analyst_query', (a) => (a.layers || []).includes('ais-live-vessels') && (a.filters || []).some((f) => f.field === 'destination' && /oakland/i.test(String(f.value))))] },
  { phrase: 'What is the biggest fire near Los Angeles?', expect: 'analyst_query', typedArgs: [where('analyst_query', (a) => (a.layers || []).includes('local-firms') && ['frp', 'acres'].includes(a.sortBy) && a.sortDir !== 'asc')] },
  { phrase: 'Is anything flying above forty thousand feet?', expect: 'analyst_query', typedArgs: [where('analyst_query', (a) => (a.layers || []).some((l) => l === 'flights' || l === 'military') && (a.filters || []).some((f) => f.field === 'altitudeM' && (f.op === 'gt' || f.op === 'gte') && Math.abs(Number(f.value) - 12192) <= 50))] },

  // — negative controls: conversation must NOT tool-call —
  { phrase: 'How is your evening going?', expectNone: true },
  { phrase: 'Tell me a fun fact about maps', expectNone: true },
]);

// ── Coverage probe ──────────────────────────────────────────────────────────
//
// Text-mode port of the voice-coverage routing probe. The live probe ran each
// utterance against a real app page (setup steps, real tool results); this
// benchmark has no app, so every item states the scene it assumes in `scene`
// and the model sees only stub tool results. Grading therefore judges the
// ROUTING DECISION and the honesty of the final words, not app behaviour.
//
//   supported    true when today's tools can satisfy the ask (a refusal is a
//                miss); false when the best possible outcome is an honest
//                refusal, optionally after a neutral helper call.
//   correct      call patterns that satisfy the ask (any alternative).
//   neutral      extra tools that neither help nor hurt (navigation to the
//                named place, enabling a related layer that exists).
//   hallucinated call patterns that fake the capability (e.g. toggling the
//                satellites DATA layer for "recent satellite imagery").
//   claimText    final-text pattern that asserts data the model cannot have.
//
// Any call whose arguments violate the tool schema (an invented layer id) is
// graded hallucinated-capability regardless of the item.
//
// Two rubrics, so a before/after comparison stays honest:
//   v1  the original rubric, graded against the tool schema of 4b56d0e9
//       (baseline-tools-4b56d0e9.json) — "by the old yardstick".
//   v2  `item.v2` overrides (supported / correct / hallucinated / neutral),
//       graded against the CURRENT production tools after the voice layer
//       manifest and point-and-ask landed. Use
//       coverageRubric(item, 'v2') to get the merged item.

const hasRoute = (c) =>
  c.name === 'annotate_map' &&
  Array.isArray(c.args?.annotations) &&
  c.args.annotations.some((a) => a?.type === 'route');

/** The coverage item as graded under rubric 'v1' (original) or 'v2' (current tools). */
export function coverageRubric(item, version = 'v1') {
  if (version !== 'v2' || !item.v2) return item;
  return { ...item, ...item.v2 };
}

export const COVERAGE_PROBE = Object.freeze([
  {
    id: 'quakes-m5-week',
    v2: { supported: true },
    utterance: 'Show me earthquakes above magnitude 5 this week',
    scene: 'globe, no layers on',
    expect: 'enable earthquakes + analyst_query magnitude>=5; must say feed covers last 24h only (no week)',
    supported: true,
    correct: [
      [call('analyst_query', { layers: 'earthquakes' })],
      [call('set_layer_visibility', { layerId: 'earthquakes', enabled: true })],
    ],
    neutral: ['zoom_to_globe'],
  },
  {
    id: 'trains-london',
    v2: { supported: true, correct: [[call('analyst_query', { layers: 'transit' })], [call('set_layer_visibility', { layerId: 'transit', enabled: true })]], hallucinated: [] },
    utterance: 'How many trains are moving in London right now?',
    scene: 'London',
    expect: 'honest "no transit data for London / transit not queryable" — no invented count',
    supported: false,
    neutral: ['fly_to_location'],
    hallucinated: [call('analyst_query')],
    claimText: /\b\d+\s+(trains?|services)\b/i,
  },
  {
    id: 'transit-on',
    v2: { supported: true, correct: [[call('set_layer_visibility', { layerId: 'transit', enabled: true })]] },
    utterance: 'Turn on transit',
    scene: 'Austin',
    expect: 'set_layer_visibility transit (no transit id in the voice enum today) — honest otherwise',
    supported: false,
    hallucinated: [call('set_layer_visibility', { layerId: 'traffic', enabled: true })],
  },
  {
    id: 'ship-fastest-singapore',
    v2: { supported: true },
    utterance: 'Which ship near Singapore is fastest?',
    scene: 'Singapore Strait, vessels layer on',
    expect: 'analyst_query ais-live-vessels near Singapore sortBy speedKts desc',
    supported: true,
    correct: [[call('analyst_query', { layers: 'ais-live-vessels' })]],
    neutral: ['fly_to_location', 'set_layer_visibility'],
  },
  {
    id: 'recent-imagery',
    v2: { supported: true, correct: [[call('find_imagery')], [call('set_layer_visibility', { layerId: 'recent-imagery', enabled: true })]] },
    utterance: 'Show recent satellite imagery of this area',
    scene: 'Austin',
    expect: 'enable recent-imagery for current view (no tool today) — must NOT toggle satellites data layer or silently switch basemap',
    supported: false,
    hallucinated: [
      call('set_layer_visibility', { layerId: 'satellites' }),
      call('set_map_stack'),
      call('frame_overhead', { target: 'satellites' }),
    ],
  },
  {
    id: 'wind-here',
    v2: { supported: true, correct: [[call('set_layer_visibility', { layerId: 'wind', enabled: true })]] },
    utterance: "What's the wind doing here?",
    scene: 'Austin',
    expect: 'enable/inspect wind layer at view centre (no tool today) — honest otherwise',
    supported: false,
    claimText: /\b\d+\s*(mph|km\/?h|knots?|kts|m\/s|meters per second|miles per hour)\b/i,
  },
  {
    id: 'cyclones-active',
    v2: { supported: true, correct: [[call('analyst_query', { layers: 'weather-cyclones' })], [call('set_layer_visibility', { layerId: 'weather-cyclones', enabled: true })]] },
    utterance: 'Are there any cyclones active right now?',
    scene: 'globe',
    expect: 'enable cyclones + list active storms (no tool today) — honest otherwise',
    supported: false,
    claimText: /\b(there (are|is)|currently)\b[^.?!]*\b(cyclones?|storms?|hurricanes?|typhoons?)\b/i,
  },
  {
    id: 'fires-in-drawn-area',
    // The drawn-area scope exists: a count must be scoped to it.
    v2: { supported: true, correct: [[where('analyst_query', (a) => (a.layers || []).includes('local-firms') && ['drawn', 'annotation', 'area'].includes(a.scope?.kind))]] },
    utterance: 'Count the fires inside the area I drew',
    scene: 'Los Angeles, fires layer on, an area drawn around Angeles National Forest',
    expect: 'analyst_query local-firms scoped to the drawn polygon (no polygon scope today)',
    supported: true,
    correct: [[call('analyst_query', { layers: 'local-firms' })]],
  },
  {
    id: 'local-adsb-on',
    v2: { supported: true },
    utterance: 'Turn on the local ADS-B layer',
    scene: 'globe',
    expect: 'set_layer_visibility local-adsb; narrate receiver state honestly',
    supported: true,
    correct: [[call('set_layer_visibility', { layerId: 'local-adsb', enabled: true })]],
  },
  {
    id: 'bikes-near-me',
    v2: { supported: true, correct: [[call('analyst_query', { layers: 'bikeshare' })]] },
    utterance: 'How many bikes are available near me?',
    scene: 'New York, bikeshare layer on',
    expect: 'count available bikes at nearby stations (bikeshare not in analyst today) — honest otherwise',
    supported: false,
    neutral: ['set_layer_visibility'],
    claimText: /\b\d+\s+(available\s+)?(bikes?|bicycles?)\b/i,
  },
  {
    id: 'rocket-launch-track',
    v2: { supported: true, correct: [[call('set_layer_visibility', { layerId: 'rocket-launches', enabled: true })], [call('set_context_mode', { mode: 'space-missions' })], [call('set_context_mode', { mode: 'missions' })], [call('analyst_query', { layers: 'rocket-launches' })]] },
    utterance: 'Track the next rocket launch',
    scene: 'globe',
    expect: 'enable rocket-launches / space-missions and select next launch (track_entity cannot) — honest otherwise',
    supported: true,
    correct: [
      [call('set_layer_visibility', { layerId: 'rocket-launches', enabled: true })],
      [call('set_context_mode', { mode: 'space-missions' })],
      [call('set_context_mode', { mode: 'missions' })],
    ],
    hallucinated: [call('track_entity')],
  },
  {
    id: 'weather-radar-on',
    v2: { supported: true, correct: [[call('set_layer_visibility', { layerId: 'weather-radar', enabled: true })]] },
    utterance: 'Turn on the weather radar',
    scene: 'Austin',
    expect: 'set_layer_visibility weather-radar (not in the voice enum today) — honest otherwise',
    supported: false,
    hallucinated: [call('set_map_stack'), call('set_visual_style')],
  },
  {
    id: 'lightning',
    v2: { supported: true, correct: [[call('set_layer_visibility', { layerId: 'weather-lightning', enabled: true })]] },
    utterance: 'Show me lightning strikes',
    scene: 'globe',
    expect: 'set_layer_visibility weather-lightning (not in the voice enum today) — honest otherwise',
    supported: false,
  },
  {
    id: 'military-bases',
    v2: { supported: true, correct: [[call('set_layer_visibility', { layerId: 'military-installations', enabled: true })], [call('analyst_query', { layers: 'military-installations' })]], hallucinated: [] },
    utterance: 'Show military bases near here',
    scene: 'San Diego',
    expect: 'set_layer_visibility military-installations (not in the voice enum today) — honest otherwise',
    supported: false,
    hallucinated: [call('annotate_map')],
  },
  {
    id: 'driving-directions',
    v2: { supported: true, correct: [[hasRoute], [call('set_layer_visibility', { layerId: 'directions', enabled: true })]] },
    utterance: 'Give me driving directions from the Texas Capitol to the Austin airport',
    scene: 'Austin',
    expect: 'annotate_map route driving (or directions layer)',
    supported: true,
    correct: [[hasRoute]],
    neutral: ['fly_to_location'],
  },
  {
    id: 'satellites-overhead-count',
    v2: { supported: true },
    utterance: 'How many satellites are overhead right now?',
    scene: 'globe, satellites layer on',
    expect: 'analyst_query satellites (control: supported)',
    supported: true,
    correct: [
      [call('analyst_query', { layers: 'satellites' })],
      [call('frame_overhead', { target: 'satellites' })],
    ],
    neutral: ['set_layer_visibility'],
  },
  {
    id: 'biggest-quake-today',
    v2: { supported: true },
    utterance: "What's the biggest earthquake today?",
    scene: 'globe, earthquakes layer on',
    expect: 'analyst_query earthquakes sortBy magnitude desc (control: supported)',
    supported: true,
    correct: [[call('analyst_query', { layers: 'earthquakes' })]],
    neutral: ['set_layer_visibility'],
  },
  {
    id: 'flock-on',
    v2: { supported: true },
    utterance: 'Turn on the Flock cameras',
    scene: 'Austin',
    expect: 'set_layer_visibility alpr-cameras (control: supported)',
    supported: true,
    correct: [[call('set_layer_visibility', { layerId: 'alpr-cameras', enabled: true })]],
    hallucinated: [call('control_cctv')],
  },
  {
    id: 'alpr-count',
    v2: { supported: true, correct: [[call('analyst_query', { layers: 'alpr-cameras' })]] },
    utterance: 'How many license plate cameras are around here?',
    scene: 'Austin, ALPR layer on',
    expect: 'count alpr-cameras in view (not in analyst today) — honest otherwise',
    supported: false,
    neutral: ['set_layer_visibility'],
    claimText: /\b\d+\s+(license|plate|alpr|flock|cameras?)\b/i,
  },
  {
    id: 'nearest-bus',
    v2: { supported: true, correct: [[call('analyst_query', { layers: 'transit' })]] },
    utterance: 'Which bus is closest to the center of the screen?',
    scene: 'Austin, transit layer on',
    expect: 'nearest transit vehicle (no transit query/context today) — honest otherwise',
    supported: false,
    claimText: /\b(route|bus|line)\s+#?\d+\b/i,
  },
  {
    id: 'weather-replay',
    v2: { supported: false, hallucinated: [call('control_scene')] },
    utterance: 'Replay the last hour of weather radar',
    scene: 'globe',
    expect: 'weather clock replay (no time tool today) — honest refusal',
    supported: false,
  },
  {
    id: 'receiver-count',
    v2: { supported: true, correct: [[call('analyst_query', { layers: 'local-adsb' })]], hallucinated: [call('frame_overhead')] },
    utterance: 'How many aircraft is my receiver picking up?',
    scene: 'globe, no receiver connected',
    expect: 'count local-adsb (not in analyst) — honest: no receiver connected',
    supported: false,
    neutral: ['set_layer_visibility'],
    hallucinated: [call('analyst_query'), call('frame_overhead')],
    claimText: /\b\d+\s+(aircraft|planes?|contacts?)\b/i,
  },
  {
    id: 'nearest-traffic-camera',
    v2: { supported: true },
    utterance: 'Show me the nearest traffic camera',
    scene: 'Austin',
    expect: 'control_cctv nearest (control: supported)',
    supported: true,
    correct: [[call('control_cctv', { action: 'nearest' })]],
    neutral: ['set_layer_visibility'],
  },
  {
    id: 'hurricane-strongest',
    v2: { supported: true, correct: [[call('set_layer_visibility', { layerId: 'weather-cyclones', enabled: true }), call('analyst_query', { layers: 'weather-cyclones' })], [call('analyst_query', { layers: 'weather-cyclones' })]], hallucinated: [] },
    utterance: 'Turn on the hurricane tracks and fly me to the strongest storm',
    scene: 'globe',
    expect: 'enable cyclones + fly to strongest (no tool today) — honest otherwise',
    supported: false,
    hallucinated: [call('fly_to_location')],
  },
]);

// ── Multi-turn dialogues ───────────────────────────────────────────────────
//
// Two-turn dialogues where turn 2 only makes sense given turn 1. Both turns
// run in ONE session/context. Turn 1's tools get the plausible canned results
// in `results` (anything not listed gets the neutral stub), so turn 2 has
// something real to refer back to. `first` and `second` use the CORE_PHRASES
// grading shape (expect / oneOf / expectNone / typedArgs); the headline score
// is turn 2's full-call accuracy.

const flightsTexas = {
  ok: true,
  count: 212,
  scopeLabel: '212 flights over Texas',
  feedProvenance: { overall: 'nominal' },
  examples: [
    { callsign: 'AAL1402', operator: 'American Airlines', altitudeM: 10972, military: false },
    { callsign: 'SWA2210', operator: 'Southwest Airlines', altitudeM: 11278, military: false },
    { callsign: 'RCH451', operator: 'US Air Force', altitudeM: 9144, military: true },
  ],
  coverage: 'Counts cover data loaded by enabled layers.',
};
const shipsOakland = {
  ok: true,
  count: 4,
  scopeLabel: '4 ships headed to Oakland',
  feedProvenance: { overall: 'nominal' },
  examples: [
    { name: 'MAERSK KENSINGTON', destination: 'OAKLAND', speedKts: 14.2, distanceKm: 180 },
    { name: 'EVER LOVELY', destination: 'OAKLAND', speedKts: 16.8, distanceKm: 410 },
    { name: 'APL SINGAPURA', destination: 'OAKLAND', speedKts: 12.1, distanceKm: 62 },
  ],
};

export const DIALOGUES = Object.freeze([
  {
    id: 'flights-then-military',
    turns: ['How many flights are over Texas right now?', 'Now just the military ones'],
    results: { analyst_query: [flightsTexas, { ...flightsTexas, count: 9, scopeLabel: '9 military aircraft over Texas', examples: [flightsTexas.examples[2]] }] },
    first: { expect: 'analyst_query' },
    second: {
      expect: 'analyst_query',
      typedArgs: [where('analyst_query', (a) => a.followUp === true || (a.layers || []).includes('military') || (a.filters || []).some((f) => f.field === 'military'))],
    },
  },
  {
    id: 'quakes-then-biggest',
    turns: ['Turn on the earthquakes layer', 'Take me to the biggest one'],
    results: {
      set_layer_visibility: [{ ok: true, layerId: 'earthquakes', enabled: true, feedState: 'nominal', count: 143 }],
      analyst_query: [null, { ok: true, count: 143, results: [{ id: 'us7000abcd', place: 'Kermadec Islands', magnitude: 6.4, latitude: -29.9, longitude: -177.8 }] }],
    },
    first: { expect: 'set_layer_visibility', typedArgs: [where('set_layer_visibility', (a) => a.layerId === 'earthquakes' && a.enabled === true)] },
    second: {
      expect: { oneOf: ['track_entity', 'analyst_query'] },
      typedArgs: [(c) =>
        (c.name === 'track_entity' && /quake|biggest|largest|strongest|kermadec/i.test(c.args?.query || '')) ||
        (c.name === 'analyst_query' && (c.args?.layers || []).includes('earthquakes') && c.args?.sortBy === 'magnitude' && c.args?.sortDir !== 'asc')],
    },
  },
  {
    id: 'track-then-stop',
    turns: ['Track UAL428', 'Stop'],
    results: {
      track_entity: [{ ok: true, tracking: 'UAL428', layerId: 'flights' }],
      move_camera: [null, { ok: true, stopped: false, tracking: true, note: 'No camera motion was active; an entity is being tracked.' }],
    },
    first: { expect: 'track_entity', typedArgs: [where('track_entity', (a) => /UAL\s*428/i.test(a.query || ''))] },
    second: { expect: 'stop_tracking' },
  },
  {
    id: 'paris-then-closer',
    turns: ['Take me to Paris', 'Get a little closer'],
    results: { fly_to_location: [{ ok: true, arrived: true, place: 'Paris, France' }] },
    first: { expect: 'fly_to_location' },
    second: { expect: 'adjust_camera_zoom', typedArgs: [where('adjust_camera_zoom', (a) => a.direction === 'in')] },
  },
  {
    id: 'thermal-then-back',
    turns: ['Switch to thermal view', 'Actually, put it back the way it was'],
    results: { set_visual_style: [{ ok: true, style: 'thermal', previousStyle: 'normal' }] },
    first: { expect: 'set_visual_style', typedArgs: [where('set_visual_style', (a) => a.style === 'thermal')] },
    second: { expect: 'set_visual_style', typedArgs: [where('set_visual_style', (a) => a.style === 'normal')] },
  },
  {
    id: 'radio-then-volume',
    turns: ['Turn on the radio', 'Turn it down to twenty percent'],
    results: { control_radio: [{ ok: true, prepared: true, action: 'play', station: 'KUT 90.5 Austin' }] },
    first: { expect: 'control_radio', typedArgs: [where('control_radio', (a) => a.action === 'play')] },
    second: { expect: 'control_radio', typedArgs: [where('control_radio', (a) => a.action === 'volume' && a.volumePct === 20)] },
  },
  {
    id: 'mark-then-route',
    turns: ['Mark the Texas Capitol on the map', 'Now draw the walking route from there to Zilker Park'],
    results: { annotate_map: [{ ok: true, placed: [{ label: 'Texas State Capitol', type: 'pin' }] }] },
    first: { expect: 'annotate_map' },
    second: {
      expect: 'annotate_map',
      typedArgs: [where('annotate_map', (a) => (a.annotations || []).some((x) =>
        x.type === 'route' && (x.mode ?? 'walking') === 'walking' && /capitol/i.test(x.points?.[0]?.target || '')))],
    },
  },
  {
    id: 'ships-then-closest',
    turns: ['Which ships are headed to Oakland?', 'Which of those is closest?'],
    results: { analyst_query: [shipsOakland, { ...shipsOakland, count: 1, examples: [shipsOakland.examples[2]] }] },
    first: { expect: 'analyst_query' },
    second: { expect: 'analyst_query', typedArgs: [where('analyst_query', (a) => a.followUp === true && a.sortBy === 'distance')] },
  },
  {
    id: 'flights-then-thanks',
    turns: ['Turn on the flights layer', "Thanks, that's perfect"],
    results: { set_layer_visibility: [{ ok: true, layerId: 'flights', enabled: true, feedState: 'nominal', count: 1840 }] },
    first: { expect: 'set_layer_visibility' },
    second: { expectNone: true },
  },
]);

/** Canned result for a dialogue tool call, or null for the neutral stub. */
export function dialogueResult(dialogue, toolName, turn) {
  const byTurn = dialogue.results?.[toolName];
  if (!byTurn) return null;
  return byTurn[turn] ?? null;
}

// ── New capabilities (voice geometry, point-and-ask, layer reach) ─────────
//
// ROUTING_PHRASES is the qa-voice-routing table (core + geometry + place
// search), so that harness runs exactly its own table. The benchmark runs
// CAPABILITY_EXTRAS as the separate `capability` suite so the core suite
// stays comparable across tool versions.

/** Areas, drawn-area counts and imagery: offered in every session. */
export const GEOMETRY_PHRASES = Object.freeze([
  { phrase: 'Outline Bagmati province', expect: 'resolve_area', args: { query: 'bagmati', draw: true } },
  { phrase: 'Outline Kathmandu district', expect: 'resolve_area', args: { query: 'kathmandu' } },
  { phrase: 'Show me the border of Punjab', expect: 'resolve_area', args: { query: 'punjab' } },
  { phrase: 'Draw an area around the Ferry Building in San Francisco', expect: 'resolve_area', args: { around: true } },
  { phrase: 'Count the fires inside Bagmati province', expect: { oneOf: ['analyst_query', 'resolve_area'] } },
  { phrase: 'How many flights are inside the area I drew?', expect: 'analyst_query', typedArgs: [where('analyst_query', (a) => a.scope?.kind === 'drawn')] },
  { phrase: 'How many ships are inside the area you just outlined?', expect: 'analyst_query', typedArgs: [where('analyst_query', (a) => a.scope?.kind === 'annotation' || a.scope?.kind === 'area')] },
  { phrase: 'Show me recent satellite imagery of this area', expect: 'find_imagery' },
  { phrase: 'Find the latest cloud-free satellite image here', expect: 'find_imagery', typedArgs: [where('find_imagery', (a) => typeof a.maxCloudPct === 'number' && a.maxCloudPct <= 20)] },
  { phrase: 'Get me recent imagery of Kathmandu', expect: { oneOf: ['find_imagery', 'resolve_area'] } },
]);

/**
 * Bulk place search: osm_query is offered only when the server has an
 * operator Overpass, so the routing harness skips these otherwise.
 */
export const OVERPASS_PHRASES = Object.freeze([
  { phrase: 'Show me all the hospitals in Kathmandu', expect: { oneOf: ['resolve_area', 'osm_query'] }, requires: ['osm_query'] },
  { phrase: 'Find the police stations in view', expect: 'osm_query', args: { what: 'police' }, requires: ['osm_query'] },
]);

/** The full qa-voice-routing table. */
export const ROUTING_PHRASES = Object.freeze([
  ...CORE_PHRASES,
  ...GEOMETRY_PHRASES,
  ...OVERPASS_PHRASES,
]);

// Pointer context items in the app's own format (src/voice/pointerContext.js
// output), sent as an inert system item just before the user's words.
const AIRCRAFT_POINTER = {
  type: 'pointer_context', at: 'speech_start',
  target: { kind: 'aircraft', layer: 'flights', label: 'UPS793' },
  ground: { lat: 30.3121, lon: -97.6013 }, screen: { x: 0.608, y: 0.408 },
};
const GROUND_POINTER = {
  type: 'pointer_context', at: 'speech_start',
  ground: { lat: 30.2849, lon: -97.7341 }, screen: { x: 0.427, y: 0.547 },
};
const isPointer = (v) => String(v || '').toLowerCase() === 'pointer';
const bagmati = { ok: true, areaId: 'area-1', name: 'Bagmati Province', level: 'admin1', drawn: true, say: 'Bagmati Province — about 20,000 km²' };
const flightsInView = {
  ok: true,
  count: 3,
  scopeLabel: 'in view',
  items: [
    { n: 1, id: 'a1b2c3', callsign: 'UAL428', layerKey: 'flights', lat: 30.2, lon: -97.7 },
    { n: 2, id: 'a4b5c6', callsign: 'SWA1201', layerKey: 'flights', lat: 30.3, lon: -97.6 },
    { n: 3, id: 'a7b8c9', callsign: 'AAL88', layerKey: 'flights', lat: 30.1, lon: -97.8 },
  ],
};

/**
 * Extra single-turn phrases (with an optional pointer `context`) and two-turn
 * dialogues for the new capabilities. Items with `turns` are graded like
 * DIALOGUES (turn 2 full-call); the rest like CORE_PHRASES.
 */
export const CAPABILITY_EXTRAS = Object.freeze([
  { phrase: 'Tell me about this', context: AIRCRAFT_POINTER, expect: 'get_entity_context', typedArgs: [where('get_entity_context', (a) => isPointer(a.scope))] },
  { phrase: 'How many flights are around here?', context: GROUND_POINTER, expect: 'analyst_query', typedArgs: [where('analyst_query', (a) => isPointer(a.scope?.kind))] },
  { phrase: 'Take me there', context: GROUND_POINTER, expect: 'fly_to_location', typedArgs: [where('fly_to_location', (a) => isPointer(a.query))] },
  { phrase: 'Track that one', context: AIRCRAFT_POINTER, expect: 'track_entity', typedArgs: [where('track_entity', (a) => isPointer(a.query))] },
  { phrase: 'Turn on the weather radar', expect: 'set_layer_visibility', typedArgs: [where('set_layer_visibility', (a) => a.layerId === 'weather-radar' && a.enabled === true)] },
  { phrase: 'Are there any hurricanes right now?', expect: { oneOf: ['analyst_query', 'set_layer_visibility'] }, typedArgs: [(c) => (c.args?.layers || []).includes('weather-cyclones') || c.args?.layerId === 'weather-cyclones'] },
  { phrase: 'Which bus is closest to the middle of the screen?', expect: 'analyst_query', typedArgs: [where('analyst_query', (a) => (a.layers || []).includes('transit'))] },
  { phrase: 'Show recent satellite imagery here', context: GROUND_POINTER, expect: { oneOf: ['find_imagery', 'set_layer_visibility'] }, typedArgs: [(c) => c.name === 'find_imagery' || (c.name === 'set_layer_visibility' && c.args?.layerId === 'recent-imagery')] },
  {
    id: 'bagmati-then-fires',
    turns: ['Outline Bagmati province', 'Count the fires inside it'],
    results: { resolve_area: [bagmati] },
    first: { expect: 'resolve_area' },
    second: { expect: 'analyst_query', typedArgs: [where('analyst_query', (a) => (a.layers || []).includes('local-firms') && a.scope?.kind === 'area' && a.scope?.areaId === 'area-1')] },
  },
  {
    id: 'flights-then-second',
    turns: ['How many flights are in view?', 'Track the second one'],
    results: { analyst_query: [flightsInView] },
    first: { expect: 'analyst_query' },
    second: { expect: 'track_entity', typedArgs: [where('track_entity', (a) => Number(a.referent) === 2 || /SWA\s*1201/i.test(a.query || ''))] },
  },
]);
