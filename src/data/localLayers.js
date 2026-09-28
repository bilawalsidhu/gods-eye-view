import { localGeoJsonServices } from './localGeojson.js';
import { createInfrastructureLayers } from './infrastructure.js';
import { createFirmsHeatmapLayer } from './firmsHeatmap.js';
import submarineCablesLayer from './telegeographySubmarineCables.js';

const [datacenters, dams] = createInfrastructureLayers(localGeoJsonServices);

// Live active fires. The id keeps the historical `local-` prefix for
// persistence + voice-tool-enum compat, but the data is NOT bundled anymore.
// Two providers back it: NASA FIRMS (VIIRS ×3 NRT + MODIS via the /api/firms
// proxy, needs FIRMS_MAP_KEY server-side) and, keyless, the NOAA GOES ABI
// fire/hot-spot product read straight from the public GOES S3 buckets
// (/api/goes-fires). FIRMS wins when its key is configured.
const fires = createFirmsHeatmapLayer({
  id: 'local-firms',
  name: 'FIRMS Active Fires',
  icon: '▲',
  source: 'NASA FIRMS / NOAA GOES ABI · LIVE',
});

export default [datacenters, dams, submarineCablesLayer, fires];
