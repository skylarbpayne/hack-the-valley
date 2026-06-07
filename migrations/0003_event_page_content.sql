-- Replace before/after event copy slots with one editable event page body.
-- 0002 briefly introduced content_before/content_after; keep any entered copy by folding it into page_content.

ALTER TABLE events ADD COLUMN page_content TEXT;

UPDATE events
SET page_content = TRIM(
  COALESCE(content_before, '') ||
  CASE
    WHEN content_before IS NOT NULL AND content_before != '' AND content_after IS NOT NULL AND content_after != '' THEN CHAR(10) || CHAR(10)
    ELSE ''
  END ||
  COALESCE(content_after, '')
)
WHERE page_content IS NULL
  AND (
    (content_before IS NOT NULL AND content_before != '')
    OR (content_after IS NOT NULL AND content_after != '')
  );

ALTER TABLE events DROP COLUMN content_before;
ALTER TABLE events DROP COLUMN content_after;
