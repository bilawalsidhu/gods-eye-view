/**
 * The Data Library catalog: every manifest in `src/library/entries/`.
 *
 * Adding an entry is one JSON file plus one import line here, and a share
 * token in `ledger.json` when the entry can be switched on (datasets and
 * tiles). `npm run library:check` fails when a file, import or token is
 * missing. Manifests are validated when this module loads, so an invalid
 * entry fails the unit suite rather than reaching a page.
 */
import { validateLibraryCatalog } from './manifest.js';
import ledgerRows from './ledger.json' with { type: 'json' };
import akStatewideImagery from './entries/ak-statewide-imagery.json' with { type: 'json' };
import arStatewideImagery from './entries/ar-statewide-imagery.json' with { type: 'json' };
import azStatewideImagery from './entries/az-statewide-imagery.json' with { type: 'json' };
import amsterdamTrafficCameras from './entries/amsterdam-traffic-cameras.json' with { type: 'json' };
import bayernDop40 from './entries/bayern-dop40.json' with { type: 'json' };
import bismarckMandanNd from './entries/bismarck-mandan-nd.json' with { type: 'json' };
import bkgTopplusOpen from './entries/bkg-topplus-open.json' with { type: 'json' };
import cctvFloridaFl511 from './entries/cctv-florida-fl511.json' with { type: 'json' };
import cctvLithuania from './entries/cctv-lithuania.json' with { type: 'json' };
import cctvNycDot from './entries/cctv-nyc-dot.json' with { type: 'json' };
import ctStatewideImagery from './entries/ct-statewide-imagery.json' with { type: 'json' };
import dakotaCountyMn from './entries/dakota-county-mn.json' with { type: 'json' };
import dcStatewideImagery from './entries/dc-statewide-imagery.json' with { type: 'json' };
import deStatewideImagery from './entries/de-statewide-imagery.json' with { type: 'json' };
import eeMaaAmetOrtofoto from './entries/ee-maa-amet-ortofoto.json' with { type: 'json' };
import eiaPowerPlants from './entries/eia-power-plants.json' with { type: 'json' };
import epaSuperfundSites from './entries/epa-superfund-sites.json' with { type: 'json' };
import epaToxicReleaseFacilities from './entries/epa-toxic-release-facilities.json' with { type: 'json' };
import epcEnglandWales from './entries/epc-england-wales.json' with { type: 'json' };
import femaUsaStructures from './entries/fema-usa-structures.json' with { type: 'json' };
import gbifOccurrenceDensity from './entries/gbif-occurrence-density.json' with { type: 'json' };
import gdacsDisasterAlerts from './entries/gdacs-disaster-alerts.json' with { type: 'json' };
import grandForksNd from './entries/grand-forks-nd.json' with { type: 'json' };
import gsiJapanMap from './entries/gsi-japan-map.json' with { type: 'json' };
import gsiJapanPhoto from './entries/gsi-japan-photo.json' with { type: 'json' };
import gvpHoloceneVolcanoes from './entries/gvp-holocene-volcanoes.json' with { type: 'json' };
import iaStatewideImagery from './entries/ia-statewide-imagery.json' with { type: 'json' };
import idStatewideImagery from './entries/id-statewide-imagery.json' with { type: 'json' };
import ignOrthophotosFrance from './entries/ign-orthophotos-france.json' with { type: 'json' };
import ilStatewideImagery from './entries/il-statewide-imagery.json' with { type: 'json' };
import imfPortwatchChokepoints from './entries/imf-portwatch-chokepoints.json' with { type: 'json' };
import imfPortwatchDisruptions from './entries/imf-portwatch-disruptions.json' with { type: 'json' };
import inStatewideImagery from './entries/in-statewide-imagery.json' with { type: 'json' };
import jrcSurfaceWater from './entries/jrc-surface-water.json' with { type: 'json' };
import kartverketAdminUnits from './entries/kartverket-admin-units.json' with { type: 'json' };
import kartverketCadastre from './entries/kartverket-cadastre.json' with { type: 'json' };
import kartverketDepth from './entries/kartverket-depth.json' with { type: 'json' };
import kartverketHillshade from './entries/kartverket-hillshade.json' with { type: 'json' };
import kartverketNauticalCharts from './entries/kartverket-nautical-charts.json' with { type: 'json' };
import kartverketTerrainRelief from './entries/kartverket-terrain-relief.json' with { type: 'json' };
import kartverketTopoGrey from './entries/kartverket-topo-grey.json' with { type: 'json' };
import kartverketTopo from './entries/kartverket-topo.json' with { type: 'json' };
import kartverketToporaster from './entries/kartverket-toporaster.json' with { type: 'json' };
import ksStatewideImagery from './entries/ks-statewide-imagery.json' with { type: 'json' };
import kyStatewideImagery from './entries/ky-statewide-imagery.json' with { type: 'json' };
import lakeCountyIn from './entries/lake-county-in.json' with { type: 'json' };
import lawrenceKs from './entries/lawrence-ks.json' with { type: 'json' };
import leeCountyFl from './entries/lee-county-fl.json' with { type: 'json' };
import loudounCountyVa from './entries/loudoun-county-va.json' with { type: 'json' };
import louisvilleLojicKy from './entries/louisville-lojic-ky.json' with { type: 'json' };
import maStatewideImagery from './entries/ma-statewide-imagery.json' with { type: 'json' };
import macrostratGeology from './entries/macrostrat-geology.json' with { type: 'json' };
import mapterhornTerrain from './entries/mapterhorn-terrain.json' with { type: 'json' };
import marisMs from './entries/maris-ms.json' with { type: 'json' };
import mdStatewideImagery from './entries/md-statewide-imagery.json' with { type: 'json' };
import meStatewideImagery from './entries/me-statewide-imagery.json' with { type: 'json' };
import miStatewideImagery from './entries/mi-statewide-imagery.json' with { type: 'json' };
import mountainVillageCo from './entries/mountain-village-co.json' with { type: 'json' };
import msStatewideImagery from './entries/ms-statewide-imagery.json' with { type: 'json' };
import mtStatewideImagery from './entries/mt-statewide-imagery.json' with { type: 'json' };
import naip from './entries/naip.json' with { type: 'json' };
import nasaBlackMarble from './entries/nasa-black-marble.json' with { type: 'json' };
import nasaEonetEvents from './entries/nasa-eonet-events.json' with { type: 'json' };
import ncStatewideImagery from './entries/nc-statewide-imagery.json' with { type: 'json' };
import nctcogTx from './entries/nctcog-tx.json' with { type: 'json' };
import ndStatewideImagery from './entries/nd-statewide-imagery.json' with { type: 'json' };
import newOrleansRpcLa from './entries/new-orleans-rpc-la.json' with { type: 'json' };
import nhStatewideImagery from './entries/nh-statewide-imagery.json' with { type: 'json' };
import njStatewideImagery from './entries/nj-statewide-imagery.json' with { type: 'json' };
import noaaTideStations from './entries/noaa-tide-stations.json' with { type: 'json' };
import nrwDop from './entries/nrw-dop.json' with { type: 'json' };
import nswImagery from './entries/nsw-imagery.json' with { type: 'json' };
import ntadNationalBridges from './entries/ntad-national-bridges.json' with { type: 'json' };
import nwaBentonWashingtonAr from './entries/nwa-benton-washington-ar.json' with { type: 'json' };
import nwsActiveAlerts from './entries/nws-active-alerts.json' with { type: 'json' };
import nyStatewideImagery from './entries/ny-statewide-imagery.json' with { type: 'json' };
import oaklandCountyMi from './entries/oakland-county-mi.json' with { type: 'json' };
import ohStatewideImagery from './entries/oh-statewide-imagery.json' with { type: 'json' };
import orStatewideImagery from './entries/or-statewide-imagery.json' with { type: 'json' };
import paStatewideImagery from './entries/pa-statewide-imagery.json' with { type: 'json' };
import plOrtofotomapa from './entries/pl-ortofotomapa.json' with { type: 'json' };
import pnoaMa from './entries/pnoa-ma.json' with { type: 'json' };
import portlandMetroOr from './entries/portland-metro-or.json' with { type: 'json' };
import ptDgtOrtos from './entries/pt-dgt-ortos.json' with { type: 'json' };
import riStatewideImagery from './entries/ri-statewide-imagery.json' with { type: 'json' };
import swisstopoSwissimage from './entries/swisstopo-swissimage.json' with { type: 'json' };
import txStatewideImagery from './entries/tx-statewide-imagery.json' with { type: 'json' };
import unionCountyOh from './entries/union-county-oh.json' with { type: 'json' };
import usgsHydrography from './entries/usgs-hydrography.json' with { type: 'json' };
import usgsTopo from './entries/usgs-topo.json' with { type: 'json' };
import vaStatewideImagery from './entries/va-statewide-imagery.json' with { type: 'json' };
import vtStatewideImagery from './entries/vt-statewide-imagery.json' with { type: 'json' };
import wallonieOrtho from './entries/wallonie-ortho.json' with { type: 'json' };
import wiStatewideImagery from './entries/wi-statewide-imagery.json' with { type: 'json' };
import wriGlobalPowerPlants from './entries/wri-global-power-plants.json' with { type: 'json' };
import wvStatewideImagery from './entries/wv-statewide-imagery.json' with { type: 'json' };

