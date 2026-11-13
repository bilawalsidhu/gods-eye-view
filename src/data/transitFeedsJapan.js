/**
 * @module transitFeedsJapan
 * @description Japanese bus networks for the Transit layer, as plain rows
 * that `transitFeeds.js` turns into registry entries.
 *
 * Every row is a keyless GTFS-Realtime VehiclePositions feed that the
 * Mobility Database records under CC0 1.0 or CC BY 4.0; `licenseUrl` is that
 * record and `terms.quote` the licence it links. The credit names the
 * operator in Japanese, as the operator publishes it.
 *
 * Most rows were added overnight in Japan, when the feeds answer with an
 * empty message: each note says whether vehicle positions have been seen.
 * `center` is the catalogue's bounding-box centre and `loadRadiusKm` an
 * estimate from the kind of network, to be tightened once vehicles are seen.
 *
 * Pure data: no imports.
 */

/** @type {ReadonlyArray<object>} */
export const JAPAN_TRANSIT_FEED_ROWS = [
  {
    id: 'chitetsu-bus-toyama',
    name: 'Toyama Chitetsu Bus',
    operator: 'Toyama Chitetsu Bus (富山地方鉄道)',
    region: 'Toyama Prefecture, Japan',
    center: {
      lat: 36.734,
      lon: 137.249,
    },
    loadRadiusKm: 30,
    url: 'https://gtfs-rt-files.buscatch.jp/toyama/chitetsu/VehiclePositions.pb',
    license: 'CC0 1.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-chitetsu-chitetsubus-vp',
    attribution: '富山地方鉄道 (Toyama Chitetsu Bus)',
    terms: {
      quote: 'https://creativecommons.org/publicdomain/zero/1.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'kitokito-bus-imizu',
    name: 'Imizu Kitokito Bus',
    operator: 'Imizu Kitokito Bus (射水市)',
    region: 'Toyama Prefecture, Japan',
    center: {
      lat: 36.724,
      lon: 137.1,
    },
    loadRadiusKm: 10,
    url: 'https://gtfs-rt-files.buscatch.jp/toyama/imizu-city/VehiclePositions.pb',
    license: 'CC0 1.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-imizucity-imizushi-vp',
    attribution: '射水市 (Imizu Kitokito Bus)',
    terms: {
      quote: 'https://creativecommons.org/publicdomain/zero/1.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'kaetsuno-bus-himi',
    name: 'Kaetsunō Bus Himi loop',
    operator: 'Kaetsunō Bus Himi loop (加越能バス)',
    region: 'Toyama Prefecture, Japan',
    center: {
      lat: 36.857,
      lon: 136.98,
    },
    loadRadiusKm: 10,
    url: 'https://gtfs-rt-files.buscatch.jp/toyama/kaetsuno_himi/VehiclePositions.pb',
    license: 'CC0 1.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-kaetsunou-kaetsunouhimi-vp',
    attribution: '加越能バス (Kaetsunō Bus Himi loop)',
    terms: {
      quote: 'https://creativecommons.org/publicdomain/zero/1.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'kaetsuno-bus',
    name: 'Kaetsunō Bus',
    operator: 'Kaetsunō Bus (加越能バス)',
    region: 'Toyama Prefecture, Japan',
    center: {
      lat: 36.74,
      lon: 136.903,
    },
    loadRadiusKm: 25,
    url: 'https://gtfs-rt-files.buscatch.jp/toyama/kaetsuno/VehiclePositions.pb',
    license: 'CC0 1.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-kaetsunou-kaetsunouippan-vp',
    attribution: '加越能バス (Kaetsunō Bus)',
    terms: {
      quote: 'https://creativecommons.org/publicdomain/zero/1.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'kaetsuno-world-heritage-bus',
    name: 'Kaetsunō World Heritage Bus',
    operator: 'Kaetsunō World Heritage Bus (加越能バス)',
    region: 'Toyama Prefecture, Japan',
    center: {
      lat: 36.502,
      lon: 136.944,
    },
    loadRadiusKm: 40,
    url: 'https://gtfs-rt-files.buscatch.jp/toyama/kaetsuno_sekaiisan/VehiclePositions.pb',
    license: 'CC0 1.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-kaetsunou-kaetsunousekaiisan-vp',
    attribution: '加越能バス (Kaetsunō World Heritage Bus)',
    terms: {
      quote: 'https://creativecommons.org/publicdomain/zero/1.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'kamiichi-town-bus',
    name: 'Kamiichi Town Bus',
    operator: 'Kamiichi Town Bus (上市町)',
    region: 'Toyama Prefecture, Japan',
    center: {
      lat: 36.698,
      lon: 137.36,
    },
    loadRadiusKm: 10,
    url: 'https://gtfs-rt-files.buscatch.jp/toyama/kamiichi-town/VehiclePositions.pb',
    license: 'CC0 1.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-kamiichitown-kamiichi-vp',
    attribution: '上市町 (Kamiichi Town Bus)',
    terms: {
      quote: 'https://creativecommons.org/publicdomain/zero/1.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'kurobe-city-bus',
    name: 'Kurobe City Bus',
    operator: 'Kurobe City Bus (黒部市)',
    region: 'Toyama Prefecture, Japan',
    center: {
      lat: 36.862,
      lon: 137.491,
    },
    loadRadiusKm: 10,
    url: 'https://gtfs-rt-files.buscatch.jp/toyama/kurobe_city_bus/VehiclePositions.pb',
    license: 'CC0 1.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-kurobecity-ishida-aimoto-vp',
    attribution: '黒部市 (Kurobe City Bus)',
    terms: {
      quote: 'https://creativecommons.org/publicdomain/zero/1.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'kurobe-shinkansen-ikuji-bus',
    name: 'Kurobe Shinkansen–Ikuji Bus',
    operator: 'Kurobe Shinkansen–Ikuji Bus (黒部市)',
    region: 'Toyama Prefecture, Japan',
    center: {
      lat: 36.89,
      lon: 137.452,
    },
    loadRadiusKm: 10,
    url: 'https://gtfs-rt-files.buscatch.jp/toyama/kurobe_shinkansen/VehiclePositions.pb',
    license: 'CC0 1.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-kurobecity-shinkansenikujisen-vp',
    attribution: '黒部市 (Kurobe Shinkansen–Ikuji Bus)',
    terms: {
      quote: 'https://creativecommons.org/publicdomain/zero/1.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'noru-my-car-namerikawa',
    name: 'Namerikawa Noru my car',
    operator: 'Namerikawa Noru my car (滑川市)',
    region: 'Toyama Prefecture, Japan',
    center: {
      lat: 36.76,
      lon: 137.377,
    },
    loadRadiusKm: 10,
    url: 'https://gtfs-rt-files.buscatch.jp/toyama/namerikawa-city/VehiclePositions.pb',
    license: 'CC0 1.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-namerikawacity-norumycar-vp',
    attribution: '滑川市 (Namerikawa Noru my car)',
    terms: {
      quote: 'https://creativecommons.org/publicdomain/zero/1.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'nanto-city-bus',
    name: 'Nanto City Bus',
    operator: 'Nanto City Bus (南砺市)',
    region: 'Toyama Prefecture, Japan',
    center: {
      lat: 36.482,
      lon: 136.969,
    },
    loadRadiusKm: 20,
    url: 'https://gtfs-rt-files.buscatch.jp/toyama/nanto-city/VehiclePositions.pb',
    license: 'CC0 1.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-nantocity-nanbus-vp',
    attribution: '南砺市 (Nanto City Bus)',
    terms: {
      quote: 'https://creativecommons.org/publicdomain/zero/1.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'noran-my-car-nyuzen',
    name: 'Nyūzen Noran my car',
    operator: 'Nyūzen Noran my car (入善町)',
    region: 'Toyama Prefecture, Japan',
    center: {
      lat: 36.899,
      lon: 137.528,
    },
    loadRadiusKm: 10,
    url: 'https://gtfs-rt-files.buscatch.jp/toyama/nyuzen_noran/VehiclePositions.pb',
    license: 'CC0 1.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-nyuzentown-noranmaicar-vp',
    attribution: '入善町 (Nyūzen Noran my car)',
    terms: {
      quote: 'https://creativecommons.org/publicdomain/zero/1.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'oyabe-city-bus',
    name: 'Oyabe City Bus',
    operator: 'Oyabe City Bus (小矢部市)',
    region: 'Toyama Prefecture, Japan',
    center: {
      lat: 36.665,
      lon: 136.866,
    },
    loadRadiusKm: 10,
    url: 'https://gtfs-rt-files.buscatch.jp/toyama/oyabe-city/VehiclePositions.pb',
    license: 'CC0 1.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-oyabecity-oyabecitybus-vp',
    attribution: '小矢部市 (Oyabe City Bus)',
    terms: {
      quote: 'https://creativecommons.org/publicdomain/zero/1.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'takaoka-city-bus',
    name: 'Takaoka City Bus',
    operator: 'Takaoka City Bus (高岡市)',
    region: 'Toyama Prefecture, Japan',
    center: {
      lat: 36.73,
      lon: 136.906,
    },
    loadRadiusKm: 10,
    url: 'https://gtfs-rt-files.buscatch.jp/toyama/takaoka-city/VehiclePositions.pb',
    license: 'CC0 1.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-takaokacity-koueibus-vp',
    attribution: '高岡市 (Takaoka City Bus)',
    terms: {
      quote: 'https://creativecommons.org/publicdomain/zero/1.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'tateyama-town-bus',
    name: 'Tateyama Town Bus',
    operator: 'Tateyama Town Bus (立山町)',
    region: 'Toyama Prefecture, Japan',
    center: {
      lat: 36.637,
      lon: 137.344,
    },
    loadRadiusKm: 10,
    url: 'https://gtfs-rt-files.buscatch.jp/toyama/tateyama-town/VehiclePositions.pb',
    license: 'CC0 1.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-tateyamatown-tateyama-vp',
    attribution: '立山町 (Tateyama Town Bus)',
    terms: {
      quote: 'https://creativecommons.org/publicdomain/zero/1.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'gruun-tokoname',
    name: 'Tokoname Gruun',
    operator: 'Tokoname Gruun (常滑市)',
    region: 'Aichi Prefecture, Japan',
    center: {
      lat: 34.872,
      lon: 136.871,
    },
    loadRadiusKm: 10,
    url: 'https://realtime.gtfs.info/gruun/vehicle.pb',
    license: 'CC0 1.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-tokonamecity-Gruun-vp',
    attribution: '常滑市 (Tokoname Gruun)',
    terms: {
      quote: 'https://creativecommons.org/publicdomain/zero/1.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'tonami-city-bus',
    name: 'Tonami City Bus',
    operator: 'Tonami City Bus (砺波市)',
    region: 'Toyama Prefecture, Japan',
    center: {
      lat: 36.621,
      lon: 136.986,
    },
    loadRadiusKm: 10,
    url: 'https://gtfs-rt-files.buscatch.jp/toyama/tonami-city/VehiclePositions.pb',
    license: 'CC0 1.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-tonamicity-tonamishieibasu-vp',
    attribution: '砺波市 (Tonami City Bus)',
    terms: {
      quote: 'https://creativecommons.org/publicdomain/zero/1.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'asahimachi-bus',
    name: 'Asahi Asahimachi Bus',
    operator: 'Asahi Asahimachi Bus (富山県朝日町)',
    region: 'Toyama Prefecture, Japan',
    center: {
      lat: 36.92,
      lon: 137.596,
    },
    loadRadiusKm: 10,
    url: 'https://gtfs-rt-files.buscatch.jp/toyama/asahimachi/VehiclePositions.pb',
    license: 'CC0 1.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-toyama-asahitown-asahimachibus-vp',
    attribution: '富山県朝日町 (Asahi Asahimachi Bus)',
    terms: {
      quote: 'https://creativecommons.org/publicdomain/zero/1.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'toyama-fuchu-community-bus',
    name: 'Toyama Fuchū Community Bus',
    operator: 'Toyama Fuchū Community Bus (富山市)',
    region: 'Toyama Prefecture, Japan',
    center: {
      lat: 36.65,
      lon: 137.134,
    },
    loadRadiusKm: 10,
    url: 'https://gtfs-rt-files.buscatch.jp/toyama/toyama-city-fuchu/VehiclePositions.pb',
    license: 'CC0 1.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-toyamacity-fuchucommunitybus-vp',
    attribution: '富山市 (Toyama Fuchū Community Bus)',
    terms: {
      quote: 'https://creativecommons.org/publicdomain/zero/1.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'toyama-horikawa-minami-bus',
    name: 'Toyama Horikawa-Minami Community Bus',
    operator: 'Toyama Horikawa-Minami Community Bus (富山市)',
    region: 'Toyama Prefecture, Japan',
    center: {
      lat: 36.666,
      lon: 137.225,
    },
    loadRadiusKm: 10,
    url: 'https://gtfs-rt-files.buscatch.jp/toyama/toyama-city-horikawaminami/VehiclePositions.pb',
    license: 'CC0 1.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-toyamacity-horikawaminamicommunitybus-vp',
    attribution: '富山市 (Toyama Horikawa-Minami Community Bus)',
    terms: {
      quote: 'https://creativecommons.org/publicdomain/zero/1.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'toyama-jojo-community-bus',
    name: 'Toyama Jōjō Community Bus',
    operator: 'Toyama Jōjō Community Bus (富山市)',
    region: 'Toyama Prefecture, Japan',
    center: {
      lat: 36.731,
      lon: 137.312,
    },
    loadRadiusKm: 10,
    url: 'https://gtfs-rt-files.buscatch.jp/toyama/toyama-city-jojo/VehiclePositions.pb',
    license: 'CC0 1.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-toyamacity-jojocommunitybus-vp',
    attribution: '富山市 (Toyama Jōjō Community Bus)',
    terms: {
      quote: 'https://creativecommons.org/publicdomain/zero/1.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'toyama-kureha-ikiiki-bus',
    name: 'Toyama Kureha Ikiiki Bus',
    operator: 'Toyama Kureha Ikiiki Bus (富山市)',
    region: 'Toyama Prefecture, Japan',
    center: {
      lat: 36.705,
      lon: 137.151,
    },
    loadRadiusKm: 10,
    url: 'https://gtfs-rt-files.buscatch.jp/toyama/toyama-city-kureha/VehiclePositions.pb',
    license: 'CC0 1.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-toyamacity-kurehaikiikibus-vp',
    attribution: '富山市 (Toyama Kureha Ikiiki Bus)',
    terms: {
      quote: 'https://creativecommons.org/publicdomain/zero/1.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'toyama-maidohaya-bus',
    name: 'Toyama Maidohaya Bus',
    operator: 'Toyama Maidohaya Bus (富山市)',
    region: 'Toyama Prefecture, Japan',
    center: {
      lat: 36.693,
      lon: 137.217,
    },
    loadRadiusKm: 10,
    url: 'https://gtfs-rt-files.buscatch.jp/toyama/toyama-city-maidohaya/VehiclePositions.pb',
    license: 'CC0 1.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-toyamacity-maidohayabus-vp',
    attribution: '富山市 (Toyama Maidohaya Bus)',
    terms: {
      quote: 'https://creativecommons.org/publicdomain/zero/1.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'toyama-mizuhashi-fureai-bus',
    name: 'Toyama Mizuhashi Fureai Community Bus',
    operator: 'Toyama Mizuhashi Fureai Community Bus (富山市)',
    region: 'Toyama Prefecture, Japan',
    center: {
      lat: 36.742,
      lon: 137.313,
    },
    loadRadiusKm: 10,
    url: 'https://gtfs-rt-files.buscatch.jp/toyama/toyama-city-mizuhashi/VehiclePositions.pb',
    license: 'CC0 1.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-toyamacity-mizuhashifureaicommunitybus-vp',
    attribution: '富山市 (Toyama Mizuhashi Fureai Community Bus)',
    terms: {
      quote: 'https://creativecommons.org/publicdomain/zero/1.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'toyama-oyama-community-bus',
    name: 'Toyama Ōyama Community Bus',
    operator: 'Toyama Ōyama Community Bus (富山市)',
    region: 'Toyama Prefecture, Japan',
    center: {
      lat: 36.574,
      lon: 137.323,
    },
    loadRadiusKm: 10,
    url: 'https://gtfs-rt-files.buscatch.jp/toyama/toyama-city-oyama/VehiclePositions.pb',
    license: 'CC0 1.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-toyamacity-oyamacommunitybus-vp',
    attribution: '富山市 (Toyama Ōyama Community Bus)',
    terms: {
      quote: 'https://creativecommons.org/publicdomain/zero/1.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'toyama-yamada-community-bus',
    name: 'Toyama Yamada Community Bus',
    operator: 'Toyama Yamada Community Bus (富山市)',
    region: 'Toyama Prefecture, Japan',
    center: {
      lat: 36.607,
      lon: 137.094,
    },
    loadRadiusKm: 10,
    url: 'https://gtfs-rt-files.buscatch.jp/toyama/toyama-city-yamada/VehiclePositions.pb',
    license: 'CC0 1.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-toyamacity-yamadacommunitybus-vp',
    attribution: '富山市 (Toyama Yamada Community Bus)',
    terms: {
      quote: 'https://creativecommons.org/publicdomain/zero/1.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'toyama-yatsuo-community-bus',
    name: 'Toyama Yatsuo Community Bus',
    operator: 'Toyama Yatsuo Community Bus (富山市)',
    region: 'Toyama Prefecture, Japan',
    center: {
      lat: 36.528,
      lon: 137.123,
    },
    loadRadiusKm: 10,
    url: 'https://gtfs-rt-files.buscatch.jp/toyama/toyama-city-yatsuo/VehiclePositions.pb',
    license: 'CC0 1.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-toyamacity-yatsuocommunitybus-vp',
    attribution: '富山市 (Toyama Yatsuo Community Bus)',
    terms: {
      quote: 'https://creativecommons.org/publicdomain/zero/1.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'uozu-citizens-bus',
    name: 'Uozu Citizens’ Bus',
    operator: 'Uozu Citizens’ Bus (魚津市)',
    region: 'Toyama Prefecture, Japan',
    center: {
      lat: 36.808,
      lon: 137.441,
    },
    loadRadiusKm: 10,
    url: 'https://gtfs-rt-files.buscatch.jp/toyama/uozu_shimin/VehiclePositions.pb',
    license: 'CC0 1.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-uozucity-junkai-vp',
    attribution: '魚津市 (Uozu Citizens’ Bus)',
    terms: {
      quote: 'https://creativecommons.org/publicdomain/zero/1.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'uozu-omotenashi-bus',
    name: 'Uozu Omotenashi direct bus',
    operator: 'Uozu Omotenashi direct bus (魚津市)',
    region: 'Toyama Prefecture, Japan',
    center: {
      lat: 36.847,
      lon: 137.444,
    },
    loadRadiusKm: 10,
    url: 'https://gtfs-rt-files.buscatch.jp/toyama/uozu_omotenashi/VehiclePositions.pb',
    license: 'CC0 1.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-uozucity-omotenashi-vp',
    attribution: '魚津市 (Uozu Omotenashi direct bus)',
    terms: {
      quote: 'https://creativecommons.org/publicdomain/zero/1.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'aiai-bus-chita',
    name: 'Chita Aiai Bus',
    operator: 'Chita Aiai Bus (知多市)',
    region: 'Aichi Prefecture, Japan',
    center: {
      lat: 34.969,
      lon: 136.872,
    },
    loadRadiusKm: 10,
    url: 'https://realtime.gtfs.info/chita/vehicle.pb',
    license: 'CC BY 4.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-chitacity-chita-aiaibus-vp',
    attribution: '知多市 (Chita Aiai Bus)',
    terms: {
      quote: 'https://creativecommons.org/licenses/by/4.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'okage-bus-ise',
    name: 'Ise Okage Bus',
    operator: 'Ise Okage Bus (伊勢市)',
    region: 'Mie Prefecture, Japan',
    center: {
      lat: 34.514,
      lon: 136.724,
    },
    loadRadiusKm: 15,
    url: 'https://bus-vision.jp/realtime/iseshi_vpos_update_v2.bin',
    license: 'CC BY 4.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-isecity-communitybus-vp',
    attribution: '伊勢市 (Ise Okage Bus)',
    terms: {
      quote: 'https://creativecommons.org/licenses/by/4.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'keisei-bus-chiba-west-shiohama',
    name: 'Keisei Bus Chiba West (Shiohama)',
    operator: 'Keisei Bus Chiba West (Shiohama) (京成バス千葉ウエスト株式会社)',
    region: 'Chiba Prefecture, Japan',
    center: {
      lat: 35.682,
      lon: 139.92,
    },
    loadRadiusKm: 15,
    url: 'https://s3-ajt-mobusta-gtfs.s3.ap-northeast-1.amazonaws.com/realtime/35/vehicle_position.bin',
    license: 'CC BY 4.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-keisei-transitbus-keiseitransitbus-vp',
    attribution:
      '京成バス千葉ウエスト株式会社 (Keisei Bus Chiba West (Shiohama))',
    terms: {
      quote: 'https://creativecommons.org/licenses/by/4.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'kamoshika-go-komono',
    name: 'Komono Kamoshika-gō',
    operator: 'Komono Kamoshika-gō (菰野町)',
    region: 'Mie Prefecture, Japan',
    center: {
      lat: 35.044,
      lon: 136.51,
    },
    loadRadiusKm: 10,
    url: 'https://bus-vision.jp/realtime/komono_vpos_update_v2.bin',
    license: 'CC BY 4.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-komonotown-communitybus-vp',
    attribution: '菰野町 (Komono Kamoshika-gō)',
    terms: {
      quote: 'https://creativecommons.org/licenses/by/4.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'kumamoto-bus',
    name: 'Kumamoto Bus',
    operator: 'Kumamoto Bus (熊本バス)',
    region: 'Kumamoto Prefecture, Japan',
    center: {
      lat: 32.709,
      lon: 130.831,
    },
    loadRadiusKm: 30,
    url: 'https://km.bus-vision.jp/realtime/kumabus_vpos_update.bin',
    license: 'CC BY 4.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-kuma-bus-kuma-bus-vp',
    attribution: '熊本バス (Kumamoto Bus)',
    terms: {
      quote: 'https://creativecommons.org/licenses/by/4.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Vehicle positions were seen on 2026-11-13 around midnight Japan time. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'kumamoto-toshi-bus',
    name: 'Kumamoto Toshi Bus',
    operator: 'Kumamoto Toshi Bus (熊本都市バス)',
    region: 'Kumamoto Prefecture, Japan',
    center: {
      lat: 32.831,
      lon: 130.738,
    },
    loadRadiusKm: 20,
    url: 'https://km.bus-vision.jp/realtime/toshibus_vpos_update.bin',
    license: 'CC BY 4.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-kumamoto-toshibus-kumamoto-toshibus-vp',
    attribution: '熊本都市バス (Kumamoto Toshi Bus)',
    terms: {
      quote: 'https://creativecommons.org/licenses/by/4.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Vehicle positions were seen on 2026-11-13 around midnight Japan time. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'kumamoto-dentetsu-bus',
    name: 'Kumamoto Dentetsu Bus',
    operator: 'Kumamoto Dentetsu Bus (熊本電鉄)',
    region: 'Kumamoto Prefecture, Japan',
    center: {
      lat: 32.882,
      lon: 130.779,
    },
    loadRadiusKm: 25,
    url: 'https://km.bus-vision.jp/realtime/dentetsu_vpos_update.bin',
    license: 'CC BY 4.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-kumamotodentetsu-kumamotodentetsu-bus-vp',
    attribution: '熊本電鉄 (Kumamoto Dentetsu Bus)',
    terms: {
      quote: 'https://creativecommons.org/licenses/by/4.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Vehicle positions were seen on 2026-11-13 around midnight Japan time. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'mie-kotsu-chusei',
    name: 'Mie Kōtsū Chūsei office',
    operator: 'Mie Kōtsū Chūsei office (三重交通)',
    region: 'Mie Prefecture, Japan',
    center: {
      lat: 34.747,
      lon: 136.473,
    },
    loadRadiusKm: 35,
    url: 'https://bus-vision.jp/realtime/chusei_vpos_update_v2.bin',
    license: 'CC BY 4.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-mie-kotsu-sancochusei-vp',
    attribution: '三重交通 (Mie Kōtsū Chūsei office)',
    terms: {
      quote: 'https://creativecommons.org/licenses/by/4.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'mie-kotsu-iga',
    name: 'Mie Kōtsū Iga office',
    operator: 'Mie Kōtsū Iga office (三重交通)',
    region: 'Mie Prefecture, Japan',
    center: {
      lat: 34.828,
      lon: 136.443,
    },
    loadRadiusKm: 35,
    url: 'https://bus-vision.jp/realtime/iga_vpos_update_v2.bin',
    license: 'CC BY 4.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-mie-kotsu-sancoiga-vp',
    attribution: '三重交通 (Mie Kōtsū Iga office)',
    terms: {
      quote: 'https://creativecommons.org/licenses/by/4.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'mie-kotsu-nanki',
    name: 'Mie Kōtsū Nanki office',
    operator: 'Mie Kōtsū Nanki office (三重交通)',
    region: 'Mie Prefecture, Japan',
    center: {
      lat: 33.981,
      lon: 136.163,
    },
    loadRadiusKm: 50,
    url: 'https://bus-vision.jp/realtime/nanki_vpos_update_v2.bin',
    license: 'CC BY 4.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-mie-kotsu-sancoinanki-vp',
    attribution: '三重交通 (Mie Kōtsū Nanki office)',
    terms: {
      quote: 'https://creativecommons.org/licenses/by/4.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'mie-kotsu-ise',
    name: 'Mie Kōtsū Ise office',
    operator: 'Mie Kōtsū Ise office (三重交通)',
    region: 'Mie Prefecture, Japan',
    center: {
      lat: 34.394,
      lon: 136.646,
    },
    loadRadiusKm: 35,
    url: 'https://bus-vision.jp/realtime/ise_vpos_update_v2.bin',
    license: 'CC BY 4.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-mie-kotsu-sancoise-vp',
    attribution: '三重交通 (Mie Kōtsū Ise office)',
    terms: {
      quote: 'https://creativecommons.org/licenses/by/4.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'mie-kotsu-kuwana',
    name: 'Mie Kōtsū Kuwana office',
    operator: 'Mie Kōtsū Kuwana office (三重交通)',
    region: 'Mie Prefecture, Japan',
    center: {
      lat: 35.099,
      lon: 136.713,
    },
    loadRadiusKm: 35,
    url: 'https://bus-vision.jp/realtime/kuwana_vpos_update_v2.bin',
    license: 'CC BY 4.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-mie-kotsu-sancokuwana-vp',
    attribution: '三重交通 (Mie Kōtsū Kuwana office)',
    terms: {
      quote: 'https://creativecommons.org/licenses/by/4.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'mie-kotsu-matsusaka',
    name: 'Mie Kōtsū Matsusaka office',
    operator: 'Mie Kōtsū Matsusaka office (三重交通)',
    region: 'Mie Prefecture, Japan',
    center: {
      lat: 34.502,
      lon: 136.384,
    },
    loadRadiusKm: 35,
    url: 'https://bus-vision.jp/realtime/matsusaka_vpos_update_v2.bin',
    license: 'CC BY 4.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-mie-kotsu-sancomatsusaka-vp',
    attribution: '三重交通 (Mie Kōtsū Matsusaka office)',
    terms: {
      quote: 'https://creativecommons.org/licenses/by/4.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'mie-kotsu-shima',
    name: 'Mie Kōtsū Shima office',
    operator: 'Mie Kōtsū Shima office (三重交通)',
    region: 'Mie Prefecture, Japan',
    center: {
      lat: 34.378,
      lon: 136.766,
    },
    loadRadiusKm: 35,
    url: 'https://bus-vision.jp/realtime/shima_vpos_update_v2.bin',
    license: 'CC BY 4.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-mie-kotsu-sancoshima-vp',
    attribution: '三重交通 (Mie Kōtsū Shima office)',
    terms: {
      quote: 'https://creativecommons.org/licenses/by/4.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'mie-kotsu-yokkaichi',
    name: 'Mie Kōtsū Yokkaichi office',
    operator: 'Mie Kōtsū Yokkaichi office (三重交通)',
    region: 'Mie Prefecture, Japan',
    center: {
      lat: 35.021,
      lon: 136.666,
    },
    loadRadiusKm: 35,
    url: 'https://bus-vision.jp/realtime/yokkaichi_vpos_update_v2.bin',
    license: 'CC BY 4.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-mie-kotsu-sancoyokkaichi-vp',
    attribution: '三重交通 (Mie Kōtsū Yokkaichi office)',
    terms: {
      quote: 'https://creativecommons.org/licenses/by/4.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'nagai-bus-maebashi',
    name: 'Nagai Bus',
    operator: 'Nagai Bus (永井運輸株式会社)',
    region: 'Gunma Prefecture, Japan',
    center: {
      lat: 36.366,
      lon: 139.121,
    },
    loadRadiusKm: 30,
    url: 'https://nagai.nolbe.net/buslocation/VehiclePosition.pb',
    license: 'CC BY 4.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-nagai-unyu-Nagaibus-vp',
    attribution: '永井運輸株式会社 (Nagai Bus)',
    terms: {
      quote: 'https://creativecommons.org/licenses/by/4.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'nagano-city-bus',
    name: 'Nagano City Bus',
    operator: 'Nagano City Bus (長野市)',
    region: 'Nagano Prefecture, Japan',
    center: {
      lat: 36.62,
      lon: 138.095,
    },
    loadRadiusKm: 25,
    url: 'https://realtime.gtfs.info/api/vehicle/F23EA2FD-DAB8-4E7D-AC4F-67E482555472',
    license: 'CC BY 4.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-naganocity-shiei_noriaibus-vp',
    attribution: '長野市 (Nagano City Bus)',
    terms: {
      quote: 'https://creativecommons.org/licenses/by/4.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'asapi-go-owariasahi',
    name: 'Owariasahi Asapī-gō',
    operator: 'Owariasahi Asapī-gō (尾張旭市)',
    region: 'Aichi Prefecture, Japan',
    center: {
      lat: 35.212,
      lon: 137.035,
    },
    loadRadiusKm: 10,
    url: 'https://gtfs-rt-files.buscatch.jp/owariasahi-city/asapygo/VehiclePositions.pb',
    license: 'CC BY 4.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-owariasahicity-communitybus-vp',
    attribution: '尾張旭市 (Owariasahi Asapī-gō)',
    terms: {
      quote: 'https://creativecommons.org/licenses/by/4.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'sanko-bus-kumamoto',
    name: 'Sankō Bus',
    operator: 'Sankō Bus (産交バス)',
    region: 'Kumamoto Prefecture, Japan',
    center: {
      lat: 32.864,
      lon: 130.832,
    },
    loadRadiusKm: 70,
    url: 'https://km.bus-vision.jp/realtime/sankobus_vpos_update.bin',
    license: 'CC BY 4.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-sankobus-sankobus-vp',
    attribution: '産交バス (Sankō Bus)',
    terms: {
      quote: 'https://creativecommons.org/licenses/by/4.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Vehicle positions were seen on 2026-11-13 around midnight Japan time. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'takeya-kotsu',
    name: 'Takeya Kōtsū',
    operator: 'Takeya Kōtsū (株式会社タケヤ交通)',
    region: 'Miyagi Prefecture, Japan',
    center: {
      lat: 38.135,
      lon: 140.76,
    },
    loadRadiusKm: 40,
    url: 'https://realtime.gtfs.info/takeyakotsu/vehicle.pb',
    license: 'CC BY 4.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-takeyakoutu-takeyakotsu-vp',
    attribution: '株式会社タケヤ交通 (Takeya Kōtsū)',
    terms: {
      quote: 'https://creativecommons.org/licenses/by/4.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'tsuchimaru-bus-tsuchiura',
    name: 'Tsuchiura Tsuchimaru Bus',
    operator: 'Tsuchiura Tsuchimaru Bus (土浦市)',
    region: 'Ibaraki Prefecture, Japan',
    center: {
      lat: 36.053,
      lon: 140.167,
    },
    loadRadiusKm: 10,
    url: 'https://realtime.gtfs.info/tsuchiura/vehicle.pb',
    license: 'CC BY 4.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-tsuchiuracity-tsuchimarubus-vp',
    attribution: '土浦市 (Tsuchiura Tsuchimaru Bus)',
    terms: {
      quote: 'https://creativecommons.org/licenses/by/4.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'yanbaru-express-bus',
    name: 'Yanbaru Express Bus',
    operator: 'Yanbaru Express Bus (合同会社やんばる急行バス)',
    region: 'Okinawa Prefecture, Japan',
    center: {
      lat: 26.458,
      lon: 127.838,
    },
    loadRadiusKm: 60,
    url: 'https://gtfs.yanbaru-bus-navi.com/gtfs-rt/yanbaru/vehicle_position.pb',
    license: 'CC BY 4.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/jbda-yanbaru-expressbus-yanbaru-express-bus-vp',
    attribution: '合同会社やんばる急行バス (Yanbaru Express Bus)',
    terms: {
      quote: 'https://creativecommons.org/licenses/by/4.0/deed.ja',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'kenko-hokubu-kotsu',
    name: 'Kenkō Hokubu Kōtsū',
    operator: 'Kenkō Hokubu Kōtsū (株式会社県交北部交通)',
    region: 'Kōchi Prefecture, Japan',
    center: {
      lat: 33.636,
      lon: 133.369,
    },
    loadRadiusKm: 40,
    url: 'https://api-public.odpt.org/api/v4/gtfs/realtime/odpt_KenkoHokubuKotsu_Localbus_vehicle',
    license: 'CC BY 4.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/odpt-KenkoHokubuKotsu-Localbus-vp',
    attribution: '株式会社県交北部交通 (Kenkō Hokubu Kōtsū)',
    terms: {
      quote: 'https://creativecommons.org/licenses/by/4.0/',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'kochi-koryo-kotsu',
    name: 'Kōchi Kōryō Kōtsū',
    operator: 'Kōchi Kōryō Kōtsū (高知高陵交通株式会社)',
    region: 'Kōchi Prefecture, Japan',
    center: {
      lat: 33.371,
      lon: 133.132,
    },
    loadRadiusKm: 40,
    url: 'https://api-public.odpt.org/api/v4/gtfs/realtime/odpt_KochiKoryoKotsu_Localbus_vehicle',
    license: 'CC BY 4.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/odpt-KochiKoryoKotsu-Localbus-vp',
    attribution: '高知高陵交通株式会社 (Kōchi Kōryō Kōtsū)',
    terms: {
      quote: 'https://creativecommons.org/licenses/by/4.0/',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'kochi-seinan-kotsu',
    name: 'Kōchi Seinan Kōtsū',
    operator: 'Kōchi Seinan Kōtsū (高知西南交通株式会社)',
    region: 'Kōchi Prefecture, Japan',
    center: {
      lat: 32.951,
      lon: 132.867,
    },
    loadRadiusKm: 50,
    url: 'https://api-public.odpt.org/api/v4/gtfs/realtime/odpt_KochiSeinanTraffic_Localbus_vehicle',
    license: 'CC BY 4.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/odpt-KochiSeinanTraffic-Localbus-vp',
    attribution: '高知西南交通株式会社 (Kōchi Seinan Kōtsū)',
    terms: {
      quote: 'https://creativecommons.org/licenses/by/4.0/',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'susaki-city-bus',
    name: 'Susaki City Bus',
    operator: 'Susaki City Bus (須崎市)',
    region: 'Kōchi Prefecture, Japan',
    center: {
      lat: 33.385,
      lon: 133.304,
    },
    loadRadiusKm: 15,
    url: 'https://api-public.odpt.org/api/v4/gtfs/realtime/odpt_SusakiCity_Citybus_vehicle',
    license: 'CC BY 4.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/odpt-SusakiCity-Citybus-vp',
    attribution: '須崎市 (Susaki City Bus)',
    terms: {
      quote: 'https://creativecommons.org/licenses/by/4.0/',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Added while services were not running (2026-11-14, 01:40 Japan time): the feed answered with a well-formed, empty message, so its positions have not been seen yet. The centre is the catalogue’s bounding-box centre for the network.',
    },
  },
  {
    id: 'aomori-city-community-bus',
    name: 'Aomori City community bus',
    operator: 'Aomori City community bus (青森市)',
    region: 'Aomori Prefecture, Japan',
    center: {
      lat: 40.784,
      lon: 140.72,
    },
    loadRadiusKm: 25,
    url: 'https://toshisei.aomoricitybus.com/VehiclePosition.pb',
    license: 'CC BY 4.0',
    licenseUrl:
      'https://mobilitydatabase.org/feeds/gtfs_rt/odpt-UrbanDevelopment_AomoriCity-AllLines-vp',
    attribution: '青森市 (Aomori City community bus)',
    terms: {
      quote: 'https://creativecommons.org/licenses/by/4.0/',
      note: 'The Mobility Database record gives this licence for the feed; the quote is the licence it links. Vehicle positions were seen on 2026-11-13 around midnight Japan time. The centre is the catalogue’s bounding-box centre for the network. The catalogue’s ODPT address redirects to this host, so the feed is registered at its own address.',
    },
  },
];
