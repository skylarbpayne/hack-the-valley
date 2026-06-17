-- Add the canonical community/profile badges Skylar requested.
-- Badge awards are derived from attendance/project facts at profile render time;
-- these rows keep admin/manual badge tools and catalog metadata aligned.

INSERT INTO badges (id, slug, name, description, badge_type, rule_json, active, created_at, updated_at)
VALUES
  ('bdg_attended_htv_2026', 'attended-htv-2026', 'HTV 2026 Attendee', 'Checked in at Hack the Valley 2026.', 'attendance', '{"derived_from":"event_participant_events","event_slug":"hack-the-valley-2026","event_type":"checked_in","icon":"/images/badges/attended-htv-2026.svg"}', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('bdg_won_prize_htv_2026', 'won-prize-htv-2026', 'HTV 2026 Prize Winner', 'Won a prize at Hack the Valley 2026.', 'award', '{"derived_from":"event_project_awards","event_slug":"hack-the-valley-2026","icon":"/images/badges/won-prize-htv-2026.svg"}', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('bdg_won_overall_htv_2026', 'won-overall-htv-2026', 'HTV 2026 Overall Winner', 'Won the Overall Prize at Hack the Valley 2026.', 'award', '{"derived_from":"event_project_awards","event_slug":"hack-the-valley-2026","award_slug":"overall","icon":"/images/badges/won-overall-htv-2026.svg"}', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('bdg_submitted_project', 'submitted-project', 'Project Shipper', 'Submitted a project to the Hack the Valley community.', 'project', '{"derived_from":"project_members","icon":"/images/badges/submitted-project.svg"}', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('bdg_attended_hack_hours', 'attended-hack-hours', 'Hack Hours Regular', 'Checked in at a Hack Hours event.', 'attendance', '{"derived_from":"event_participant_events","event_slug":"hack-hours","event_type":"checked_in","icon":"/images/badges/attended-hack-hours.svg"}', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT(slug) DO UPDATE SET
  name = excluded.name,
  description = excluded.description,
  badge_type = excluded.badge_type,
  rule_json = excluded.rule_json,
  active = 1,
  updated_at = excluded.updated_at;
