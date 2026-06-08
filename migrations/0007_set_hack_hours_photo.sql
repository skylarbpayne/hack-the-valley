-- Set the public Hack Hours flyer image.
UPDATE events
SET image_url = '/assets/events/hack-hours.jpeg',
    updated_at = CURRENT_TIMESTAMP
WHERE slug = 'hack-hours';
