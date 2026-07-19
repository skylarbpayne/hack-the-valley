-- Preserve immutable template versions and prevent impossible work-item completion.
CREATE TRIGGER IF NOT EXISTS prevent_used_template_version_update
BEFORE UPDATE ON timeline_template_versions
WHEN OLD.instantiated_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'instantiated template versions are immutable'); END;

CREATE TRIGGER IF NOT EXISTS prevent_used_template_version_delete
BEFORE DELETE ON timeline_template_versions
WHEN OLD.instantiated_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'instantiated template versions are immutable'); END;

CREATE TRIGGER IF NOT EXISTS prevent_used_template_anchor_mutation
BEFORE UPDATE ON timeline_template_anchors
WHEN EXISTS (SELECT 1 FROM timeline_template_versions v WHERE v.id = OLD.template_version_id AND v.instantiated_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'instantiated template versions are immutable'); END;

CREATE TRIGGER IF NOT EXISTS prevent_used_template_anchor_delete
BEFORE DELETE ON timeline_template_anchors
WHEN EXISTS (SELECT 1 FROM timeline_template_versions v WHERE v.id = OLD.template_version_id AND v.instantiated_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'instantiated template versions are immutable'); END;

CREATE TRIGGER IF NOT EXISTS prevent_used_template_item_mutation
BEFORE UPDATE ON timeline_template_items
WHEN EXISTS (SELECT 1 FROM timeline_template_versions v WHERE v.id = OLD.template_version_id AND v.instantiated_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'instantiated template versions are immutable'); END;

CREATE TRIGGER IF NOT EXISTS prevent_used_template_item_delete
BEFORE DELETE ON timeline_template_items
WHEN EXISTS (SELECT 1 FROM timeline_template_versions v WHERE v.id = OLD.template_version_id AND v.instantiated_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'instantiated template versions are immutable'); END;

CREATE TRIGGER IF NOT EXISTS validate_event_plan_item_completion
BEFORE UPDATE OF status ON event_plan_items
WHEN NEW.status = 'completed' AND OLD.status IS NOT 'completed' AND (
  (NEW.evidence_required = 1 AND NOT EXISTS (SELECT 1 FROM event_plan_item_evidence e WHERE e.event_plan_item_id = NEW.id))
  OR EXISTS (
    SELECT 1 FROM event_plan_dependencies d
    JOIN event_plan_items prerequisite ON prerequisite.id = d.depends_on_item_id
    WHERE d.event_plan_item_id = NEW.id AND prerequisite.status != 'completed'
  )
)
BEGIN SELECT RAISE(ABORT, 'plan item completion requires evidence and completed dependencies'); END;
