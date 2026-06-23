import test from "node:test";
import assert from "node:assert/strict";

import {
  assertPublishApproval,
  createContentDraft,
  previewContentItem,
  publishContentItem,
  toContentItem
} from "../functions/_lib/domain/content.js";

import * as domain from "../functions/_lib/domain/index.js";

test("creates deterministic ContentItem drafts without adding storage concerns", () => {
  const first = createContentDraft({
    kind: "recap",
    title: " Hack the Valley recap ",
    bodyHtml: "<p>Students built <strong>projects</strong>.</p>",
    related: { event_slug: "hack-the-valley-2026" }
  });
  const second = createContentDraft({
    kind: "recap",
    title: "Hack the Valley recap",
    bodyHtml: "<p>Students built <strong>projects</strong>.</p>",
    related: { event_slug: "hack-the-valley-2026" }
  });

  assert.equal(first.kind, "content_item");
  assert.equal(first.content_kind, "recap");
  assert.equal(first.title, "Hack the Valley recap");
  assert.equal(first.slug, "hack-the-valley-recap");
  assert.equal(first.status, "draft");
  assert.equal(first.body_html, "<p>Students built <strong>projects</strong>.</p>");
  assert.deepEqual(first.related, { event_slug: "hack-the-valley-2026" });
  assert.equal(first.id, second.id);
  assert.match(first.id, /^content_[a-f0-9]{24}$/);
  assert.match(first.created_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.throws(
    () => createContentDraft({ kind: "cms_monster", title: "Nope", bodyHtml: "<p>Nope</p>" }),
    /Validation failed/
  );
  assert.throws(
    () => createContentDraft({ kind: "blog", bodyHtml: "<p>Missing title</p>" }),
    /Validation failed/
  );
});

test("builds ContentItem previews suitable for blog/event/recap broadcast review", () => {
  const draft = createContentDraft({
    kind: "blog",
    title: "July Hack Hours",
    bodyHtml: "<h1>Hack Hours</h1><p>Bring a laptop &amp; demo.</p><script>nope()</script>",
    related: { event_slug: "hack-hours", broadcast: "preview-only" }
  });

  const preview = previewContentItem(draft);

  assert.equal(preview.kind, "content_preview");
  assert.equal(preview.content_item_id, draft.id);
  assert.equal(preview.content_kind, "blog");
  assert.equal(preview.title, "July Hack Hours");
  assert.equal(preview.body_html, draft.body_html);
  assert.equal(preview.text_preview, "Hack Hours Bring a laptop & demo.");
  assert.equal(preview.approval_required, true);
  assert.equal(preview.publish_action, "content_item.publish");
});

test("publishContentItem is approval-gated and does not create a public publish path", () => {
  const draft = createContentDraft({
    kind: "event",
    title: "Demo Night",
    bodyHtml: "<p>Preview copy.</p>",
    related: { event_slug: "demo-night" }
  });

  const blocked = publishContentItem(draft);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "approval_required");
  assert.equal(blocked.approvalRequired, true);
  assert.equal(blocked.action, "content_item.publish");
  assert.equal(blocked.preview.content_item_id, draft.id);
  assert.equal(blocked.preview.text_preview, "Preview copy.");

  const mismatch = assertPublishApproval("content_item.publish", {
    approved: true,
    action: "campaign.send",
    approvedBy: "usr_admin"
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, "approval_required");

  const approved = publishContentItem(draft, {
    approval: { approved: true, approvedBy: "usr_admin", approvalId: "appr_1", action: "content_item.publish" }
  });
  assert.equal(approved.ok, true);
  assert.equal(approved.published, false);
  assert.equal(approved.stub, true);
  assert.match(approved.reason, /no storage or public deploy path/i);
  assert.equal(approved.contentItem.status, "approved");
  assert.equal(approved.approval.approvalId, "appr_1");
});

test("ContentItem helpers are exported through the domain barrel", () => {
  assert.equal(domain.createContentDraft, createContentDraft);
  assert.equal(domain.previewContentItem, previewContentItem);
  assert.equal(domain.publishContentItem, publishContentItem);

  const normalized = toContentItem({
    kind: "content_item",
    id: "content_existing",
    contentKind: "event_followup",
    title: "Follow-up",
    status: "needs_review",
    bodyHtml: "<p>Thanks.</p>",
    related: "{\"event_instance_id\":\"inst_1\"}"
  });
  assert.equal(normalized.content_kind, "event_followup");
  assert.equal(normalized.status, "needs_review");
  assert.deepEqual(normalized.related, { event_instance_id: "inst_1" });
});
