SET search_path = gev, public;

-- ---------------------------------------------------------------------------
-- Identity resolution
-- ---------------------------------------------------------------------------

-- Every proposed or decided duplicate pair, with the reason, so a wrong merge
-- can be explained and undone.
CREATE TABLE merge_candidate (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  object_a        uuid NOT NULL REFERENCES object (id),
  object_b        uuid NOT NULL REFERENCES object (id),
  score           numeric(4,3) NOT NULL CHECK (score BETWEEN 0 AND 1),
  signals         jsonb NOT NULL,                   -- {name:0.9, dist_m:120, ...}
  verdict         merge_verdict NOT NULL DEFAULT 'undecided',
  decided_by      text CHECK (decided_by IN ('rule', 'analyst')),
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (object_a < object_b),                      -- one row per pair
  UNIQUE (object_a, object_b)
);

-- ---------------------------------------------------------------------------
-- Documents and notes
-- ---------------------------------------------------------------------------

CREATE TABLE document (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title           text NOT NULL,
  mime_type       text,
  storage_uri     text NOT NULL,
  sha256          bytea NOT NULL UNIQUE,
  source_id       text REFERENCES source (id),
  sensitivity     sensitivity NOT NULL DEFAULT 'personal',
  extracted_text  text,
  added_at        timestamptz NOT NULL DEFAULT now(),
  search          tsvector GENERATED ALWAYS AS
                  (to_tsvector('simple', coalesce(title, '') || ' ' ||
                                         coalesce(extracted_text, ''))) STORED
);
CREATE INDEX document_search ON document USING gin (search);

-- Which objects a document mentions, and where in it.
CREATE TABLE document_mention (
  document_id     uuid NOT NULL REFERENCES document (id) ON DELETE CASCADE,
  object_id       uuid NOT NULL REFERENCES object (id),
  excerpt         text,
  confidence      numeric(3,2) NOT NULL DEFAULT 0.50,
  PRIMARY KEY (document_id, object_id)
);

CREATE TABLE note (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id       uuid REFERENCES object (id),
  investigation_id uuid,                            -- FK added below
  body_md         text NOT NULL,
  sensitivity     sensitivity NOT NULL DEFAULT 'private',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Investigations (boards)
-- ---------------------------------------------------------------------------

CREATE TABLE investigation (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title           text NOT NULL,
  question        text,                             -- what you are trying to settle
  status          text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'closed', 'archived')),
  sensitivity     sensitivity NOT NULL DEFAULT 'private',
  created_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz
);
ALTER TABLE note
  ADD CONSTRAINT note_investigation_fk
  FOREIGN KEY (investigation_id) REFERENCES investigation (id) ON DELETE CASCADE;

CREATE TABLE investigation_item (
  investigation_id uuid NOT NULL REFERENCES investigation (id) ON DELETE CASCADE,
  object_id       uuid NOT NULL REFERENCES object (id),
  position        integer NOT NULL DEFAULT 0,
  role            text,                             -- 'subject', 'evidence'
  added_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (investigation_id, object_id)
);
