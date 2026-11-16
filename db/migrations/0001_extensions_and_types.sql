-- God's Eye View data platform: core schema, migration 1 of 7.
--
-- Target: PostgreSQL 16 + PostGIS 3. Single owner today; the shape leaves room
-- for roles later (see docs/platform/ROADMAP.md, phase 7). Migrations are
-- applied in filename order by server/platform/migrate.js and are never edited
-- after they ship: a change is a new file.
--
-- Design rules this file encodes:
--   1. The ontology is DATA. Object and link types live in tables, so adding
--      a type is an INSERT, not a schema migration.
--   2. History is append-only. An object's identity never changes; what is
--      known about it is a series of versioned states.
--   3. Every fact says where it came from: a source, an ingest run, a
--      confidence, and the raw payload it was read from.
--   4. High-volume readings (positions, sensor values) are observations in a
--      partitioned table, not states, so they cannot bloat the object tables.
--   5. Sensitivity is a column, not a convention. The `person` type exists
--      for operator-agreed use and defaults to `private` with a required
--      basis (see docs/platform/ONTOLOGY.md, "People").

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- exclusion constraints on ranges
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- fuzzy name matching

CREATE SCHEMA IF NOT EXISTS gev;
SET search_path = gev, public;

-- ---------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------

-- Who may see a record. `private` data (your places, your notes) never leaves
-- the database through a shared export or a public share link.
CREATE TYPE sensitivity AS ENUM ('public', 'personal', 'private');

CREATE TYPE geometry_kind AS ENUM ('none', 'point', 'line', 'area', 'any');

CREATE TYPE merge_verdict AS ENUM ('same', 'different', 'undecided');

CREATE TYPE alert_status AS ENUM ('open', 'acknowledged', 'resolved', 'muted');

CREATE TYPE severity AS ENUM ('info', 'low', 'medium', 'high', 'critical');
