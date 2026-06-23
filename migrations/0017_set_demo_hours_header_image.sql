-- Set the public Demo Hours poster as the event header image.
UPDATE events
SET image_url = '/assets/events/demo-hours.png',
    updated_at = CURRENT_TIMESTAMP
WHERE slug = 'demo-hours';
