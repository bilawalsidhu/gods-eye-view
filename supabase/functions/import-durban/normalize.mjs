export function normalizeFacilities(payload) {
 if(!Array.isArray(payload?.elements)||payload.remark)throw Error('Incomplete provider response');
 const seen=new Set(); const categories={hospital:'Health',clinic:'Health',school:'Education',library:'Public services',police:'Public services',fire_station:'Public services'};
 return payload.elements.slice(0,200).flatMap(e=>{
  const latitude=e.lat??e.center?.lat,longitude=e.lon??e.center?.lon,category=categories[e.tags?.amenity],external_id=`${e.type}/${e.id}`;
  if(!['node','way','relation'].includes(e.type)||!Number.isSafeInteger(e.id)||!e.tags?.name||!category||!Number.isFinite(latitude)||!Number.isFinite(longitude)||latitude< -30.05||latitude> -29.60||longitude<30.80||longitude>31.20||seen.has(external_id))return [];
  seen.add(external_id);
  return [{external_id,name:e.tags.name.slice(0,200),category,latitude,longitude,source_url:`https://www.openstreetmap.org/${external_id}`}];
 });
}
export async function fetchFacilities(fetchImpl=fetch, sleep=ms=>new Promise(r=>setTimeout(r,ms))) {
 const query='[out:json][timeout:20];nwr[amenity~"^(hospital|clinic|library|police|fire_station|school)$"][name](-30.05,30.80,-29.60,31.20);out center 200;';
 for(let attempt=0;attempt<3;attempt++) {
  try {
   const r=await fetchImpl('https://overpass-api.de/api/interpreter',{method:'POST',body:new URLSearchParams({data:query}),signal:AbortSignal.timeout(25000)});
   if(!r.ok)throw Error(`Provider HTTP ${r.status}`);
   const text=await r.text();if(text.length>2000000)throw Error('Provider response too large');
   return normalizeFacilities(JSON.parse(text));
  } catch(e) {if(attempt===2)throw e;await sleep(1000*2**attempt);}
 }
}
