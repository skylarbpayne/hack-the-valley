-- Public award badge labels should show the prize name + event, never dollar amounts.
-- These catalog fallbacks cover legacy derived badges while per-award badges are derived from event_project_awards.
UPDATE badges
SET name = 'Prize Winner - Hack the Valley 2026',
    description = 'Awarded at Hack the Valley 2026.',
    updated_at = CURRENT_TIMESTAMP
WHERE slug = 'won-prize-htv-2026';

UPDATE badges
SET name = 'Overall Winner - Hack the Valley 2026',
    description = 'Awarded at Hack the Valley 2026.',
    updated_at = CURRENT_TIMESTAMP
WHERE slug = 'won-overall-htv-2026';
