-- Event page metadata for photos, before/after content, and recurrence-ready definitions.
-- Existing D1 databases have 0001 applied already, so these stay in a forward migration.

ALTER TABLE events ADD COLUMN image_url TEXT;
ALTER TABLE events ADD COLUMN content_before TEXT;
ALTER TABLE events ADD COLUMN content_after TEXT;
ALTER TABLE events ADD COLUMN recurrence_rule_json TEXT;
