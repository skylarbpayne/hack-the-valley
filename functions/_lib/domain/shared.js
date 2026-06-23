import * as v from "valibot";

const VALIDATION_ERROR_MESSAGE = "Validation failed";

export const schema = Object.freeze({
  any: v.any,
  array: v.array,
  boolean: v.boolean,
  fallback: v.fallback,
  integer: v.integer,
  literal: v.literal,
  maxLength: v.maxLength,
  minLength: v.minLength,
  minValue: v.minValue,
  nullable: v.nullable,
  nullish: v.nullish,
  number: v.number,
  object: v.object,
  optional: v.optional,
  partial: v.partial,
  picklist: v.picklist,
  pipe: v.pipe,
  record: v.record,
  string: v.string,
  union: v.union,
  unknown: v.unknown
});

export function parseJsonObject(value, fallback = {}) {
  const parsed = parseJson(value, fallback);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
}

export function parseJsonArray(value, fallback = []) {
  const parsed = parseJson(value, fallback);
  return Array.isArray(parsed) ? parsed : fallback;
}

export function stringOrNull(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

export function numberOrNull(value) {
  if (value === null || value === undefined) return null;
  const trimmed = typeof value === "string" ? value.trim() : value;
  if (trimmed === "") return null;
  const normalized = Number(trimmed);
  return Number.isFinite(normalized) ? normalized : null;
}

export function ok(entity, extras = {}) {
  return { ...extras, ok: true, entity };
}

export function validationError(errors) {
  return {
    ok: false,
    code: "validation_error",
    error: VALIDATION_ERROR_MESSAGE,
    errors: Array.isArray(errors) ? errors : [errors]
  };
}

export function parseWithSchema(schemaDefinition, input) {
  const result = safeParseWithSchema(schemaDefinition, input);
  if (result.success) return result.output;

  throw Object.assign(new Error(VALIDATION_ERROR_MESSAGE), validationError(result.errors), {
    status: 400
  });
}

export function safeParseWithSchema(schemaDefinition, input) {
  const result = v.safeParse(schemaDefinition, input);
  if (result.success) {
    return { success: true, output: result.output, errors: [] };
  }

  return {
    success: false,
    output: undefined,
    errors: formatIssues(result.issues),
    issues: result.issues
  };
}

export function approvalRequired(action, preview = null, reason = "Approval is required before this action can run.") {
  return {
    ok: false,
    code: "approval_required",
    approvalRequired: true,
    action,
    preview,
    reason
  };
}

export function stableId(prefix, parts) {
  const normalizedPrefix = String(prefix || "id")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "id";
  return `${normalizedPrefix}_${stableHash(stableStringify(parts)).slice(0, 24)}`;
}

function parseJson(value, fallback) {
  if (typeof value !== "string") return value ?? fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function formatIssues(issues = []) {
  return issues.map((issue) => ({
    path: issuePath(issue),
    message: issue.message
  }));
}

function issuePath(issue) {
  if (!Array.isArray(issue?.path) || issue.path.length === 0) return "";
  return issue.path
    .map((item) => item.key ?? item.value ?? item.input ?? "")
    .filter((part) => part !== "")
    .join(".");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function stableHash(value) {
  let hashA = 0x811c9dc5;
  let hashB = 0x01000193;
  let hashC = 0x85ebca6b;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    hashA = Math.imul(hashA ^ code, 0x01000193) >>> 0;
    hashB = Math.imul(hashB ^ code, 0x85ebca6b) >>> 0;
    hashC = Math.imul(hashC ^ code, 0xc2b2ae35) >>> 0;
  }

  return [hashA, hashB, hashC]
    .map((part) => part.toString(16).padStart(8, "0"))
    .join("");
}
