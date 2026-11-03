import fs from 'node:fs/promises';

async function fetchAllDives() {
  console.log('Fetching NOAA Okeanos ROV Dive Points...');
  const url =
    'https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/EX_ROV_Dive_Pts/FeatureServer/0/query?' +
    new URLSearchParams({
      where: '1=1',
      outFields: [
        'OBJECTID',
        'cruise_id',
        'dive_id',
        'cruise_dive_id',
        'vessel',
        'platform',
        'Year',
        'Cruise',
        'Cruise_Dates',
        'latitude',
        'longitude',
        'Summary',
        'OE_Link',
        'ROV_Summary_Products',
        'Archive',
        'MaxDepth',
        'DiveDuration',
      ].join(','),
      outSR: '4326',
      f: 'json',
      resultRecordCount: '2000',
    }).toString();

  const res = await fetch(url);
  const data = await res.json();
  const features = data.features || [];

  const dives = features.map((f, idx) => {
    const a = f.attributes || {};
    const geom = f.geometry || {};
    const lon = typeof geom.x === 'number' ? geom.x : a.longitude;
    const lat = typeof geom.y === 'number' ? geom.y : a.latitude;
    return {
      id: a.cruise_dive_id || `dive-${a.OBJECTID || idx + 1}`,
      cruiseId: a.cruise_id || null,
      diveId: a.dive_id || null,
      cruiseDiveId: a.cruise_dive_id || null,
      cruiseTitle: a.Cruise || null,
      vessel: a.vessel || 'NOAA Ship Okeanos Explorer',
      platform: a.platform || 'ROV Deep Discoverer',
      year: a.Year ? Number(a.Year) : null,
      cruiseDates: a.Cruise_Dates || null,
      lon,
      lat,
      maxDepthM: a.MaxDepth ? Number(a.MaxDepth) : null,
      diveDuration: a.DiveDuration || null,
      summary: a.Summary || null,
      expeditionUrl: a.OE_Link || null,
      archiveUrl: a.Archive || null,
      mediaUrl: a.ROV_Summary_Products || null,
      source: 'NOAA Ocean Exploration',
    };
  });

  await fs.writeFile('src/layers/abyss/dives.json', JSON.stringify(dives, null, 2), 'utf8');
  console.log(`Saved ${dives.length} dives to src/layers/abyss/dives.json`);
}

async function fetchAllTracks() {
  console.log('Fetching NOAA Okeanos ROV Dive Tracks...');
  const url =
    'https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/EX_rov_nav_gdb/FeatureServer/0/query?' +
    new URLSearchParams({
      where: '1=1',
      outFields: [
        'OBJECTID',
        'CruiseDiveID',
        'CruiseID',
        'DiveID',
        'Vessel',
        'Platform',
        'Year',
        'Cruise',
        'Cruise_Dates',
        'Summary',
        'MaxVehicleDepth',
        'OE_Link',
        'Shape__Length',
      ].join(','),
      outSR: '4326',
      f: 'json',
      resultRecordCount: '1000',
    }).toString();

  const res = await fetch(url);
  const data = await res.json();
  const features = data.features || [];

  const tracks = features.map((f, idx) => {
    const a = f.attributes || {};
    const geom = f.geometry || {};
    const paths = geom.paths || [];
    return {
      id: `track-${a.CruiseDiveID || a.OBJECTID || idx + 1}`,
      cruiseDiveId: a.CruiseDiveID || null,
      cruiseId: a.CruiseID || null,
      diveId: a.DiveID || null,
      cruiseTitle: a.Cruise || null,
      vessel: a.Vessel || 'NOAA Ship Okeanos Explorer',
      platform: a.Platform || 'ROV Deep Discoverer',
      year: a.Year ? Number(a.Year) : null,
      cruiseDates: a.Cruise_Dates || null,
      summary: a.Summary || null,
      maxDepthM: a.MaxVehicleDepth ? Number(a.MaxVehicleDepth) : null,
      expeditionUrl: a.OE_Link || null,
      lengthM: a.Shape__Length ? Math.round(a.Shape__Length) : null,
      paths, // Array of [lon, lat] coordinates
      source: 'NOAA Ocean Exploration',
    };
  });

  await fs.writeFile('src/layers/abyss/tracks.json', JSON.stringify(tracks, null, 2), 'utf8');
  console.log(`Saved ${tracks.length} dive tracks to src/layers/abyss/tracks.json`);
}

async function main() {
  await fetchAllDives();
  await fetchAllTracks();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
