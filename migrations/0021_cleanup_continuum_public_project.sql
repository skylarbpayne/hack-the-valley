-- Clean up public-safe Continuum showcase fields for Hack the Valley 2026.
-- Avoid placeholder descriptions and intentionally broken links on public project APIs.

UPDATE projects
SET description = CASE
      WHEN description IS NULL OR trim(description) = '' OR trim(description) = '.' THEN 'Best AI winning project at Hack the Valley 2026.'
      ELSE description
    END,
    repo_url = CASE
      WHEN lower(trim(COALESCE(repo_url, ''))) IN ('https://nothing', 'http://nothing', 'nothing', '.') THEN NULL
      ELSE repo_url
    END,
    demo_url = CASE
      WHEN lower(trim(COALESCE(demo_url, ''))) IN ('https://nothing', 'http://nothing', 'nothing', '.') THEN NULL
      ELSE demo_url
    END,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'prj_continuum' OR slug = 'continuum';
