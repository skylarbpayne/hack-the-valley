-- Correct Demo Hours venue address in the event series and concrete instance.
UPDATE events
SET venue_address = '2020 Eye street',
    updated_at = CURRENT_TIMESTAMP
WHERE slug = 'demo-hours';

UPDATE event_instances
SET venue_address = '2020 Eye street',
    updated_at = CURRENT_TIMESTAMP
WHERE event_slug = 'demo-hours';
