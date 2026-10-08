-- EventInstance is the sole owner of event start/end.  Plan anchors only
-- persist independently editable manual or derived milestones.
DELETE FROM event_plan_anchors WHERE source IN ('event_start', 'event_end');

CREATE TRIGGER IF NOT EXISTS prevent_event_clock_anchor_insert
BEFORE INSERT ON event_plan_anchors
WHEN NEW.source IN ('event_start', 'event_end')
BEGIN SELECT RAISE(ABORT, 'event clock anchors are projections of event_instances'); END;

CREATE TRIGGER IF NOT EXISTS prevent_event_clock_anchor_update
BEFORE UPDATE ON event_plan_anchors
WHEN NEW.source IN ('event_start', 'event_end') OR OLD.source IN ('event_start', 'event_end')
BEGIN SELECT RAISE(ABORT, 'event clock anchors are projections of event_instances'); END;
