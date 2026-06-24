-- Tighten archived Hack the Valley 2026 project/showcase linkage.
-- The original event was imported as an archived event series plus project links with no concrete instance.
-- Backfill one archived instance so event-scoped project rows can use the same instance-level model as Hack Hours/Demo Hours.

INSERT OR IGNORE INTO event_instances (
  id,
  event_slug,
  instance_key,
  title,
  starts_at,
  ends_at,
  venue_name,
  venue_address,
  capacity,
  status,
  metadata_json,
  created_at,
  updated_at
)
SELECT
  'inst_hack_the_valley_2026',
  'hack-the-valley-2026',
  '2026-05-30',
  'Hack the Valley 2026',
  '2026-05-30T14:30:00.000Z',
  '2026-05-31T01:00:00.000Z',
  'CSUB Student Union MPR',
  'Bakersfield, California',
  80,
  'archived',
  '{"source":"data_integrity_backfill","note":"Archived concrete instance for Hack the Valley 2026 project/showcase linkage."}',
  COALESCE(created_at, CURRENT_TIMESTAMP),
  CURRENT_TIMESTAMP
FROM events
WHERE slug = 'hack-the-valley-2026';

UPDATE event_project_submissions
SET event_instance_id = 'inst_hack_the_valley_2026',
    updated_at = CURRENT_TIMESTAMP
WHERE event_slug = 'hack-the-valley-2026'
  AND event_instance_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM event_instances ei
    WHERE ei.id = 'inst_hack_the_valley_2026'
      AND ei.event_slug = event_project_submissions.event_slug
  );

-- Keep duplicate legacy submissions attached through event_project_submissions.
-- If a project was imported without a canonical submission, choose a deterministic linked legacy row.
UPDATE projects
SET canonical_submission_id = (
      SELECT eps.submission_id
      FROM event_project_submissions eps
      WHERE eps.project_id = projects.id
        AND eps.submission_id IS NOT NULL
      ORDER BY eps.created_at ASC, eps.submission_id ASC
      LIMIT 1
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE canonical_submission_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM event_project_submissions eps
    WHERE eps.project_id = projects.id
      AND eps.submission_id IS NOT NULL
  );
