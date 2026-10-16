/** Composite queries that combine other tools' answers for one area. */

import { suggestView } from '../views.js';
import { feedProvenanceEnvelope } from '../../data/layerSnapshot.js';
import { defineTool, ToolError } from '../catalog.js';
import {
  AREA_SCHEMA,
  POINT_SCHEMA,
  areaCenter,
  resolveArea,
  resolvePoint,
} from '../area.js';

const SECTION_LIMIT = 5;
const AWARENESS_LIMIT = 10;
const AWARENESS_RADIUS_KM = 250;

/** Brief sections: the tool each one calls and the arguments it passes. */
const SECTIONS = [
  {
    key: 'weather',
    label: 'Weather',
    tool: 'get_weather',
    args: (area, center) => ({
      location: area.argument.place
        ? { place: area.argument.place }
        : { lat: center.lat, lon: center.lon },
    }),
  },
  {
    key: 'earthquakes',
    layer: 'earthquakes',
    label: 'Earthquakes',
    tool: 'get_earthquakes',
    args: (area) => ({ area: area.argument, limit: SECTION_LIMIT }),
  },
  {
    key: 'fires',
    layer: 'local-firms',
    label: 'Active fires',
    tool: 'get_active_fires',
    args: (area) => ({ area: area.argument, limit: SECTION_LIMIT }),
  },
  {
    key: 'aircraft',
    layer: 'flights',
    label: 'Aircraft',
    tool: 'aircraft_in_area',
    args: (area) => ({ area: area.argument, limit: SECTION_LIMIT }),
  },
  {
    key: 'vessels',
    layer: 'ais-live-vessels',
    label: 'Ships',
    tool: 'vessels_in_area',
    args: (area) => ({ area: area.argument, limit: SECTION_LIMIT }),
  },
  {
    key: 'cyclones',
    layer: 'weather-cyclones',
    label: 'Tropical cyclones',
    tool: 'get_cyclones',
    args: (area) => ({ area: area.argument }),
  },
];

/** Military contacts around a point, as the app's military awareness panel. */
const AWARENESS_SECTIONS = [
  {
    key: 'military_aircraft',
    tool: 'aircraft_in_area',
    args: (area) => ({
      area: area.argument,
      military: true,
      limit: AWARENESS_LIMIT,
    }),
  },
  {
    key: 'aircraft',
    tool: 'aircraft_in_area',
    args: (area) => ({ area: area.argument, limit: AWARENESS_LIMIT }),
  },
  {
    key: 'vessels',
    tool: 'vessels_in_area',
    args: (area) => ({ area: area.argument, limit: AWARENESS_LIMIT }),
  },
  {
    key: 'installations',
    tool: 'find_military_installations',
    args: (area) => ({ area: area.argument, limit: AWARENESS_LIMIT }),
  },
];

/** A section's feed state for the caption, from what its result reported. */
function sectionFeedState(section) {
  if (section.unavailable) return 'unavailable';
  const data = section.data || {};
  if (data.freshness === 'stale' || data.stale === true) return 'stale';
  // Answered, but some of the feeds or satellites behind it did not.
  if (data.missing_sources?.length || data.unavailable_feeds?.length)
    return 'degraded';
  return 'nominal';
}

/**
 * The resolved area, plus the argument sections receive. A named place is
 * passed by name, so sections resolve it to the same point and label as a
 * direct query does (place lookups are cached).
 */
function sectionArea(resolved, original) {
  return {
    ...resolved,
    argument: original?.place
      ? { place: original.place }
      : resolved.center
        ? {
            lat: resolved.center.lat,
            lon: resolved.center.lon,
            radius_km: resolved.center.radiusKm,
          }
        : {
            bbox: [
              resolved.west,
              resolved.south,
              resolved.east,
              resolved.north,
            ],
          },
  };
}

/**
 * Run every section whose tool the catalog offers, through the catalog so
 * replaced tools and interceptors apply. A failing section is reported as
 * unavailable instead of failing the whole answer.
 */
async function runSections(all, area, { tools, signal }) {
  const center = areaCenter(area);
  const sections = all.filter(({ tool }) => tools.has(tool));
  const results = await Promise.allSettled(
    sections.map(({ tool, args: build }) =>
      tools.call(tool, build(area, center)),
    ),
  );
  signal?.throwIfAborted();
  const answers = {};
  const lines = [];
  sections.forEach(({ key }, index) => {
    const result = results[index];
    if (result.status === 'fulfilled') {
      answers[key] = { summary: result.value.summary, data: result.value.data };
      lines.push(result.value.summary);
    } else {
      const known = result.reason instanceof ToolError;
      answers[key] = {
        unavailable: true,
        reason: known ? result.reason.message : 'unavailable right now',
      };
    }
  });
  return { center, answers, lines };
}

