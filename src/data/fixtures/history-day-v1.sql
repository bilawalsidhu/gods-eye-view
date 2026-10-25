-- A day file of schema version 1, as openHistoryDayStore wrote it on
-- 2026-10-24 (Node 24.21.0, SQLite 3.53). The store must keep reading it:
-- dayStore.test.mjs builds 2026-10-24.sqlite from this text and reads it back.
-- Do not regenerate it after changing the schema; add a new version beside it.
CREATE TABLE meta (name TEXT PRIMARY KEY, value) WITHOUT ROWID;
CREATE TABLE fixes (
  source TEXT NOT NULL,
  key TEXT NOT NULL,
  t REAL NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  height_m REAL,
  bearing_deg REAL,
  received_at REAL,
  time_kind INTEGER NOT NULL,
  provenance INTEGER NOT NULL,
  flags INTEGER NOT NULL,
  PRIMARY KEY (source, key, t)
) WITHOUT ROWID;
CREATE INDEX fixes_by_time ON fixes (source, t, key);
CREATE TABLE coverage (
  source TEXT NOT NULL,
  from_ms REAL NOT NULL,
  to_ms REAL NOT NULL
);
CREATE INDEX coverage_by_source ON coverage (source, from_ms);
INSERT INTO meta (name, value) VALUES ('day', '2026-10-24');
INSERT INTO meta (name, value) VALUES ('schema_version', 1);
INSERT INTO fixes (source, key, t, lat, lon, height_m, bearing_deg, received_at, time_kind, provenance, flags) VALUES ('adsb', 'a1b2c3', 1792800010000, 30.009765625, -97.7, 1234.5, 271.25, 1792800010400, 0, 0, 0);
INSERT INTO fixes (source, key, t, lat, lon, height_m, bearing_deg, received_at, time_kind, provenance, flags) VALUES ('adsb', 'a1b2c3', 1792800020000, 30.01953125, -97.7, 1240, 270, 1792800020350, 0, 0, 8);
INSERT INTO fixes (source, key, t, lat, lon, height_m, bearing_deg, received_at, time_kind, provenance, flags) VALUES ('adsb', 'a1b2c3', 1792800090000, 30.087890625, -97.7, NULL, NULL, 1792800090300, 0, 0, 16);
INSERT INTO fixes (source, key, t, lat, lon, height_m, bearing_deg, received_at, time_kind, provenance, flags) VALUES ('adsb', 'ñu', 1792800015000, 30.0146484375, -97.7, NULL, NULL, NULL, 1, 0, 0);
INSERT INTO fixes (source, key, t, lat, lon, height_m, bearing_deg, received_at, time_kind, provenance, flags) VALUES ('adsb', '～', 1792800015000, -0.5, 179.999, NULL, NULL, NULL, 0, 2, 0);
INSERT INTO fixes (source, key, t, lat, lon, height_m, bearing_deg, received_at, time_kind, provenance, flags) VALUES ('adsb', '😀', 1792800015000, 30.0146484375, -97.7, NULL, NULL, NULL, 2, 1, 0);
INSERT INTO fixes (source, key, t, lat, lon, height_m, bearing_deg, received_at, time_kind, provenance, flags) VALUES ('ais', 'ais-1', 1792800030000, 51.9, 4.125, NULL, NULL, NULL, 0, 0, 0);
INSERT INTO coverage (source, from_ms, to_ms) VALUES ('adsb', 1792800000000, 1792800030000);
INSERT INTO coverage (source, from_ms, to_ms) VALUES ('adsb', 1792800060000, 1792800120000);
INSERT INTO coverage (source, from_ms, to_ms) VALUES ('ais', 1792800025000, 1792800035000);
