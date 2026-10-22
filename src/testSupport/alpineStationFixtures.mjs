/**
 * Fixtures for the Alpine station adapters, CUT FROM LIVE RESPONSES on
 * 2026-10-09 rather than invented.
 *
 * That distinction has already cost real time on this data: an invented
 * SwissMetNet fixture hid that the live STAC item publishes no `station_name`
 * and no elevation ordinate, and every test stayed green while every station
 * rendered as its bare code. Field names, casing, units, separators, the `-`
 * absent marker and the ISO-8859-1 accents below are all as the operators
 * publish them.
 *
 * The one thing arranged rather than captured is WHICH timestamp slot each
 * GeoSphere station reports in. The live response happened to have every
 * station at the newest slot that afternoon, so two real features were re-laid
 * at slots 2 and 0 of a three-slot response to exercise the union-of-timestamps
 * trap deliberately. Their readings, names, units and geometry are untouched.
 */

/** SLF IMIS `/stations`: a flat-field snow box, a wind mast, and a third station. */
export const SLF_STATIONS = [
  {
    code: 'DAV2',
    label: 'Bärentälli',
    lon: 9.8194108372,
    lat: 46.6988884749,
    elevation: 2558.0,
    country_code: 'CH',
    canton_code: 'GR',
    type: 'SNOW_FLAT',
  },
  {
    code: 'VSC1',
    label: 'Piz San Jon Dadaint',
    lon: 10.3391321077,
    lat: 46.7532597113,
    elevation: 3092.0,
    country_code: 'CH',
    canton_code: 'GR',
    type: 'WIND',
  },
  {
    code: 'MUT2',
    label: 'Mutten',
    lon: 9.0174835389,
    lat: 46.8587579889,
    elevation: 2481.0,
    country_code: 'CH',
    canton_code: 'GL',
    type: 'SNOW_FLAT',
  },
];

/**
 * SLF IMIS `/measurements`: the rolling window, newest last.
 *
 * DAV2 appears twice so the "newest row per station" reduction is exercised,
 * and MUT2 is absent from it entirely so a silent station is exercised too.
 */
export const SLF_MEASUREMENTS = [
  {
    station_code: 'DAV2',
    measure_date: '2026-10-08T22:30:00Z',
    HS: 4.95,
    TA_30MIN_MEAN: -0.672,
    RH_30MIN_MEAN: 95.9,
    TSS_30MIN_MEAN: -0.821,
    TS0_30MIN_MEAN: 4.428,
    TS25_30MIN_MEAN: -0.928,
    TS50_30MIN_MEAN: -0.964,
    TS100_30MIN_MEAN: -0.848,
    RSWR_30MIN_MEAN: 0.0,
    VW_30MIN_MEAN: null,
    VW_30MIN_MAX: null,
    DW_30MIN_MEAN: null,
    DW_30MIN_SD: null,
  },
  {
    station_code: 'DAV2',
    measure_date: '2026-10-08T23:00:00Z',
    HS: 10.7,
    TA_30MIN_MEAN: -0.704,
    RH_30MIN_MEAN: 95.9,
    TSS_30MIN_MEAN: -1.181,
    TS0_30MIN_MEAN: 4.382,
    TS25_30MIN_MEAN: -1.124,
    TS50_30MIN_MEAN: -1.138,
    TS100_30MIN_MEAN: -1.014,
    RSWR_30MIN_MEAN: 0.0,
    VW_30MIN_MEAN: null,
    VW_30MIN_MAX: null,
    DW_30MIN_MEAN: null,
    DW_30MIN_SD: null,
  },
  {
    station_code: 'VSC1',
    measure_date: '2026-10-08T23:00:00Z',
    HS: null,
    TA_30MIN_MEAN: -3.391,
    RH_30MIN_MEAN: 100.0,
    TSS_30MIN_MEAN: null,
    TS0_30MIN_MEAN: null,
    TS25_30MIN_MEAN: null,
    TS50_30MIN_MEAN: null,
    TS100_30MIN_MEAN: null,
    RSWR_30MIN_MEAN: null,
    VW_30MIN_MEAN: 2.419,
    VW_30MIN_MAX: 3.521,
    DW_30MIN_MEAN: 33.06,
    DW_30MIN_SD: 10.32,
  },
];

