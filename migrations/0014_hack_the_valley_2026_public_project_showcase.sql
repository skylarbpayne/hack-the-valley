-- Normalize Hack the Valley 2026 submissions into the public project showcase.
-- Projects are public showcase records by default; only obvious test/smoke rows stay hidden.

UPDATE event_project_submissions
SET status = 'showcased',
    source = 'submission_migration',
    updated_at = CURRENT_TIMESTAMP
WHERE event_slug = 'hack-the-valley-2026'
  AND project_id IN (
    'prj_calcguide',
    'prj_emergency_digital_tools',
    'prj_live_lecture_accessibility_assistant',
    'prj_no_sleepy_joes',
    'prj_ratemyrunner',
    'prj_the_commons',
    'prj_tokoro',
    'prj_valley_roots_outreach',
    'prj_vapevision'
  );

UPDATE event_project_submissions
SET status = 'winner',
    source = 'submission_migration',
    updated_at = CURRENT_TIMESTAMP
WHERE event_slug = 'hack-the-valley-2026'
  AND project_id IN (
    'prj_decode_it',
    'prj_valley_sat_prep',
    'prj_techpath_kern',
    'prj_continuum'
  );

UPDATE event_project_submissions
SET status = 'hidden',
    source = 'organizer_cleanup_hidden_test_row',
    updated_at = CURRENT_TIMESTAMP
WHERE event_slug = 'hack-the-valley-2026'
  AND project_id IN (
    'prj_test_title',
    'prj_ham',
    'prj_palmer_smoke_test_delete_me_20260615034759'
  );

INSERT INTO event_project_awards (
  id,
  event_slug,
  project_id,
  award_slug,
  award_title,
  award_rank,
  prize_amount_cents,
  created_at,
  updated_at
) VALUES
  ('epa_hack_the_valley_2026_prj_decode_it_overall', 'hack-the-valley-2026', 'prj_decode_it', 'overall', 'Overall Winner', 1, 60000, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('epa_hack_the_valley_2026_prj_valley_sat_prep_education', 'hack-the-valley-2026', 'prj_valley_sat_prep', 'education', 'Best Education', 1, 25000, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('epa_hack_the_valley_2026_prj_techpath_kern_social_impact', 'hack-the-valley-2026', 'prj_techpath_kern', 'social-impact', 'Best Social Impact', 1, 20000, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('epa_hack_the_valley_2026_prj_continuum_ai', 'hack-the-valley-2026', 'prj_continuum', 'ai', 'Best AI', 1, 20000, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT(event_slug, project_id, award_slug) DO UPDATE SET
  award_title = excluded.award_title,
  award_rank = excluded.award_rank,
  prize_amount_cents = excluded.prize_amount_cents,
  updated_at = excluded.updated_at;
