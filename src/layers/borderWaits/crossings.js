// Where each CBP crossing is drawn, keyed by CBP `port_number`. CBP's
// wait-time feed carries no coordinates, so each crossing is placed from a
// public-domain source: its Wikidata item (CC0) where one exists, otherwise the
// U.S. DOT Bureau of Transportation Statistics port location (Border Crossing
// Entry Data, dataset keg4-3bc2). Several CBP entries share one physical
// crossing (separate cargo or pedestrian listings, duplicate port records);
// they share its point. records.test.mjs checks that every crossing CBP
// reported on 2026-10-13 is here and that each point sits on its border.

const at = (lat, lon) => Object.freeze({ lat, lon });

export const BORDER_CROSSING_LOCATIONS = Object.freeze({
  // Jackman — BTS port 0104 (Jackman)
  '010401': at(45.80566, -70.39672),
  // Houlton — Houlton–Woodstock border crossing, Wikidata Q14875597
  '010601': at(46.13526, -67.78125),
  // Calais · Ferry Point — Ferry Point International Bridge, Wikidata Q5445498
  '011501': at(45.1917, -67.2834),
  // Calais · Milltown — Milltown International Bridge, Wikidata Q6860090
  '011502': at(45.17, -67.2968),
  // Calais · International Avenue — International Avenue Border Crossing, Wikidata Q18153419
  '011503': at(45.16086, -67.29879),
  // Derby Line · Derby Line I-91 — BTS port 0209 (Derby Line)
  '020901': at(45.00574, -72.09928),
  // Norton — BTS port 0211 (Norton)
  '021101': at(45.01077, -71.79322),
  // Highgate Springs — BTS port 0212 (Highgate Springs)
  '021201': at(45.01541, -73.08504),
  // Ogdensburg — Ogdensburg–Prescott International Bridge, Wikidata Q2016132
  '070101': at(44.73532, -75.45949),
  // Massena — BTS port 0704 (Massena)
  '070401': at(44.99056, -74.73972),
  // Alexandria Bay · Thousand Islands Bridge — Thousand Islands Bridge, Wikidata Q2429399
  '070801': at(44.34742, -75.9835),
  // Champlain — BTS port 0712 (Champlain Rouses Point)
  '071201': at(45.00883, -73.45266),
  // Buffalo/Niagara Falls · Peace Bridge — Peace Bridge, Wikidata Q1188691
  '090101': at(42.9069, -78.9056),
  // Buffalo/Niagara Falls · Rainbow Bridge — Rainbow Bridge, Wikidata Q717285
  '090102': at(43.09023, -79.06774),
  // Buffalo/Niagara Falls · Whirlpool Bridge — Whirlpool Rapids Bridge, Wikidata Q2488190
  '090103': at(43.1092, -79.0583),
  // Buffalo/Niagara Falls · Lewiston Bridge — Lewiston–Queenston Bridge, Wikidata Q6537419
  '090104': at(43.15306, -79.04445),
  // Paso Del Norte — Paso del Norte International Bridge, Wikidata Q2691052
  202401: at(31.74765, -106.48698),
  // Gateway — Gateway International Bridge, Wikidata Q5527254
  230103: at(25.89833, -97.49722),
  // B&M Bridge · B&M Bridge — Brownsville & Matamoros International Bridge, Wikidata Q15205193
  230106: at(25.89194, -97.50444),
  // Del Rio — Del Río – Ciudad Acuña International Bridge, Wikidata Q5252993
  230201: at(29.32676, -100.92751),
  // Eagle Pass · Bridge I — Eagle Pass – Piedras Negras International Bridge, Wikidata Q2735945
  230301: at(28.70556, -100.51194),
  // Eagle Pass · Bridge II — Camino Real International Bridge, Wikidata Q5026778
  230302: at(28.69778, -100.51056),
  // Laredo · Bridge I — Gateway to the Americas International Bridge, Wikidata Q594360
  230401: at(27.4994, -99.5074),
  // Laredo · Bridge II — Juárez–Lincoln International Bridge, Wikidata Q3496608
  230402: at(27.50022, -99.50281),
  // Laredo · Colombia Solidarity — Colombia – Solidarity International Bridge, Wikidata Q5147918
  230403: at(27.69972, -99.74565),
  // Laredo · World Trade Bridge — World Trade International Bridge, Wikidata Q8036352
  230404: at(27.59729, -99.53712),
  // Hidalgo/Pharr · Hidalgo — McAllen–Hidalgo–Reynosa International Bridge, Wikidata Q6799912
  230501: at(26.095, -98.27139),
  // Hidalgo/Pharr · Pharr — Pharr–Reynosa International Bridge, Wikidata Q7180865
  230502: at(26.06683, -98.20518),
  // Hidalgo/Pharr · Anzalduas International Bridge — Anzalduas International Bridge, Wikidata Q4778427
  230503: at(26.1165, -98.3183),
  // Rio Grande City — Rio Grande City – Camargo International Bridge, Wikidata Q7335211
  230701: at(26.36571, -98.80252),
  // Progreso · Progreso International Bridge — Progreso – Nuevo Progreso International Bridge, Wikidata Q7248520
  230901: at(26.0619, -97.9492),
  // Progreso · Donna International Bridge — Donna – Río Bravo International Bridge, Wikidata Q5296509
  230902: at(26.0657, -98.0757),
  // Roma — Roma – Ciudad Miguel Alemán International Bridge, Wikidata Q7361517
  231001: at(26.4037, -99.0188),
  // ROMA TEXAS · ROMA TEXAS — Roma Texas Port of Entry, Wikidata Q7361497
  231002: at(26.4042, -99.0171),
  // YSLETA — Ysleta–Zaragoza International Bridge, Wikidata Q8059787
  240104: at(31.6705, -106.338),
  // El Paso · Bridge of the Americas (BOTA) — Bridge of the Americas, Wikidata Q4966455
  240201: at(31.7647, -106.451),
  // El Paso · Paso Del Norte (PDN) — Paso del Norte International Bridge, Wikidata Q2691052
  240202: at(31.74765, -106.48698),
  // El Paso · Ysleta — Ysleta–Zaragoza International Bridge, Wikidata Q8059787
  240203: at(31.6705, -106.338),
  // El Paso · Stanton DCL — Stanton Street Bridge, Wikidata Q2114896
  240204: at(31.74807, -106.48272),
  // Bridge of the Americas Port of Entry — Bridge of the Americas, Wikidata Q4966455
  240207: at(31.7647, -106.451),
  // BOTA CARGO FACILITY · BRIDGE OF AMERICAS CARGO FACILITY — Bridge of the Americas, Wikidata Q4966455
  240215: at(31.7647, -106.451),
  // El Paso — BTS port 2402 (El Paso)
  240221: at(31.76436, -106.45119),
  // Presidio · PRESIDIO PORT OF ENTRY — Presidio–Ojinaga International Bridge, Wikidata Q7241547
  240301: at(29.56173, -104.39511),
  // Marcelino Serna · Tornillo — Tornillo-Guadalupe Bridge, Wikidata Q85810216
  240401: at(31.43286, -106.14792),
  // Columbus — BTS port 2406 (Columbus)
  240601: at(31.78374, -107.62795),
  // Santa Teresa · Santa Teresa Port of Entry — Santa Teresa Port of Entry, Wikidata Q7419955
  240801: at(31.7859, -106.68),
  // Andrade — Andrade Port of Entry, Wikidata Q4754676
  250201: at(32.7187, -114.728),
  // Calexico · East — Calexico East Port of Entry, Wikidata Q5019552
  250301: at(32.6755, -115.389),
  // Calexico · West — Calexico West Port of Entry, Wikidata Q5019556
  250302: at(32.6651, -115.496),
  // San Ysidro — San Ysidro Port of Entry, Wikidata Q7415402
  250401: at(32.54319, -117.02969),
  // San Ysidro · PedWest — San Ysidro Port of Entry, Wikidata Q7415402
  250407: at(32.54319, -117.02969),
  // San Ysidro · Cross Border Express — Cross Border Xpress, Wikidata Q18157236
  250409: at(32.54821, -116.97456),
  // Tecate — Tecate Port of Entry, Wikidata Q5846396
  250501: at(32.57667, -116.62667),
  // Otay Mesa · Passenger — Otay Mesa Port of Entry, Wikidata Q7108476
  250601: at(32.5506, -116.938),
  // Otay Mesa · Commercial — Otay Mesa Port of Entry, Wikidata Q7108476
  250602: at(32.5506, -116.938),
  // Otay Mesa Port of Entry — Otay Mesa Port of Entry, Wikidata Q7108476
  250608: at(32.5506, -116.938),
  // Otay Mesa — Otay Mesa Port of Entry, Wikidata Q7108476
  250609: at(32.5506, -116.938),
  // Douglas (Raul Hector Castro) — BTS port 2601 (Douglas)
  260101: at(31.33404, -109.56034),
  // Lukeville — Lukeville Port of Entry, Wikidata Q14680557
  260201: at(31.8804, -112.817),
  // Naco — BTS port 2603 (Naco)
  260301: at(31.33408, -109.94841),
  // Naco — BTS port 2603 (Naco)
  260305: at(31.33408, -109.94841),
  // Nogales · Deconcini — BTS port 2604 (Nogales)
  260401: at(31.33284, -110.94252),
  // Nogales · Mariposa — Nogales-Mariposa Port of Entry, Wikidata Q14680619
  260402: at(31.3339, -110.966),
  // Nogales · Morley Gate — Nogales-Morley Gate Port of Entry, Wikidata Q7047433
  260403: at(31.33275, -110.9415),
  // San Luis · San Luis I — San Luis Port of Entry, Wikidata Q7414758
  260801: at(32.48534, -114.78212),
  // San Luis · San Luis II — San Luis II Port of Entry, Wikidata Q7414734
  260802: at(32.46487, -114.70053),
  // Blaine · Pacific Highway — Pacific Highway Border Crossing, Wikidata Q24190263
  300401: at(49.002, -122.735),
  // Blaine · Peace Arch — Peace Arch, Wikidata Q2000846
  300402: at(49.00214, -122.75653),
  // Blaine · Point Roberts — Point Roberts–Boundary Bay Border Crossing, Wikidata Q24190245
  300403: at(49.00223, -123.06806),
  // Sumas — Sumas-Huntingdon Border Crossing, Wikidata Q24190266
  300901: at(49.00241, -122.26551),
  // Lynden — Lynden-Aldergrove Border Crossing, Wikidata Q24190264
  302301: at(49.00227, -122.48498),
  // Sweetgrass — BTS port 3310 (Sweetgrass)
  331001: at(48.99839, -111.95961),
  // Pembina — Pembina–Emerson Border Crossing, Wikidata Q24191041
  340101: at(48.99912, -97.23921),
  // International Falls — Fort Frances – International Falls International Bridge, Wikidata Q3397558
  360401: at(48.60722, -93.40194),
  // Detroit · Ambassador Bridge — Ambassador Bridge, Wikidata Q12575
  380001: at(42.31195, -83.07412),
  // Detroit · Windsor Tunnel — Detroit–Windsor Tunnel, Wikidata Q1129573
  380002: at(42.3245, -83.04005),
  // Detroit · Gordie Howe International Bridge — Gordie Howe International Bridge, Wikidata Q5266001
  380102: at(42.2875, -83.09778),
  // Port Huron · Bluewater Bridge — Blue Water Bridge, Wikidata Q885931
  380201: at(42.99861, -82.42361),
  // Sault Ste. Marie · International Bridge - SSM — Sault Ste. Marie International Bridge, Wikidata Q1596245
  380301: at(46.50703, -84.36132),
  // Brownsville · B&M — Brownsville & Matamoros International Bridge, Wikidata Q15205193
  535501: at(25.89194, -97.50444),
  // Brownsville · Veterans International — Veterans International Bridge at Los Tomates, Wikidata Q14629021
  535502: at(25.8836, -97.4764),
  // Brownsville · Los Indios — Free Trade International Bridge, Wikidata Q2552026
  535503: at(26.02917, -97.73875),
  // Brownsville · Gateway — Brownsville Gateway Port of Entry, Wikidata Q15205196
  535504: at(25.89914, -97.49698),
  // Madawaska — Edmundston–Madawaska Bridge, Wikidata Q5339993
  L01901: at(47.36014, -68.32869),
  // Fort Hancock · Fort Hancock — Fort Hancock – El Porvenir International Bridge, Wikidata Q5471290
  l24501: at(31.27306, -105.85444),
});
