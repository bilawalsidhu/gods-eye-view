SELECT names.primary AS name, bbox, sources,
       source_tags['military'] AS military,
       ST_X(ST_PointOnSurface(geometry)) AS lon,
       ST_Y(ST_PointOnSurface(geometry)) AS lat,
       ST_Area_Spheroid(geometry) AS area
FROM read_parquet(?)
WHERE subtype = 'military'
  AND nullif(trim(names.primary), '') IS NOT NULL
  AND (source_tags['landuse'] = 'military'
       OR source_tags['military'] IN
          ('airfield', 'naval_base', 'range', 'barracks', 'base', 'training_area'))
