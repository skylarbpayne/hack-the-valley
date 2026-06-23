import {
  approvalRequired,
  parseJsonObject,
  parseWithSchema,
  schema,
  stableId,
  stringOrNull
} from "./shared.js";

const CONTENT_KINDS = ["blog", "event", "recap", "event_followup", "announcement"];
const CONTENT_STATUSES = ["draft", "needs_review", "approved", "published", "archived"];
const PUBLISH_ACTION = "content_item.publish";

const RelatedSchema = schema.record(schema.string(), schema.unknown());

export const ContentItemSchema = schema.object({
  kind: schema.literal("content_item"),
  id: schema.string(),
  content_kind: schema.picklist(CONTENT_KINDS),
  title: schema.pipe(schema.string(), schema.minLength(1)),
  slug: schema.nullish(schema.string()),
  status: schema.picklist(CONTENT_STATUSES),
  body_html: schema.string(),
  related: RelatedSchema,
  created_at: schema.nullish(schema.string()),
  updated_at: schema.nullish(schema.string())
});

export const ContentPreviewSchema = schema.object({
  kind: schema.literal("content_preview"),
  content_item_id: schema.string(),
  content_kind: schema.picklist(CONTENT_KINDS),
  title: schema.pipe(schema.string(), schema.minLength(1)),
  slug: schema.nullish(schema.string()),
  status: schema.picklist(CONTENT_STATUSES),
  body_html: schema.string(),
  text_preview: schema.string(),
  related: RelatedSchema,
  approval_required: schema.boolean(),
  publish_action: schema.string()
});

export function createContentDraft({ kind, title, bodyHtml, body_html, related = {}, slug = null } = {}) {
  const contentKind = normalizeContentKind(kind);
  const normalizedTitle = stringOrNull(title);
  const normalizedBodyHtml = normalizeBodyHtml(bodyHtml ?? body_html);
  const normalizedRelated = parseJsonObject(related, {});
  const normalizedSlug = stringOrNull(slug) || slugify(normalizedTitle);
  const now = new Date().toISOString();

  const dto = {
    kind: "content_item",
    id: stableId("content", [contentKind, normalizedTitle, normalizedBodyHtml, normalizedRelated]),
    content_kind: contentKind,
    title: normalizedTitle || "",
    slug: normalizedSlug,
    status: "draft",
    body_html: normalizedBodyHtml,
    related: normalizedRelated,
    created_at: now,
    updated_at: now
  };

  return parseWithSchema(ContentItemSchema, dto);
}

export function previewContentItem(contentItem = {}) {
  const item = toContentItem(contentItem);
  const preview = {
    kind: "content_preview",
    content_item_id: item.id,
    content_kind: item.content_kind,
    title: item.title,
    slug: item.slug,
    status: item.status,
    body_html: item.body_html,
    text_preview: textPreview(item.body_html),
    related: item.related,
    approval_required: item.status !== "published",
    publish_action: PUBLISH_ACTION
  };
  return parseWithSchema(ContentPreviewSchema, preview);
}

export function assertPublishApproval(action = PUBLISH_ACTION, approval = null) {
  const normalizedAction = stringOrNull(action) || PUBLISH_ACTION;
  if (!hasExplicitApproval(normalizedAction, approval)) {
    return approvalRequired(
      normalizedAction,
      null,
      "Explicit approval is required before a content item can publish."
    );
  }

  return {
    ok: true,
    action: normalizedAction,
    approval: {
      approved: true,
      approvalId: stringOrNull(approval.approvalId ?? approval.approval_id),
      approvedBy: stringOrNull(approval.approvedBy ?? approval.approved_by ?? approval.userId ?? approval.user_id),
      approvedAt: stringOrNull(approval.approvedAt ?? approval.approved_at) || new Date().toISOString()
    }
  };
}

export function publishContentItem(contentItem = {}, { approval = null } = {}) {
  const item = toContentItem(contentItem);
  const preview = previewContentItem(item);
  const approvalResult = assertPublishApproval(PUBLISH_ACTION, approval);

  if (!approvalResult.ok) {
    return {
      ...approvalResult,
      preview
    };
  }

  return {
    ok: true,
    action: PUBLISH_ACTION,
    published: false,
    stub: true,
    reason: "ContentItem publishing is domain-gated only; no storage or public deploy path exists yet.",
    approval: approvalResult.approval,
    contentItem: {
      ...item,
      status: "approved",
      updated_at: approvalResult.approval.approvedAt
    },
    preview
  };
}

export function toContentItem(input = {}) {
  if (input.kind === "content_item") {
    return parseWithSchema(ContentItemSchema, {
      ...input,
      content_kind: normalizeContentKind(input.content_kind ?? input.contentKind),
      title: stringOrNull(input.title) || "",
      slug: stringOrNull(input.slug),
      status: normalizeStatus(input.status),
      body_html: normalizeBodyHtml(input.body_html ?? input.bodyHtml),
      related: parseJsonObject(input.related, {}),
      created_at: stringOrNull(input.created_at ?? input.createdAt),
      updated_at: stringOrNull(input.updated_at ?? input.updatedAt)
    });
  }

  return createContentDraft(input);
}

function hasExplicitApproval(action, approval) {
  if (!approval || typeof approval !== "object") return false;
  if (approval.approved !== true) return false;

  const approvalAction = stringOrNull(approval.action);
  if (approvalAction && approvalAction !== action) return false;

  const approver = stringOrNull(approval.approvedBy ?? approval.approved_by ?? approval.userId ?? approval.user_id);
  const approvalId = stringOrNull(approval.approvalId ?? approval.approval_id);
  return Boolean(approver || approvalId);
}

function normalizeContentKind(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return normalized || "blog";
}

function normalizeStatus(value) {
  const normalized = String(value || "draft").trim().toLowerCase();
  return CONTENT_STATUSES.includes(normalized) ? normalized : "draft";
}

function normalizeBodyHtml(value) {
  const normalized = stringOrNull(value);
  return normalized || "";
}

function textPreview(html) {
  const text = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 240 ? `${text.slice(0, 237)}…` : text;
}

function slugify(value) {
  return String(value || "untitled-draft")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-") || "untitled-draft";
}