async function buildBrief(args, { services, signal, tools }) {
  // Sections receive the resolved box so a place name is looked up once.
  const area = sectionArea(
    await resolveArea(args.area, { services, signal }),
    args.area,
  );
  const { center, answers, lines } = await runSections(SECTIONS, area, {
    tools,
    signal,
  });
  return { area, center, brief: answers, lines };
}

export const situationBrief = defineTool({
  name: 'situation_brief',
  title: 'Situation brief',
  description:
    'One overview of an area: current weather, recent earthquakes, active ' +
    'fires, aircraft overhead, ships and tropical cyclones, each summarized with ' +
    'its top items. Sections that are unavailable are marked as such.',
  inputSchema: {
    type: 'object',
    properties: { area: AREA_SCHEMA },
    required: ['area'],
    additionalProperties: false,
  },
  requires: ['weather'],
  async run(args, context) {
    const { area, brief, lines } = await buildBrief(args, context);
    return {
      summary: `Situation in ${area.label}: ${lines.join(' ')}`,
      data: {
        view: suggestView(context.services, {
          area,
          layers: SECTIONS.filter(({ key }) => brief[key])
            .map(({ layer }) => layer)
            .filter(Boolean),
        }),
        area: area.label,
        sections: brief,
      },
    };
  },
});

export const getHudCaption = defineTool({
  name: 'get_hud_caption',
  title: 'Heads-up display caption',
  description:
    "The short heads-up display caption God's Eye View would show for an " +
    'area, written by the app from the same overview situation_brief gives.',
  inputSchema: {
    type: 'object',
    properties: { area: AREA_SCHEMA },
    required: ['area'],
    additionalProperties: false,
  },
  requires: ['weather', 'summary'],
  async run(args, context) {
    const { area, center, brief, lines } = await buildBrief(args, context);
    // The app's caption context: place labels and each section as a layer
    // with the feed state its result reported, failures included.
    const layers = SECTIONS.filter(({ key }) => brief[key]).map(
      ({ key, label }) => ({
        id: key,
        name: label,
        enabled: true,
        feedState: sectionFeedState(brief[key]),
      }),
    );
    const response = await context.services.summary.summarize(
      {
        placeLabels: [area.label],
        location: area.label,
        center,
        observations: lines,
        enabledLayerLabels: layers.map((layer) => layer.name),
        enabledLayers: layers.map(({ id, name, feedState }) => ({
          id,
          name,
          feedState,
        })),
        feedProvenance: feedProvenanceEnvelope(layers),
      },
      { signal: context.signal },
    );
    const caption = response?.data?.summary;
    if (!response?.ok || typeof caption !== 'string' || !caption)
      throw new ToolError('unavailable', 'The caption service did not answer');
    return {
      summary: caption,
      data: { area: area.label, caption },
    };
  },
});

export const militaryAwareness = defineTool({
  name: 'military_awareness',
  title: 'Military awareness',
  description:
    'Military contacts around a location, as the military awareness panel ' +
    'shows them: military aircraft, other aircraft, ships and mapped ' +
    `military installations within ${AWARENESS_RADIUS_KM} km by default, ` +
    'each nearest first. Sections that are unavailable are marked as such.',
  inputSchema: {
    type: 'object',
    properties: {
      location: POINT_SCHEMA,
      radius_km: { type: 'number', minimum: 1, maximum: AWARENESS_RADIUS_KM },
    },
    required: ['location'],
    additionalProperties: false,
  },
  requires: ['military'],
  async run(args, { services, signal, tools }) {
    const point = await resolvePoint(args.location, { services, signal });
    const radiusKm = args.radius_km ?? AWARENESS_RADIUS_KM;
    const area = sectionArea(
      await resolveArea(
        { lat: point.lat, lon: point.lon, radius_km: radiusKm },
        { services, signal },
      ),
    );
    const { answers, lines } = await runSections(AWARENESS_SECTIONS, area, {
      tools,
      signal,
    });
    return {
      summary: `Military awareness within ${radiusKm} km of ${point.label}: ${lines.join(' ')}`,
      data: {
        view: suggestView(services, {
          area,
          layers: ['military', 'ais-live-vessels', 'military-installations'],
        }),
        location: point,
        radius_km: radiusKm,
        sections: answers,
      },
    };
  },
});
