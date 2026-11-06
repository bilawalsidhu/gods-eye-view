// Test fixtures shaped like https://bwt.cbp.gov/api/bwtnew (sampled 2026-10-13).

const lane = (status, delay = '', open = '', time = '') => ({
  update_time: time,
  operational_status: status,
  delay_minutes: delay,
  lanes_open: open,
});
const NA = () => lane('N/A');

/** One CBP port record; `overrides` replaces top-level fields. */
export function cbpPort(overrides = {}) {
  return {
    port_number: '380001',
    border: 'Canadian Border',
    port_name: 'Detroit',
    crossing_name: 'Ambassador Bridge',
    hours: '24 hrs/day',
    date: '10/13/2026',
    time: '10:11:50',
    port_status: 'Open',
    commercial_vehicle_lanes: {
      maximum_lanes: '13',
      standard_lanes: lane('no delay', '5', '5', 'At 9:00 am EDT'),
      FAST_lanes: lane('no delay', '5', '2', 'At 9:00 am EDT'),
    },
    passenger_vehicle_lanes: {
      maximum_lanes: '18',
      standard_lanes: lane('no delay', '5', '2', 'At 9:00 am EDT'),
      NEXUS_SENTRI_lanes: lane('no delay', '5', '3', 'At 9:00 am EDT'),
      ready_lanes: lane('Lanes Closed'),
    },
    pedestrian_lanes: {
      maximum_lanes: 'N/A',
      standard_lanes: NA(),
      ready_lanes: NA(),
    },
    construction_notice:
      'A Ready Lane is available from 11am-2pm Monday through Friday.  More at: https://www.cbp.gov/travel',
    automation: '0',
    automation_enabled: '0',
    ...overrides,
  };
}

/** A pedestrian-only crossing (San Ysidro PedWest) with a long wait. */
export function cbpPedestrianPort() {
  return cbpPort({
    port_number: '250407',
    border: 'Mexican Border',
    port_name: 'San Ysidro',
    crossing_name: 'PedWest',
    hours: '6 am-10 pm',
    commercial_vehicle_lanes: {
      standard_lanes: NA(),
      FAST_lanes: NA(),
    },
    passenger_vehicle_lanes: {
      standard_lanes: NA(),
      NEXUS_SENTRI_lanes: NA(),
      ready_lanes: NA(),
    },
    pedestrian_lanes: {
      standard_lanes: lane('delay', '75', '4', 'At 8:00 am PDT'),
      ready_lanes: lane('Update Pending'),
    },
    construction_notice: '',
  });
}

export const FIXTURE_LOCATIONS = Object.freeze({
  380001: Object.freeze({ lat: 42.3119, lon: -83.0741 }),
  250407: Object.freeze({ lat: 32.5427, lon: -117.0302 }),
});
