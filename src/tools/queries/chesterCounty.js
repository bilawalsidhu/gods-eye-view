/** Public Chester County DES incident summaries and on-demand unit status. */
import { defineTool, ToolError } from '../catalog.js';
import { capRows, isoTime, LIMIT_SCHEMA } from '../results.js';
import { suggestView } from '../views.js';
import {
  COUNTIES,
  countyFor,
  COUNTY_INCIDENT_ID_PATTERN,
} from '../../layers/chesterCountyEms/counties.js';

const SOURCE = 'https://www.chesco.org/3963/WebCad-Active-Incidents';
const CAVEAT =
  'Chester County DES public WebCAD reports, including mutual aid; not a statewide EMS feed. GIS positions are approximate, not exact scenes. Unresolved reports have no coordinates. Unit status is public dispatch information, not patient records.';
const clockStale = (snapshot) =>
  Boolean(
    snapshot.stale ||
    (!snapshot.countyFeeds && Date.now() - snapshot.observedAt > 180000) ||
    snapshot.observedAt > Date.now() + 60000,
  );

async function readSnapshot(service, signal, generic = false) {
  let snapshot;
  try {
    snapshot = await service.getSnapshot({ signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ToolError(
      'unavailable',
      generic
        ? 'County public incidents are unavailable; retry later.'
        : 'Chester County public incidents are unavailable; retry later.',
    );
  }
  if (
    !Array.isArray(snapshot?.rows) ||
    !Number.isFinite(snapshot.observedAt) ||
    !Number.isFinite(snapshot.fetchedAt)
  )
    throw new ToolError(
      'malformed',
      generic
        ? 'County source returned an invalid incident snapshot.'
        : 'Chester County returned an invalid incident snapshot.',
    );
  return snapshot;
}
function incidentRow(row, generic = false) {
  const mapped =
    Number.isFinite(row.mapPosition?.lat) &&
    Number.isFinite(row.mapPosition?.lon);
  return {
    id: row.id,
    ...(generic
      ? { county_id: countyFor(row).id, county: countyFor(row).name }
      : {}),
    incident_number: row.incidentNumber,
    category: row.category,
    incident_type: row.type,
    location: row.location,
    municipality: row.municipality,
    dispatched_at: isoTime(row.dispatchedAt),
    ...(row.timeBasis === 'received'
      ? {
          received_at: isoTime(row.receivedAt),
          received_time_local: row.dispatched,
          timezone_assumed: !!row.timezoneAssumed,
        }
      : row.timeBasis === 'reported'
        ? {
            reported_at: isoTime(row.reportedAt),
            reported_time_local: row.dispatched,
          }
        : {}),
    ...(generic
      ? {
          report_kind:
            row.reportKind === 'completed'
              ? 'completed-report'
              : row.reportKind === 'dispatch'
                ? 'recent-dispatch'
                : 'active-incident',
          active_status:
            row.reportKind === 'completed'
              ? 'completed'
              : row.reportKind === 'dispatch'
                ? 'unknown'
                : 'listed-active',
          source_official: row.official !== false,
          ...(row.crossStreets ? { cross_streets: row.crossStreets } : {}),
          ...(row.nearestIntersection
            ? { nearest_intersection: row.nearestIntersection }
            : {}),
          ...(row.box ? { box: row.box } : {}),
        }
      : {}),
    dispatch_time_local: row.timeBasis ? null : row.dispatched,
    timezone: 'America/New_York',
    ...(generic ? { time_precision: row.timePrecision || 'second' } : {}),
    ...(row.category === 'traffic' && countyFor(row).id === 'chester-pa'
      ? { agency: row.station }
      : { station: row.station }),
    position: mapped
      ? {
          lat: row.mapPosition.lat,
          lon: row.mapPosition.lon,
          kind: row.mapPosition.kind,
          approximate: true,
          gis_match: row.mapPosition.matchedLocation ?? null,
        }
      : null,
    location_status: row.locationStatus ?? (mapped ? 'matched' : 'unmatched'),
    source_url: row.detailUrl || (generic ? countyFor(row).url : SOURCE),
  };
}
function provenance(snapshot, generic = false) {
  if (generic)
    return {
      source: 'County EMS public feeds',
      sources: (snapshot.countyFeeds || []).map((feed) => ({
        county_id: feed.id,
        county: feed.county,
        source_url: COUNTIES.find((county) => county.id === feed.id)?.url,
        observed_at: isoTime(feed.observedAt),
        fetched_at: isoTime(feed.fetchedAt),
        stale: feed.stale,
        unavailable: !!feed.unavailable,
        count: feed.count,
        timestamp_basis: feed.timestampBasis || 'source',
        coverage_kind: feed.coverageKind || 'active-incidents',
        official: feed.official !== false,
        limited: !!feed.limited,
        source_limit: feed.sourceLimit,
        recent_window_minutes: feed.recentWindowMinutes,
        excluded_unclassified_count: feed.excludedCount,
      })),
      observed_at: isoTime(snapshot.observedAt),
      fetched_at: isoTime(snapshot.fetchedAt),
      stale: clockStale(snapshot),
      caveat:
        'Supported Pennsylvania sources: Chester, Montgomery, Lancaster, Dauphin, York and Adams active lists; Pike current-day completed press reports; Delaware and Lebanon recent community pager summaries with unknown active status. Delco is limited to newest 20 pages within two hours; Lebanon uses 717 Alerts public live data filtered to recent two hours and excludes resolved reports, with no official active-status claim. Received clocks from community sources assume Eastern. No municipality centroid pins. Unmapped reports remain included. Some sources publish no coordinates or unit movements; these are not lookup failures. Adams natures that cannot be classified are excluded and counted. Traffic is not a full police-call feed. Checked times mean retrieval. No raw notes or patient records.',
    };
  return {
    source: 'Chester County DES WebCAD',
    source_url: SOURCE,
    observed_at: isoTime(snapshot.observedAt),
    fetched_at: isoTime(snapshot.fetchedAt),
    stale: clockStale(snapshot),
    caveat: CAVEAT,
  };
}
function view(services, row, generic = false) {
  return suggestView(services, {
    point:
      row?.position ||
      (generic ? { lat: 40.12, lon: -75.55 } : { lat: 40, lon: -75.75 }),
    altitudeM: row?.position ? 3000 : 100000,
    layers: ['chester-county-ems'],
  });
}

function createIncidentTools(generic = false) {
  const serviceName = generic ? 'countyIncidents' : 'chesterCounty';
  const getChesterCountyIncidents = defineTool({
    name: generic ? 'get_county_incidents' : 'get_chester_county_incidents',
    title: generic
      ? 'County EMS public incidents'
      : 'Chester County fire, EMS and traffic incidents',
    description: generic
      ? 'List nine Pennsylvania County EMS sources: Chester, Montgomery, Lancaster, Dauphin, York and Adams active lists; Pike completed reports; Delaware and Lebanon recent community pager summaries with unknown active status. Each row identifies report kind; never describe Pike as active. Filter by county ID, category, municipality or text; preserve unmapped reports and source provenance. Use get_county_incident_details for public units.'
      : 'List current public Chester County, Pennsylvania (Chesco) WebCAD fire, EMS and traffic reports, including unresolved locations. Filter by category, municipality or report text. Returns source times, stale status and approximate GIS positions; not exact scenes or statewide coverage. Use a returned id with get_chester_county_incident_details for public unit status.',
    inputSchema: {
      type: 'object',
      properties: {
        ...(generic
          ? {
              county: {
                type: 'string',
                enum: COUNTIES.map((county) => county.id),
              },
            }
          : {}),
        category: { type: 'string', enum: ['fire', 'ems', 'traffic'] },
        municipality: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          description:
            'Case-insensitive part of the reported municipality name.',
        },
        search: {
          type: 'string',
          minLength: 1,
          maxLength: 160,
          description:
            'Case-insensitive text in the incident number, type, location, municipality or station/agency.',
        },
        limit: LIMIT_SCHEMA,
      },
      additionalProperties: false,
    },
    requires: [serviceName],
    async run(args, { services, signal }) {
      const snapshot = await readSnapshot(
        services[serviceName],
        signal,
        generic,
      );
      const municipality = args.municipality?.trim().toLowerCase();
      const search = args.search?.trim().toLowerCase();
      const rows = snapshot.rows
        .filter(
          (row) =>
            (!args.county || countyFor(row).id === args.county) &&
            (!args.category || row.category === args.category) &&
            (!municipality ||
              row.municipality?.toLowerCase().includes(municipality)) &&
            (!search ||
              [
                row.incidentNumber,
                row.type,
                row.location,
                row.municipality,
                row.station,
              ].some((text) =>
                String(text ?? '')
                  .toLowerCase()
                  .includes(search),
              )),
        )
        .toSorted(
          (a, b) =>
            (b.dispatchedAt || b.receivedAt || b.reportedAt || 0) -
            (a.dispatchedAt || a.receivedAt || a.reportedAt || 0),
        )
        .map((row) => incidentRow(row, generic));
      const result = capRows(rows, args.limit);
      return {
        summary: `${rows.length} matching ${generic ? 'County EMS' : 'Chester County DES'} public incident${rows.length === 1 ? '' : 's'}${clockStale(snapshot) ? ' (stale feed)' : ''}; ${rows.filter((row) => !row.position).length} without mapped locations.`,
        data: {
          ...provenance(snapshot, generic),
          ...result,
          feed_total: snapshot.rows.length,
          view: view(services, undefined, generic),
          location_coverage: {
            mapped: rows.filter((row) => row.position).length,
            unresolved: rows.filter(
              (row) => !row.position && row.location_status !== 'unavailable',
            ).length,
            lookup_errors: rows.filter(
              (row) => row.location_status === 'unavailable',
            ).length,
          },
        },
      };
    },
  });

  const getChesterCountyIncidentDetails = defineTool({
    name: generic
      ? 'get_county_incident_details'
      : 'get_chester_county_incident_details',
    title: generic
      ? 'County EMS public unit status'
      : 'Chester County incident unit status',
    description: generic
      ? 'Read public County EMS units for Chester, Montgomery, Lancaster or Delaware. Use an exact ID from get_county_incidents. Lancaster/Delco provide assignments only, without movement times/statuses; Delco active status is unknown. Montgomery times omit dates. No raw paging messages, private dispatch notes or patient data.'
      : 'Read a current Chester County public incident and its public unit IDs, statuses and status-entry timestamps. Use the category-qualified id from get_chester_county_incidents (for example ems:F26000001). Does not fetch private dispatch notes or patient data. Failed unit lookups retain the incident summary with details unavailable.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          pattern: generic
            ? COUNTY_INCIDENT_ID_PATTERN
            : '^(fire|ems|traffic):[FP][0-9]{8}$',
          maxLength: generic ? 80 : 18,
        },
        limit: LIMIT_SCHEMA,
      },
      required: ['id'],
      additionalProperties: false,
    },
    requires: [serviceName],
    async run(args, { services, signal }) {
      const snapshot = await readSnapshot(
        services[serviceName],
        signal,
        generic,
      );
      const sourceRow = snapshot.rows.find((row) => row.id === args.id);
      if (!sourceRow)
        throw new ToolError(
          'unavailable',
          'This incident is absent from the current public snapshot. List current incidents first.',
        );
      const incident = incidentRow(sourceRow, generic);
      const ownFeed =
        generic &&
        snapshot.countyFeeds?.find(
          (feed) => feed.id === countyFor(sourceRow).id,
        );
      const incidentSnapshot = ownFeed
        ? {
            ...snapshot,
            stale: ownFeed.stale || ownFeed.unavailable,
            countyFeeds: [ownFeed],
          }
        : snapshot;
      let details = null;
      try {
        if (sourceRow.detailUrl && services[serviceName].getIncidentDetails)
          details = await services[serviceName].getIncidentDetails(args.id, {
            signal,
          });
      } catch (error) {
        if (signal?.aborted) throw error;
      }
      if (
        details &&
        (!Array.isArray(details.units) ||
          !Number.isFinite(details.observedAt) ||
          details.incidentNumber !== sourceRow.incidentNumber ||
          (details.id && details.id !== args.id))
      )
        throw new ToolError(
          'malformed',
          'The unit-status reply does not match this incident.',
        );
      const updates = details ? capRows(details.units, args.limit) : null;
      const detailsStale = details ? clockStale(details) : null;
      return {
        summary: `${incident.incident_number || 'Public report'}: ${incident.incident_type}, ${incident.municipality}; ${details ? `${new Set(details.units.map((unit) => unit.unit)).size} public units${detailsStale ? ' (stale unit status)' : ''}` : 'unit status unavailable'}${clockStale(incidentSnapshot) ? '; stale incident feed' : ''}.`,
        data: {
          ...provenance(incidentSnapshot, generic),
          incident,
          view: view(services, incident, generic),
          details_available: Boolean(details),
          unit_status: details
            ? {
                observed_at: isoTime(details.observedAt),
                fetched_at: isoTime(details.fetchedAt),
                stale: detailsStale,
                ...(generic
                  ? {
                      timestamp_basis: details.timestampBasis || 'source',
                      assignment_only: !!details.assignmentOnly,
                      status_times_available: !details.assignmentOnly,
                    }
                  : {}),
                unit_count: new Set(details.units.map((unit) => unit.unit))
                  .size,
                ...updates,
                rows: updates.rows.map((unit) => ({
                  unit: unit.unit,
                  ...(generic && unit.description
                    ? { description: unit.description }
                    : {}),
                  status: unit.status,
                  entered_at: isoTime(unit.enteredAt),
                  entered_local: unit.entered,
                  timezone: 'America/New_York',
                })),
              }
            : null,
        },
      };
    },
  });

  return { getChesterCountyIncidents, getChesterCountyIncidentDetails };
}
export const { getChesterCountyIncidents, getChesterCountyIncidentDetails } =
  createIncidentTools();
const countyTools = createIncidentTools(true);
export const getCountyIncidents = countyTools.getChesterCountyIncidents;
export const getCountyIncidentDetails =
  countyTools.getChesterCountyIncidentDetails;
