import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveWeatherEffectProfile, weatherAltitudeFactors } from './weatherEffectsMath.js';

test('missing weather fails clear instead of inventing effects', () => {
  const profile = deriveWeatherEffectProfile(null);
  assert.equal(profile.available, false);
  assert.equal(profile.cloud, 0);
  assert.equal(profile.rain, 0);
  assert.equal(profile.storm, 0);
});

test('a missing weather code is unavailable, not clear', () => {
  for (const weatherCode of [null, undefined, '']) {
    const profile = deriveWeatherEffectProfile({ weatherCode, cloudCoverPct: 90 });
    assert.equal(profile.available, false, `weatherCode ${weatherCode}`);
    assert.equal(profile.cloud, 0);
  }
  assert.equal(deriveWeatherEffectProfile({ weatherCode: 0 }).available, true);
});

test('clear weather follows observed cloud cover without precipitation', () => {
  const profile = deriveWeatherEffectProfile({
    weatherCode: 1,
    cloudCoverPct: 24,
    precipitationMm: 0,
    visibilityM: 24000,
    windKph: 12,
    windDirectionDeg: 270,
  });
  assert.equal(profile.available, true);
  assert.ok(profile.cloud > 0 && profile.cloud < 0.3);
  assert.equal(profile.rain, 0);
  assert.equal(profile.snow, 0);
  assert.equal(profile.fog, 0);
  assert.equal(profile.windDirectionDeg, 270);
});

test('thunderstorm activates bounded rain, cloud, droplets, and lightning', () => {
  const profile = deriveWeatherEffectProfile({
    weatherCode: 95,
    cloudCoverPct: 86,
    precipitationMm: 4.2,
    visibilityM: 4500,
    windKph: 58,
    windDirectionDeg: -20,
  });
  assert.ok(profile.cloud >= 0.92);
  assert.ok(profile.rain >= 0.68);
  assert.ok(profile.droplets > 0.5);
  assert.ok(profile.storm >= 0.55);
  assert.equal(profile.snow, 0);
  assert.equal(profile.windDirectionDeg, 340);
});

test('snow codes never render rain droplets', () => {
  const profile = deriveWeatherEffectProfile({
    weatherCode: 75,
    cloudCoverPct: 100,
    precipitationMm: 2.5,
    visibilityM: 3000,
  });
  assert.ok(profile.snow > 0.3);
  assert.equal(profile.rain, 0);
  assert.equal(profile.droplets, 0);
});

test('weather effects attenuate above the ground-weather layer', () => {
  assert.deepEqual(weatherAltitudeFactors(0), { precipitation: 1, cloud: 1, haze: 1 });
  assert.equal(weatherAltitudeFactors(14000).precipitation, 0);
  assert.equal(weatherAltitudeFactors(24000).cloud, 0);
  assert.equal(weatherAltitudeFactors(20000).haze, 0);
});

test('normalized missing weather codes leave the actual cockpit cloud target clear', async () => {
  const { normalizeRegionalWeather } = await import('./data/regionalModel.js');
  const { CockpitCloudEffectsController } =
    await import('./cockpitCloudEffects.js');
  for (const code of [null, '']) {
    const weather = normalizeRegionalWeather({
      current: {
        time: '2026-10-13T12:00',
        temperature_2m: 20,
        weather_code: code,
        cloud_cover: 80,
        wind_speed_10m: 12,
      },
    });
    assert.equal(weather.weatherCode, null);
    const profile = deriveWeatherEffectProfile(weather);
    assert.equal(profile.available, false);
    const controller = { canvas: { dataset: {} }, reducedMotion: false };
    CockpitCloudEffectsController.prototype.applyWeather.call(
      controller,
      weather,
      0,
    );
    assert.equal(
      controller.targetStrength,
      0,
      'a missing condition code cannot enable the cloud pass',
    );
    assert.equal(controller.canvas.dataset.cloudStrength, '0.000');
  }
  const clear = deriveWeatherEffectProfile({
    weatherCode: 0,
    cloudCoverPct: 80,
  });
  assert.equal(
    clear.available,
    true,
    'real clear-sky code zero remains available',
  );
  assert.ok(clear.cloud > 0);
});