/**
 * `ogd-smn_meta_stations.csv`, header plus three rows.
 *
 * Semicolon separated. `Oberägeri` is here because the file is ISO-8859-1: the
 * proxy decodes the bytes explicitly, and reading it as UTF-8 mangles this row.
 */
export const SMN_METADATA_CSV = `station_abbr;station_name;station_canton;station_wigos_id;station_type_de;station_type_fr;station_type_it;station_type_en;station_dataowner;station_data_since;station_height_masl;station_height_barometer_masl;station_coordinates_lv95_east;station_coordinates_lv95_north;station_coordinates_wgs84_lat;station_coordinates_wgs84_lon;station_exposition_de;station_exposition_fr;station_exposition_it;station_exposition_en;station_url_de;station_url_fr;station_url_it;station_url_en
ZER;Zermatt;VS;0-20000-0-06748;Automatische Wetterstationen - Messwerte;Stations météorologiques automatiques - Valeurs mesurées;Stazioni meteorologiche automatiche - Valori misurati;Automatic weather stations - Measurement values;MeteoSchweiz, SLF;01.04.1892;1638.0;1640.0;2624298.0;1097574.0;46.029272;7.752433;Westhang;Versant ouest;Versante occidentale;western oriented slope;https://www.meteoschweiz.admin.ch/service-und-publikationen/applikationen/messwerte-und-messnetze.html#param=messnetz-automatisch&station=ZER;https://www.meteosuisse.admin.ch/services-et-publications/applications/valeurs-mesurees-et-reseaux-de-mesure.html#param=messnetz-automatisch&station=ZER;https://www.meteosvizzera.admin.ch/servizi-e-pubblicazioni/applicazioni/valori-attuali-e-reti-di-misura.html#param=messnetz-automatisch&station=ZER;https://www.meteoswiss.admin.ch/services-and-publications/applications/measurement-values-and-measuring-networks.html#param=messnetz-automatisch&station=ZER
GOR;Gornergrat;VS;0-20000-0-06749;Automatische Wetterstationen - Messwerte;Stations météorologiques automatiques - Valeurs mesurées;Stazioni meteorologiche automatiche - Valori misurati;Automatic weather stations - Measurement values;MeteoSchweiz;28.07.1993;3129.0;3131.0;2626915.0;1092513.0;45.983644;7.785944;Gipfellage;Sommet;Vetta;crest;https://www.meteoschweiz.admin.ch/service-und-publikationen/applikationen/messwerte-und-messnetze.html#param=messnetz-automatisch&station=GOR;https://www.meteosuisse.admin.ch/services-et-publications/applications/valeurs-mesurees-et-reseaux-de-mesure.html#param=messnetz-automatisch&station=GOR;https://www.meteosvizzera.admin.ch/servizi-e-pubblicazioni/applicazioni/valori-attuali-e-reti-di-misura.html#param=messnetz-automatisch&station=GOR;https://www.meteoswiss.admin.ch/services-and-publications/applications/measurement-values-and-measuring-networks.html#param=messnetz-automatisch&station=GOR
AEG;Oberägeri;ZG;0-20000-0-06676;Automatische Wetterstationen - Messwerte;Stations météorologiques automatiques - Valeurs mesurées;Stazioni meteorologiche automatiche - Valori misurati;Automatic weather stations - Measurement values;MeteoSchweiz;01.02.1993;724.0;;2688729.0;1220956.0;47.133636;8.608206;Ebene;Plaine;Pianura;plain;https://www.meteoschweiz.admin.ch/service-und-publikationen/applikationen/messwerte-und-messnetze.html#param=messnetz-automatisch&station=AEG;https://www.meteosuisse.admin.ch/services-et-publications/applications/valeurs-mesurees-et-reseaux-de-mesure.html#param=messnetz-automatisch&station=AEG;https://www.meteosvizzera.admin.ch/servizi-e-pubblicazioni/applicazioni/valori-attuali-e-reti-di-misura.html#param=messnetz-automatisch&station=AEG;https://www.meteoswiss.admin.ch/services-and-publications/applications/measurement-values-and-measuring-networks.html#param=messnetz-automatisch&station=AEG
`;

