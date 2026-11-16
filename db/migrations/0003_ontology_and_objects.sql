SET search_path = gev, public;

-- ---------------------------------------------------------------------------
-- Ontology: the vocabulary, as data
-- ---------------------------------------------------------------------------

CREATE TABLE object_type (
  key             text PRIMARY KEY,                 -- 'place', 'event', ...
  label           text NOT NULL,
  description     text,
  geometry        geometry_kind NOT NULL DEFAULT 'any',
  -- JSON Schema for `props`. The loader validates writes against it.
  props_schema    jsonb NOT NULL DEFAULT '{"type":"object"}',
  default_sensitivity sensitivity NOT NULL DEFAULT 'public',
  -- Display hints for the globe: icon glyph, accent colour. Presentation only.
  presentation    jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE link_type (
  key             text PRIMARY KEY,                 -- 'located_in', 'affects'
  label           text NOT NULL,
  inverse_label   text,                             -- 'contains' for located_in
  from_type       text REFERENCES object_type (key),  -- NULL = any type
  to_type         text REFERENCES object_type (key),
  is_symmetric    boolean NOT NULL DEFAULT false,
  description     text
);

-- ---------------------------------------------------------------------------
-- Objects: identity, then versioned state
-- ---------------------------------------------------------------------------

-- Identity only. Nothing here changes after insert except retirement.
CREATE TABLE object (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type_key        text NOT NULL REFERENCES object_type (key),
  sensitivity     sensitivity NOT NULL DEFAULT 'public',
  created_at      timestamptz NOT NULL DEFAULT now(),
  retired_at      timestamptz,                      -- soft delete, never DELETE
  merged_into     uuid REFERENCES object (id),      -- set by an accepted merge
  -- When set, the retention job removes the object's states, observations and
  -- links after this time. Required for `person` objects (see ONTOLOGY.md).
  retain_until    timestamptz,
  CHECK (merged_into IS NULL OR merged_into <> id)
);
CREATE INDEX object_type_idx ON object (type_key) WHERE retired_at IS NULL;

-- What a source calls the object. One object can carry many external ids; the
-- pair (source, key) is unique, which is what stops duplicate ingestion.
CREATE TABLE external_id (
  source_id       text NOT NULL REFERENCES source (id),
  external_key    text NOT NULL,
  object_id       uuid NOT NULL REFERENCES object (id),
  first_seen      timestamptz NOT NULL DEFAULT now(),
  last_seen       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, external_key)
);
CREATE INDEX external_id_object ON external_id (object_id);

-- Versioned state. Two time axes:
--   valid_during  when the thing was true in the world ("this flood warning
--                 was in force 06:00 to 18:00");
--   recorded_at / superseded_at  when WE knew it, so "what did the system
--                 believe at 09:00?" stays answerable after a correction.
CREATE TABLE object_state (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  object_id       uuid NOT NULL REFERENCES object (id),
  name            text,
  props           jsonb NOT NULL DEFAULT '{}',
  geom            geography(Geometry, 4326),
  valid_during    tstzrange NOT NULL DEFAULT tstzrange(now(), NULL),
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  superseded_at   timestamptz,                      -- NULL = current belief
  source_id       text NOT NULL REFERENCES source (id),
  run_id          bigint REFERENCES ingest_run (id),
  payload_id      bigint REFERENCES raw_payload (id),
  confidence      numeric(3,2) NOT NULL DEFAULT 0.50
                  CHECK (confidence BETWEEN 0 AND 1),
  CHECK (superseded_at IS NULL OR superseded_at >= recorded_at),
  -- One source cannot assert two overlapping, still-current states.
  EXCLUDE USING gist (
    object_id WITH =, source_id WITH =, valid_during WITH &&
  ) WHERE (superseded_at IS NULL)
);
CREATE INDEX object_state_object ON object_state (object_id, recorded_at DESC);
CREATE INDEX object_state_geom ON object_state USING gist (geom)
  WHERE superseded_at IS NULL;
CREATE INDEX object_state_valid ON object_state USING gist (valid_during)
  WHERE superseded_at IS NULL;
CREATE INDEX object_state_props ON object_state USING gin (props jsonb_path_ops)
  WHERE superseded_at IS NULL;
CREATE INDEX object_state_name ON object_state USING gin (name gin_trgm_ops)
  WHERE superseded_at IS NULL;

-- The current picture, as the globe and the API read it: the most recent
-- unsuperseded state per object, by its most trusted source.
CREATE VIEW object_current AS
SELECT DISTINCT ON (s.object_id)
       o.id, o.type_key, o.sensitivity,
       s.name, s.props, s.geom, s.valid_during,
       s.source_id, s.confidence, s.recorded_at
FROM object o
JOIN object_state s ON s.object_id = o.id AND s.superseded_at IS NULL
WHERE o.retired_at IS NULL AND o.merged_into IS NULL
ORDER BY s.object_id, s.confidence DESC, s.recorded_at DESC;

-- ---------------------------------------------------------------------------
-- Replay: the picture at a chosen time
-- ---------------------------------------------------------------------------

-- "What was true at T, as we knew it at K?" Both arguments default to now, so
-- objects_as_of() is the current picture. Passing only `valid_at` replays
-- the world as the system NOW believes it was; passing both also rewinds the
-- system's own knowledge, which is what reviewing a past decision needs.
CREATE FUNCTION objects_as_of(
  valid_at timestamptz DEFAULT now(),
  known_at timestamptz DEFAULT now()
) RETURNS TABLE (
  id uuid, type_key text, sensitivity sensitivity, name text, props jsonb,
  geom geography(Geometry, 4326), source_id text, confidence numeric
) LANGUAGE sql STABLE AS $$
  SELECT DISTINCT ON (s.object_id)
         o.id, o.type_key, o.sensitivity, s.name, s.props, s.geom,
         s.source_id, s.confidence
  FROM object o
  JOIN object_state s ON s.object_id = o.id
  WHERE s.recorded_at <= known_at
    AND (s.superseded_at IS NULL OR s.superseded_at > known_at)
    AND s.valid_during @> valid_at
    AND (o.retired_at IS NULL OR o.retired_at > known_at)
    AND o.merged_into IS NULL
  ORDER BY s.object_id, s.confidence DESC, s.recorded_at DESC
$$;
