SET search_path = gev, public;

-- ---------------------------------------------------------------------------
-- Observations: high-volume readings
-- ---------------------------------------------------------------------------

-- Vessel and aircraft positions, river levels, grid load, air quality. One row
-- per reading, partitioned by month so old months can be detached or dropped.
CREATE TABLE observation (
  object_id       uuid NOT NULL REFERENCES object (id),
  observed_at     timestamptz NOT NULL,
  metric          text NOT NULL,                    -- 'position', 'level_m'
  value_num       double precision,
  value_json      jsonb,
  geom            geography(Point, 4326),
  source_id       text NOT NULL REFERENCES source (id),
  run_id          bigint,
  PRIMARY KEY (object_id, metric, observed_at, source_id)
) PARTITION BY RANGE (observed_at);

CREATE INDEX observation_time ON observation USING brin (observed_at);
CREATE INDEX observation_geom ON observation USING gist (geom);

-- Partitions are created by a scheduled job; the first two exist from day one.
CREATE TABLE observation_default PARTITION OF observation DEFAULT;

-- ---------------------------------------------------------------------------
-- Links
-- ---------------------------------------------------------------------------

CREATE TABLE link (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type_key        text NOT NULL REFERENCES link_type (key),
  from_object     uuid NOT NULL REFERENCES object (id),
  to_object       uuid NOT NULL REFERENCES object (id),
  valid_during    tstzrange NOT NULL DEFAULT tstzrange(now(), NULL),
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  superseded_at   timestamptz,
  source_id       text NOT NULL REFERENCES source (id),
  run_id          bigint REFERENCES ingest_run (id),
  asserted_by     text NOT NULL DEFAULT 'pipeline'
                  CHECK (asserted_by IN ('pipeline', 'rule', 'analyst')),
  confidence      numeric(3,2) NOT NULL DEFAULT 0.50
                  CHECK (confidence BETWEEN 0 AND 1),
  props           jsonb NOT NULL DEFAULT '{}',
  CHECK (from_object <> to_object)
);
CREATE INDEX link_from ON link (from_object, type_key) WHERE superseded_at IS NULL;
CREATE INDEX link_to ON link (to_object, type_key) WHERE superseded_at IS NULL;
