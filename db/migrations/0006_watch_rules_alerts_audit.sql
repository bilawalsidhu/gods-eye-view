SET search_path = gev, public;

-- ---------------------------------------------------------------------------
-- Watch zones, rules and alerts
-- ---------------------------------------------------------------------------

-- A watch zone is a place object plus a radius or an area; the object carries
-- the geometry, this row says how to watch it.
CREATE TABLE watch_zone (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id       uuid NOT NULL REFERENCES object (id),
  radius_m        integer CHECK (radius_m > 0),     -- NULL = use the area itself
  label           text NOT NULL,
  enabled         boolean NOT NULL DEFAULT true
);

CREATE TABLE notification_channel (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('ntfy', 'telegram', 'signal', 'email', 'inapp')),
  label           text NOT NULL,
  -- Reference to a secret held outside the database (.env key name, vault
  -- path). Credentials themselves are never stored here.
  secret_ref      text,
  enabled         boolean NOT NULL DEFAULT true
);

CREATE TABLE alert_rule (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  -- Declarative match, evaluated by the rules engine, e.g.
  -- {"type":"event","within_zone":"<zone id>","min_severity":"medium",
  --  "props":{"hazard":"flood"}}
  spec            jsonb NOT NULL,
  min_severity    severity NOT NULL DEFAULT 'medium',
  cooldown        interval NOT NULL DEFAULT '1 hour',
  channel_ids     uuid[] NOT NULL DEFAULT '{}',
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alert (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rule_id         uuid NOT NULL REFERENCES alert_rule (id),
  object_id       uuid REFERENCES object (id),      -- the thing that matched
  severity        severity NOT NULL,
  status          alert_status NOT NULL DEFAULT 'open',
  fired_at        timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  resolved_at     timestamptz,
  explanation     jsonb NOT NULL,                   -- why it fired, with sources
  -- A rule must not re-fire for the same object inside its cooldown.
  dedupe_key      text NOT NULL,
  UNIQUE (rule_id, dedupe_key, fired_at)
);
CREATE INDEX alert_open ON alert (fired_at DESC) WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

-- Who read or changed what. Reads of `private` objects are logged too.
CREATE TABLE audit_log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at              timestamptz NOT NULL DEFAULT now(),
  actor           text NOT NULL,                    -- 'owner', 'pipeline:firms'
  action          text NOT NULL,                    -- 'read', 'write', 'merge'
  target_kind     text NOT NULL,
  target_id       text,
  detail          jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_time ON audit_log (at DESC);
