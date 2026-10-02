-- Event-planning schedule and assignee invariants. Migrations are the schema source of truth.
CREATE TRIGGER IF NOT EXISTS validate_timeline_template_item_schedule_insert
BEFORE INSERT ON timeline_template_items
WHEN (NEW.schedule_mode = 'relative' AND (NEW.anchor_key IS NULL OR NEW.offset_days IS NULL))
  OR (NEW.schedule_mode = 'fixed' AND (NEW.due_at IS NULL OR NEW.anchor_key IS NOT NULL OR NEW.offset_days IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'invalid timeline template item schedule'); END;

CREATE TRIGGER IF NOT EXISTS validate_timeline_template_item_schedule_update
BEFORE UPDATE OF schedule_mode, anchor_key, offset_days, due_at ON timeline_template_items
WHEN (NEW.schedule_mode = 'relative' AND (NEW.anchor_key IS NULL OR NEW.offset_days IS NULL))
  OR (NEW.schedule_mode = 'fixed' AND (NEW.due_at IS NULL OR NEW.anchor_key IS NOT NULL OR NEW.offset_days IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'invalid timeline template item schedule'); END;

CREATE TRIGGER IF NOT EXISTS validate_event_plan_item_schedule_insert
BEFORE INSERT ON event_plan_items
WHEN (NEW.schedule_mode = 'relative' AND (NEW.anchor_key IS NULL OR NEW.offset_days IS NULL))
  OR (NEW.schedule_mode = 'fixed' AND (NEW.due_at IS NULL OR NEW.anchor_key IS NOT NULL OR NEW.offset_days IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'invalid event plan item schedule'); END;

CREATE TRIGGER IF NOT EXISTS validate_event_plan_item_schedule_update
BEFORE UPDATE OF schedule_mode, anchor_key, offset_days, due_at ON event_plan_items
WHEN (NEW.schedule_mode = 'relative' AND (NEW.anchor_key IS NULL OR NEW.offset_days IS NULL))
  OR (NEW.schedule_mode = 'fixed' AND (NEW.due_at IS NULL OR NEW.anchor_key IS NOT NULL OR NEW.offset_days IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'invalid event plan item schedule'); END;

CREATE TRIGGER IF NOT EXISTS validate_event_plan_assignment_insert
BEFORE INSERT ON event_plan_assignments
WHEN NEW.assignee_type != 'user' OR NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.assignee_id)
BEGIN SELECT RAISE(ABORT, 'event plan assignments require an existing user'); END;

CREATE TRIGGER IF NOT EXISTS validate_event_plan_assignment_update
BEFORE UPDATE OF assignee_type, assignee_id ON event_plan_assignments
WHEN NEW.assignee_type != 'user' OR NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.assignee_id)
BEGIN SELECT RAISE(ABORT, 'event plan assignments require an existing user'); END;
