import test from "node:test";
import assert from "node:assert/strict";

import {
  approvalRequired,
  ok,
  parseJsonArray,
  parseJsonObject,
  parseWithSchema,
  safeParseWithSchema,
  schema,
  stableId,
  stringOrNull,
  numberOrNull,
  validationError
} from "../functions/_lib/domain/shared.js";

test("parseJsonObject and parseJsonArray tolerate stored JSON and fallbacks", () => {
  assert.deepEqual(parseJsonObject('{"enabled":true,"count":2}', {}), { enabled: true, count: 2 });
  assert.deepEqual(parseJsonObject({ already: "object" }, {}), { already: "object" });
  assert.deepEqual(parseJsonObject('["not","object"]', { fallback: true }), { fallback: true });
  assert.deepEqual(parseJsonObject("not-json", { fallback: true }), { fallback: true });

  assert.deepEqual(parseJsonArray('[{"id":"a"}]', []), [{ id: "a" }]);
  assert.deepEqual(parseJsonArray(["already"], []), ["already"]);
  assert.deepEqual(parseJsonArray('{"not":"array"}', ["fallback"]), ["fallback"]);
  assert.deepEqual(parseJsonArray("not-json", ["fallback"]), ["fallback"]);
});

test("primitive normalization returns trimmed strings, finite numbers, or null", () => {
  assert.equal(stringOrNull("  Hack the Valley  "), "Hack the Valley");
  assert.equal(stringOrNull(2026), "2026");
  assert.equal(stringOrNull("   "), null);
  assert.equal(stringOrNull(null), null);

  assert.equal(numberOrNull("42"), 42);
  assert.equal(numberOrNull(" 42 "), 42);
  assert.equal(numberOrNull(0), 0);
  assert.equal(numberOrNull(""), null);
  assert.equal(numberOrNull("   "), null);
  assert.equal(numberOrNull("nope"), null);
  assert.equal(numberOrNull(Infinity), null);
});

test("domain response helpers standardize successful, validation, and approval-gated results", () => {
  assert.deepEqual(ok({ id: "event_1" }, { cursor: "next" }), {
    ok: true,
    entity: { id: "event_1" },
    cursor: "next"
  });
  assert.deepEqual(ok({ id: "event_1" }, { ok: false, entity: null }), {
    ok: true,
    entity: { id: "event_1" }
  });

  assert.deepEqual(validationError(["title is required"]), {
    ok: false,
    code: "validation_error",
    error: "Validation failed",
    errors: ["title is required"]
  });

  assert.deepEqual(
    approvalRequired("campaign.send", { recipients: 3 }, "Production messages require organizer approval."),
    {
      ok: false,
      code: "approval_required",
      approvalRequired: true,
      action: "campaign.send",
      preview: { recipients: 3 },
      reason: "Production messages require organizer approval."
    }
  );
});

test("schema helpers parse with Valibot without leaking library-specific errors", () => {
  const CommandInput = schema.object({
    action: schema.pipe(schema.string(), schema.minLength(1)),
    dryRun: schema.optional(schema.boolean(), false)
  });

  assert.deepEqual(parseWithSchema(CommandInput, { action: "check" }), { action: "check", dryRun: false });

  const safeValid = safeParseWithSchema(CommandInput, { action: "check", dryRun: true });
  assert.deepEqual(safeValid, { success: true, output: { action: "check", dryRun: true }, errors: [] });

  const safeInvalid = safeParseWithSchema(CommandInput, { action: "" });
  assert.equal(safeInvalid.success, false);
  assert.deepEqual(safeInvalid.errors, [{ path: "action", message: "Invalid length: Expected >=1 but received 0" }]);

  assert.throws(
    () => parseWithSchema(CommandInput, { action: "" }),
    (error) => error.status === 400 && error.code === "validation_error" && error.errors[0].path === "action"
  );
});

test("stableId is deterministic and insensitive to object key order", () => {
  const first = stableId("audit", ["grant", { targetId: "user_1", role: "admin" }]);
  const second = stableId("audit", ["grant", { role: "admin", targetId: "user_1" }]);
  const different = stableId("audit", ["grant", { role: "super_admin", targetId: "user_1" }]);

  assert.equal(first, second);
  assert.notEqual(first, different);
  assert.match(first, /^audit_[a-f0-9]{24}$/);
});
