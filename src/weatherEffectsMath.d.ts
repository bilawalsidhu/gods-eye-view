/** A weather observation, as the weather service reports it. */
export interface WeatherObservation {
  /** WMO weather code. */
  weatherCode?: number | string | null;
  cloudCoverPct?: number;
  precipitationMm?: number;
  windKph?: number;
  windDirectionDeg?: number;
  visibilityM?: number;
}

/** Bounded visual strengths, 0..1, for an observation. */
export interface WeatherEffectProfile {
  /** False where there is no observation: everything clear. */
  available: boolean;
  cloud: number;
  rain: number;
  snow: number;
  fog: number;
  haze: number;
  droplets: number;
  storm: number;
  wind: number;
  windDirectionDeg: number;
}

/**
 * The visual strengths of `weather`: the WMO code picks the kind, the
 * numbers how strong. Missing weather is clear.
 */
export function deriveWeatherEffectProfile(
  weather: WeatherObservation | null | undefined,
): WeatherEffectProfile;

/** How much of each ground weather shows from a camera `altitudeM` up, 0..1. */
export function weatherAltitudeFactors(altitudeM: number): {
  precipitation: number;
  cloud: number;
  haze: number;
};
