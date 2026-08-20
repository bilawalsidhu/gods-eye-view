/**
 * Domain aliases over the generated OpenAPI types.
 *
 * `api.d.ts` is regenerated from the committed `openapi.json` and is never edited by
 * hand. These aliases exist so the rest of the app does not repeat
 * `components['schemas'][...]` in every import, and so a contract change surfaces here
 * as a type error rather than as a runtime surprise.
 */

import type { components } from './api';

export type Aircraft = components['schemas']['Aircraft'];
export type AircraftClass = components['schemas']['AircraftClass'];
export type AircraftSnapshot = components['schemas']['AircraftSnapshot'];
export type AttributionEntry = components['schemas']['AttributionEntry'];
export type Capabilities = components['schemas']['Capabilities'];
export type EmergencyState = components['schemas']['EmergencyState'];
export type FeedHealth = components['schemas']['FeedHealth'];
export type Health = components['schemas']['Health'];
export type LayerCapability = components['schemas']['LayerCapability'];
export type LayerName = components['schemas']['LayerName'];
export type LayerSummary = components['schemas']['LayerSummary'];
export type Point = components['schemas']['Point'];
export type ProviderCoverage = components['schemas']['ProviderCoverage'];
export type Satellite = components['schemas']['Satellite'];
export type SatelliteElements = components['schemas']['SatelliteElements'];
export type Vessel = components['schemas']['Vessel'];
export type VesselSnapshot = components['schemas']['VesselSnapshot'];
