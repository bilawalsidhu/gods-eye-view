SET search_path = gev, public;

-- ---------------------------------------------------------------------------
-- Sources and ingestion
-- ---------------------------------------------------------------------------

-- One row per upstream feed. Licence and terms travel with the data.
CREATE TABLE source (
  id              text PRIMARY KEY,                 -- 'firms', 'vigicrues'
  name            text NOT NULL,
  homepage        text,
  licence         text NOT NULL,                    -- 'ODbL', 'Etalab 2.0', ...
  attribution     text,                             -- shown wherever data appears
  terms_note      text,                             -- limits that matter to us
  trust           numeric(3,2) NOT NULL DEFAULT 0.50
                  CHECK (trust BETWEEN 0 AND 1),    -- prior, tuned over time
  refresh_seconds integer CHECK (refresh_seconds > 0),
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- One row per connector execution. Lets you answer "what did we read, when,
-- and did it work" for any fact.
CREATE TABLE ingest_run (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id       text NOT NULL REFERENCES source (id),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  ok              boolean,
  http_status     integer,
  records_read    integer,
  records_written integer,
  error           text
);
CREATE INDEX ingest_run_source_time ON ingest_run (source_id, started_at DESC);

-- The payload exactly as received, so any state can be re-derived after a
-- parser fix. Bodies live on disk or object storage; the row keeps the hash.
CREATE TABLE raw_payload (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id          bigint NOT NULL REFERENCES ingest_run (id) ON DELETE CASCADE,
  fetched_at      timestamptz NOT NULL DEFAULT now(),
  content_type    text,
  sha256          bytea NOT NULL,
  bytes           integer NOT NULL,
  storage_uri     text NOT NULL,                    -- file:// or s3://
  UNIQUE (sha256, run_id)
);
