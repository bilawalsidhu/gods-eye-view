SET search_path = gev, public;

-- ---------------------------------------------------------------------------
-- Seed: the starter ontology
-- ---------------------------------------------------------------------------
-- Deliberately small. Every type below except `person` is something at least
-- one existing layer already produces. `person` is for records you are
-- entitled to hold (an operator agreement, your own household, consenting
-- contacts): it defaults to private, must say on what basis it is held, and
-- carries a retention date.

INSERT INTO object_type (key, label, description, geometry, default_sensitivity, presentation) VALUES
  ('place',          'Place',          'A location you care about: home, work, a route waypoint.', 'any',   'private', '{"glyph":"⌖"}'),
  ('event',          'Event',          'Something that happened or is in force: a fire, flood warning, quake, conflict report, outage.', 'any', 'public', '{"glyph":"◬"}'),
  ('sensor',         'Sensor',         'A fixed instrument: river gauge, air-quality station, webcam, receiver.', 'point', 'public', '{"glyph":"◉"}'),
  ('infrastructure', 'Infrastructure', 'A station, grid zone, port, airport, cable, dam.',        'any',   'public', '{"glyph":"⊞"}'),
  ('asset',          'Asset',          'A mobile thing tracked by public feeds: aircraft, vessel, train, bike-share fleet.', 'point', 'public', '{"glyph":"◇"}'),
  ('organisation',   'Organisation',   'An operator, agency or company that publishes or owns things.', 'none', 'public', '{}'),
  ('area',           'Area',           'A region: administrative boundary, warning zone, exclusion area.', 'area', 'public', '{}'),
  ('document',       'Document',       'A report or file, referenced from the document table.', 'none', 'personal', '{}');

INSERT INTO object_type (key, label, description, geometry, props_schema, default_sensitivity, presentation) VALUES
  ('person', 'Person', 'An individual you are entitled to record. Held only on the stated basis, kept private, and removed at its retention date.', 'any',
   '{"type":"object","required":["basis"],"properties":{"basis":{"type":"string","minLength":3,"description":"Why this record may be held: an agreement reference, consent, or own household."},"purpose":{"type":"string"},"agreement_ref":{"type":"string"}}}',
   'private', '{"glyph":"◍"}');

INSERT INTO link_type (key, label, inverse_label, from_type, to_type, is_symmetric, description) VALUES
  ('located_in',   'is located in',  'contains',        NULL,    'area',           false, 'Containment, usually derived from geometry.'),
  ('near',         'is near',        'is near',         NULL,    NULL,             true,  'Within a stated distance; props.distance_m.'),
  ('affects',      'affects',        'is affected by',  'event', NULL,             false, 'An event touches a place, asset or piece of infrastructure.'),
  ('measured_by',  'is measured by', 'measures',        NULL,    'sensor',         false, 'A sensor reports on an object or area.'),
  ('operated_by',  'is operated by', 'operates',        NULL,    'organisation',   false, 'Who runs or publishes it.'),
  ('reported_by',  'was reported by','reported',        'event', 'document',       false, 'A document is the evidence for an event.'),
  ('derived_from', 'is derived from','derives',         NULL,    NULL,             false, 'An object was computed from another.'),
  ('same_as',      'is the same as', 'is the same as',  NULL,    NULL,             true,  'Accepted duplicate; mirrors a merge_candidate.'),
  ('involved_in',  'was involved in','involved',        'person','event',          false, 'A person took part in or was affected by an event.'),
  ('present_at',   'was present at', 'had present',     'person', NULL,            false, 'A person was at a place or piece of infrastructure during validity.'),
  ('associated_with','is associated with','is associated with', NULL, NULL,        true,  'A looser relationship an analyst asserts; always carries a reason in props.');
