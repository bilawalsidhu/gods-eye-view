/** Links that open God's Eye View at a view. */

import { VIEW_PROPERTIES, createView, viewUrl } from '../../view/index.js';
import { defineTool, ToolError } from '../catalog.js';
import { GLOBE_PANEL_URI } from '../globePanel.js';
import { AREA_SCHEMA, resolveArea } from '../area.js';
import { cameraForArea, cameraLookingAt } from '../views.js';

/** Tool arguments that describe a view: an area to frame, or a camera. */
const VIEW_ARGUMENTS = Object.freeze({
  view: Object.freeze({
    type: 'object',
    description:
      'A view another answer returned (its data.view), shown as it is; ' +
      'other arguments given with it change that part of it.',
  }),
  area: AREA_SCHEMA,
  ...VIEW_PROPERTIES,
});

// Altitude a view framed on a followed aircraft starts from.
const FOLLOW_ALTITUDE_M = 20_000;

/** Where a followed aircraft is now, or null when no feed reports it. */
async function followedAircraftPosition(follow, tools) {
  if (!['aircraft', 'military_aircraft'].includes(follow?.kind)) return null;
  if (!tools?.has('find_aircraft')) return null;
  try {
    const { data } = await tools.call('find_aircraft', { icao24: follow.id });
    const row = data?.rows?.find(
      (item) => Number.isFinite(item.lat) && Number.isFinite(item.lon),
    );
    return row ? { lat: row.lat, lon: row.lon } : null;
  } catch {
    return null;
  }
}

/**
 * The view described by tool arguments. An area frames the camera straight
 * down over it; camera fields given alongside it override the framing. A
 * view that only follows an aircraft is framed where the aircraft is now.
 */
export async function resolveViewArguments(args, { services, signal, tools }) {
  const base = args.view && typeof args.view === 'object' ? args.view : {};
  let camera = args.area
    ? { ...args.camera }
    : { ...base.camera, ...args.camera };
  let label = null;
  // Street-level photos open at the area's centre unless a point is given;
  // a new area moves a passed-through view's photos with it.
  let streetLevel =
    args.street_level && typeof args.street_level === 'object'
      ? { ...args.street_level }
      : base.street_level && typeof base.street_level === 'object'
        ? args.area
          ? { provider: base.street_level.provider }
          : { ...base.street_level }
        : null;
  if (args.area) {
    const area = await resolveArea(args.area, { services, signal });
    label = area.label;
    const framed = cameraForArea(area);
    if (
      streetLevel &&
      streetLevel.lat === undefined &&
      streetLevel.lon === undefined
    )
      streetLevel = { ...streetLevel, lat: framed.lat, lon: framed.lon };
    // A tilted view of an area looks at its center from behind, unless the
    // caller placed the camera itself.
    camera =
      camera.lat === undefined && camera.lon === undefined
        ? cameraLookingAt(framed, {
            altitudeM: camera.altitude_m ?? framed.altitude_m,
            headingDeg: camera.heading_deg ?? 0,
            pitchDeg: camera.pitch_deg ?? -90,
          })
        : { ...framed, ...camera };
  }
  const follow = args.follow ?? base.follow ?? null;
  if (!Number.isFinite(camera.lat) || !Number.isFinite(camera.lon)) {
    const position = await followedAircraftPosition(follow, tools);
    if (!position)
      throw new ToolError(
        'invalid_arguments',
        follow
          ? `${follow.id} is not reported now; give an area or a camera with lat and lon too`
          : 'Give a view, an area, or a camera with lat and lon',
      );
    camera = { altitude_m: FOLLOW_ALTITUDE_M, ...camera, ...position };
    label = `${follow.kind === 'military_aircraft' ? 'military aircraft' : 'aircraft'} ${follow.id}`;
  }
  let view;
  try {
    view = createView({
      camera,
      layers: args.layers ?? base.layers,
      style: args.style ?? base.style ?? null,
      map: args.map ?? base.map ?? null,
      follow,
      annotations: args.annotations ?? base.annotations ?? [],
      street_level: streetLevel,
    });
  } catch (error) {
    // A view passed through can hold anything; report it as bad arguments.
    throw new ToolError('invalid_arguments', error.message);
  }
  return {
    view,
    label:
      label ?? `${view.camera.lat.toFixed(3)}, ${view.camera.lon.toFixed(3)}`,
  };
}

function appBase(services) {
  try {
    return new URL(services.app.baseUrl).href;
  } catch {
    throw new ToolError('unavailable', "The app's address is not configured");
  }
}

export const showInGodsEyeView = defineTool({
  name: 'show_in_gods_eye_view',
  title: "Show in God's Eye View",
  description:
    "Shows a view in God's Eye View: in clients that display apps, the live " +
    "God's Eye View globe in the conversation; everywhere, a link that opens " +
    'it. Pass the view another answer returned, or describe one: an area ' +
    'framed from above or a camera position, with chosen data layers, visual ' +
    'style and map, optionally following an aircraft (or riding in its ' +
    'cockpit view) or a satellite, with marks drawn on the map, or opening ' +
    'street-level photos (Google Street View, Mapillary, KartaView or ' +
    'Panoramax) at a place.',
  inputSchema: {
    type: 'object',
    properties: VIEW_ARGUMENTS,
    additionalProperties: false,
  },
  requires: ['app'],
  ui: { resourceUri: GLOBE_PANEL_URI },
  async run(args, { services, signal, tools }) {
    const base = appBase(services);
    const { view, label } = await resolveViewArguments(args, {
      services,
      signal,
      tools,
    });
    const url = viewUrl(base, view);
    return {
      summary: `Open ${label} in God's Eye View: ${url}`,
      data: { url, view },
    };
  },
});