/**
 * `VQHA80.csv`, header plus the same three stations.
 *
 * `Date` is `YYYYMMDDHHMM` in UTC, the wind columns are km/h, and `-` marks a
 * sensor the station does not carry.
 */
export const SMN_OBSERVATIONS_CSV = `Station/Location;Date;tre200s0;rre150z0;sre000z0;gre000z0;ure200s0;tde200s0;dkl010z0;fu3010z0;fu3010z1;prestas0;pp0qffs0;pp0qnhs0;ppz850s0;ppz700s0;dv1towz0;fu3towz0;fu3towz1;ta1tows0;uretows0;tdetows0
ZER;202610082310;5.00;0.00;0.00;3.00;90.90;3.60;229.00;0.40;1.80;836.90;-;1020.00;1512.70;-;-;-;-;-;-;-
GOR;202610082310;-3.10;-;0.00;0.00;100.00;-3.10;69.00;3.60;7.90;695.20;-;1021.10;-;3076.90;-;-;-;-;-;-
AEG;202610082310;-;-;-;-;-;-;68.00;7.20;21.20;-;-;-;-;-;-;-;-;-;-;-
`;

/**
 * GeoSphere `/metadata`: two active stations and one decommissioned one.
 *
 * The inactive station proves it is neither requested nor drawn.
 */
export const TAWES_METADATA = {
  title: 'TAWES',
  frequency: '10min',
  type: 'station',
  mode: 'current',
  parameters: [
    {
      name: 'DD',
      long_name: 'Windrichtung',
      desc: 'Windrichtung der letzten 10 Minuten',
      unit: '°',
    },
    {
      name: 'FF',
      long_name: 'Windgeschwindigkeit',
      desc: 'Windgeschwindigkeit über 10 Minuten',
      unit: 'm/s',
    },
    {
      name: 'FFX',
      long_name: 'Windspitze',
      desc: 'Windspitze der letzten 10 Minuten',
      unit: 'm/s',
    },
    {
      name: 'RF',
      long_name: 'Relative Feuchte',
      desc: 'Relative Feuchte 10 Minuten',
      unit: '%',
    },
    {
      name: 'RR',
      long_name: 'Niederschlag der letzten 10 Minuten',
      desc: 'Niederschlag der letzten 10 Minuten',
      unit: 'mm',
    },
    {
      name: 'SCHNEE',
      long_name: 'Schneehöhe',
      desc: 'Gesamtschneehöhe 10 Minuten aus Schneepegelmessung',
      unit: 'cm',
    },
    {
      name: 'TL',
      long_name: 'Lufttemperatur',
      desc: 'Lufttemperatur 10 Minuten',
      unit: '°C',
    },
  ],
  stations: [
    {
      type: 'INDIVIDUAL',
      id: '11069',
      name: 'SOELL',
      state: 'Tirol',
      lat: 47.503055555555555,
      lon: 12.200277777777776,
      altitude: 697.0,
      valid_from: '2015-04-30T00:00:00',
      valid_to: '2027-10-08T23:16:41',
      has_sunshine: false,
      has_global_radiation: false,
      is_active: true,
    },
    {
      type: 'INDIVIDUAL',
      id: '11001',
      name: 'WOLFSEGG',
      state: 'Oberösterreich',
      lat: 48.105555555555554,
      lon: 13.670833333333333,
      altitude: 635.0,
      valid_from: '1972-01-01T00:00:00',
      valid_to: '2027-10-08T23:16:41',
      has_sunshine: false,
      has_global_radiation: false,
      is_active: true,
    },
    {
      type: 'INDIVIDUAL',
      id: '11384',
      name: 'HIRSCHENKOGEL',
      state: 'Niederösterreich',
      lat: 47.623333333333335,
      lon: 15.833333333333334,
      altitude: 1318.0,
      valid_from: '1994-06-13T00:00:00',
      valid_to: '2025-05-21T00:00:00',
      has_sunshine: false,
      has_global_radiation: false,
      is_active: false,
    },
  ],
};

