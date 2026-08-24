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
export type AircraftDetail = components['schemas']['AircraftDetail'];
export type AircraftOwnership = components['schemas']['AircraftOwnership'];
export type AircraftSnapshot = components['schemas']['AircraftSnapshot'];
export type AttributionEntry = components['schemas']['AttributionEntry'];
export type Capabilities = components['schemas']['Capabilities'];
export type City = components['schemas']['City'];
export type CitySnapshot = components['schemas']['CitySnapshot'];
export type Claim = components['schemas']['Claim'];
export type DateOfBirth = components['schemas']['DateOfBirth'];
export type EmergencyState = components['schemas']['EmergencyState'];
export type FeedHealth = components['schemas']['FeedHealth'];
export type Health = components['schemas']['Health'];
export type Join = components['schemas']['Join'];
export type LayerCapability = components['schemas']['LayerCapability'];
export type LayerName = components['schemas']['LayerName'];
export type LayerSummary = components['schemas']['LayerSummary'];
export type MediaLicence = components['schemas']['MediaLicence'];
export type Organisation = components['schemas']['Organisation'];
export type Person = components['schemas']['Person'];
export type Point = components['schemas']['Point'];
export type PostMedia = components['schemas']['PostMedia'];
export type ProviderCoverage = components['schemas']['ProviderCoverage'];
export type RefusedRecords = components['schemas']['RefusedRecords'];
export type RegistryConflict = components['schemas']['RegistryConflict'];
export type RegistryCoverage = components['schemas']['RegistryCoverage'];
export type Role = components['schemas']['Role'];
export type Satellite = components['schemas']['Satellite'];
export type SatelliteElements = components['schemas']['SatelliteElements'];
export type SearchGroup = components['schemas']['SearchGroup'];
export type SearchGroupName = components['schemas']['SearchGroupName'];
export type SearchHit = components['schemas']['SearchHit'];
export type SearchResponse = components['schemas']['SearchResponse'];
export type SocialPost = components['schemas']['SocialPost'];
export type SocialSnapshot = components['schemas']['SocialSnapshot'];
export type SourceKind = components['schemas']['SourceKind'];
export type SweepCoverage = components['schemas']['SweepCoverage'];
export type TransitSnapshot = components['schemas']['TransitSnapshot'];
export type TransitVehicle = components['schemas']['TransitVehicle'];
export type Vessel = components['schemas']['Vessel'];
export type VesselSnapshot = components['schemas']['VesselSnapshot'];
