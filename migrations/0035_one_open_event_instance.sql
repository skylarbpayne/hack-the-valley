-- Preserve historical rows while preventing new ambiguous signup routing.
-- Existing legacy duplicates are left intact; a subsequent write must resolve them.
CREATE TRIGGER IF NOT EXISTS event_instances_one_open_insert
BEFORE INSERT ON event_instances
WHEN NEW.status = 'open' AND EXISTS (
  SELECT 1 FROM event_instances WHERE event_slug = NEW.event_slug AND status = 'open'
)
BEGIN
  SELECT RAISE(ABORT, 'Only one open instance per event series');
END;

CREATE TRIGGER IF NOT EXISTS event_instances_one_open_update
BEFORE UPDATE OF status, event_slug ON event_instances
WHEN NEW.status = 'open' AND EXISTS (
  SELECT 1 FROM event_instances WHERE event_slug = NEW.event_slug AND status = 'open' AND id != OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'Only one open instance per event series');
END;