/** Raw manifests in file-name order; the validated form is below. */
export const LIBRARY_MANIFESTS = Object.freeze([
  akStatewideImagery,
  amsterdamTrafficCameras,
  arStatewideImagery,
  azStatewideImagery,
  bayernDop40,
  bismarckMandanNd,
  bkgTopplusOpen,
  cctvFloridaFl511,
  cctvLithuania,
  cctvNycDot,
  ctStatewideImagery,
  dakotaCountyMn,
  dcStatewideImagery,
  deStatewideImagery,
  eeMaaAmetOrtofoto,
  eiaPowerPlants,
  epaSuperfundSites,
  epaToxicReleaseFacilities,
  epcEnglandWales,
  femaUsaStructures,
  gbifOccurrenceDensity,
  gdacsDisasterAlerts,
  grandForksNd,
  gsiJapanMap,
  gsiJapanPhoto,
  gvpHoloceneVolcanoes,
  iaStatewideImagery,
  idStatewideImagery,
  ignOrthophotosFrance,
  ilStatewideImagery,
  imfPortwatchChokepoints,
  imfPortwatchDisruptions,
  inStatewideImagery,
  jrcSurfaceWater,
  kartverketAdminUnits,
  kartverketCadastre,
  kartverketDepth,
  kartverketHillshade,
  kartverketNauticalCharts,
  kartverketTerrainRelief,
  kartverketTopoGrey,
  kartverketTopo,
  kartverketToporaster,
  ksStatewideImagery,
  kyStatewideImagery,
  lakeCountyIn,
  lawrenceKs,
  leeCountyFl,
  loudounCountyVa,
  louisvilleLojicKy,
  maStatewideImagery,
  macrostratGeology,
  mapterhornTerrain,
  marisMs,
  mdStatewideImagery,
  meStatewideImagery,
  miStatewideImagery,
  mountainVillageCo,
  msStatewideImagery,
  mtStatewideImagery,
  naip,
  nasaBlackMarble,
  nasaEonetEvents,
  ncStatewideImagery,
  nctcogTx,
  ndStatewideImagery,
  newOrleansRpcLa,
  nhStatewideImagery,
  njStatewideImagery,
  noaaTideStations,
  nrwDop,
  nswImagery,
  ntadNationalBridges,
  nwaBentonWashingtonAr,
  nwsActiveAlerts,
  nyStatewideImagery,
  oaklandCountyMi,
  ohStatewideImagery,
  orStatewideImagery,
  paStatewideImagery,
  plOrtofotomapa,
  pnoaMa,
  portlandMetroOr,
  ptDgtOrtos,
  riStatewideImagery,
  swisstopoSwissimage,
  txStatewideImagery,
  unionCountyOh,
  usgsHydrography,
  usgsTopo,
  vaStatewideImagery,
  vtStatewideImagery,
  wallonieOrtho,
  wiStatewideImagery,
  wriGlobalPowerPlants,
  wvStatewideImagery,
]);

const validated = validateLibraryCatalog(LIBRARY_MANIFESTS);
if (!validated.ok)
  throw new TypeError(
    `Invalid Data Library manifests:\n${validated.errors.join('\n')}`,
  );

/** Validated, frozen entries with defaults filled. */
export const LIBRARY_ENTRIES = Object.freeze(validated.entries);

const BY_ID = new Map(LIBRARY_ENTRIES.map((entry) => [entry.id, entry]));

/** One entry by id, or undefined. */
export function libraryEntry(id) {
  return BY_ID.get(id);
}

/** The share-link ledger rows, `[entryId, token]`, append-only. */
export const LIBRARY_LEDGER = Object.freeze(
  ledgerRows.map((row) => Object.freeze([...row])),
);