/**
 * GeoSphere observations across three timestamps.
 *
 * Three cases, which is the whole point of this fixture: one station reporting
 * at the newest slot, one reporting at the OLDEST slot, and one reporting
 * nothing at all. The third station is absent from metadata, so it also proves
 * the position falls back to the observation feature's own geometry.
 */
export const TAWES_OBSERVATIONS = {
  media_type: 'application/json',
  type: 'FeatureCollection',
  version: 'v1',
  timestamps: [
    '2026-10-05T10:30+00:00',
    '2026-10-08T23:20+00:00',
    '2026-10-08T23:30+00:00',
  ],
  features: [
    {
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [12.200277777777776, 47.503055555555555],
      },
      properties: {
        parameters: {
          TL: {
            name: 'Lufttemperatur',
            unit: '°C',
            data: [null, null, 8.9],
          },
          RF: {
            name: 'Relative Feuchte',
            unit: '%',
            data: [null, null, 82.0],
          },
          FF: {
            name: 'Windgeschwindigkeit',
            unit: 'm/s',
            data: [null, null, 3.9],
          },
          FFX: {
            name: 'Windspitze',
            unit: 'm/s',
            data: [null, null, 5.6],
          },
          DD: {
            name: 'Windrichtung',
            unit: '°',
            data: [null, null, 185.0],
          },
          RR: {
            name: 'Niederschlag der letzten 10 Minuten',
            unit: 'mm',
            data: [null, null, 0.0],
          },
          SCHNEE: {
            name: 'Schneehöhe',
            unit: 'cm',
            data: [null, null, 0.0],
          },
        },
        station: '11069',
      },
    },
    {
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [13.670833333333333, 48.105555555555554],
      },
      properties: {
        parameters: {
          TL: {
            name: 'Lufttemperatur',
            unit: '°C',
            data: [9.5, null, null],
          },
          RF: {
            name: 'Relative Feuchte',
            unit: '%',
            data: [89.0, null, null],
          },
          FF: {
            name: 'Windgeschwindigkeit',
            unit: 'm/s',
            data: [6.0, null, null],
          },
          FFX: {
            name: 'Windspitze',
            unit: 'm/s',
            data: [9.1, null, null],
          },
          DD: {
            name: 'Windrichtung',
            unit: '°',
            data: [283.0, null, null],
          },
          RR: {
            name: 'Niederschlag der letzten 10 Minuten',
            unit: 'mm',
            data: [0.0, null, null],
          },
          SCHNEE: {
            name: 'Schneehöhe',
            unit: 'cm',
            data: [null, null, null],
          },
        },
        station: '11001',
      },
    },
    {
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [12.200277777777776, 47.503055555555555],
      },
      properties: {
        parameters: {
          TL: {
            name: 'Lufttemperatur',
            unit: '°C',
            data: [null, null, null],
          },
          RF: {
            name: 'Relative Feuchte',
            unit: '%',
            data: [null, null, null],
          },
          FF: {
            name: 'Windgeschwindigkeit',
            unit: 'm/s',
            data: [null, null, null],
          },
          FFX: {
            name: 'Windspitze',
            unit: 'm/s',
            data: [null, null, null],
          },
          DD: {
            name: 'Windrichtung',
            unit: '°',
            data: [null, null, null],
          },
          RR: {
            name: 'Niederschlag der letzten 10 Minuten',
            unit: 'mm',
            data: [null, null, null],
          },
          SCHNEE: {
            name: 'Schneehöhe',
            unit: 'cm',
            data: [null, null, null],
          },
        },
        station: '11999',
      },
    },
  ],
};
