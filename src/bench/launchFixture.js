// Deterministic Launch Library 2 records for phase-3 mission/replay acceptance.
import { SATELLITE_FIXTURE_EPOCH } from './satelliteFixture.js';
const LAUNCH_FIXTURE_EPOCH = SATELLITE_FIXTURE_EPOCH;
export function launchFixture() {
  const definitions = [
    [
      'qa-iss',
      'QA ISS supply mission',
      'ISS (ZARYA)',
      'NASA',
      -80.604333,
      28.608389,
      'Launch Complex 39A',
      'Low Earth Orbit',
    ],
    [
      'qa-meo',
      'QA navigation mission',
      'QA MEO payload',
      'Rocket Lab',
      177.864,
      -39.262,
      'Launch Complex 1',
      'Medium Earth Orbit',
    ],
    [
      'qa-gto',
      'QA transfer mission',
      'QA GTO payload',
      'SpaceX',
      -52.768,
      5.236,
      'QA Equatorial Pad',
      'Geostationary Transfer Orbit',
    ],
  ];
  return {
    results: definitions.map(
      ([id, name, payload, provider, lon, lat, pad, orbit], i) => ({
        id,
        name,
        net: new Date(LAUNCH_FIXTURE_EPOCH - (i + 1) * 86400000).toISOString(),
        // i18n-ignore: synthetic provider data
        status: { name: 'Launch Successful' },
        launch_service_provider: { name: provider },
        pad: {
          name: pad,
          latitude: lat,
          longitude: lon,
          location: { name: pad },
        },
        mission: {
          name: payload,
          description: 'Deterministic QA fixture',
          orbit: { name: orbit },
        },
        timeline: [
          { name: 'MECO', relative_time: '00:02:30' },
          { name: 'SECO', relative_time: '00:09:00' },
          { name: 'Payload deployment', relative_time: '00:10:00' },
        ],
        rocket: {
          payloads: [
            {
              id: `${id}-payload`,
              payload: {
                name: payload,
                type: { name: 'QA spacecraft' },
                mass: 500,
              },
            },
          ],
          launcher_stage:
            i === 0
              ? [
                  {
                    id: 'qa-booster',
                    type: 'First stage',
                    launcher: { serial_number: 'QA-01' },
                    landing: {
                      attempt: true,
                      success: true,
                      type: { name: 'Drone Ship' },
                      landing_location: {
                        name: 'QA Recovery Platform',
                        latitude: 28.32,
                        longitude: -75.12,
                      },
                    },
                  },
                ]
              : [],
        },
        trajectory:
          i === 2
            ? [
                {
                  latitude: lat,
                  longitude: lon,
                  altitude: 0,
                  stage: 'Stage 1',
                },
                {
                  latitude: lat + 0.2,
                  longitude: lon + 0.5,
                  altitude: 40000,
                  stage: 'Stage 1',
                },
                {
                  latitude: lat + 0.4,
                  longitude: lon + 1,
                  altitude: 80000,
                  stage: 'Stage 2',
                },
                {
                  latitude: lat + 0.8,
                  longitude: lon + 2,
                  altitude: 180000,
                  stage: 'Stage 2',
                },
              ]
            : [],
      }),
    ),
  };
}
