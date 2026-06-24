import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { adminWorkflowSurface, onRequestGet as getWorkflows } from "../functions/api/admin/workflows.js";
import { onRequestGet as getAudit } from "../functions/api/admin/audit.js";
import worker from "../worker.js";

function adminDb({ role = "admin", auditRows = [], onAuditBinds = null, auditEventsTableMissing = false } = {}) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          this.args = args;
          return this;
        },
        async first() {
          if (/FROM user_sessions/.test(sql)) {
            return {
              id: "usr_admin",
              email: "admin@example.com",
              name: "Admin User",
              session_id: "ses_admin",
              session_expires_at: "2099-01-01T00:00:00.000Z"
            };
          }
          if (/FROM roles/.test(sql)) {
            return role && this.args.includes(role)
              ? { role, scope_type: "global", scope_id: "*", created_at: "2026-01-01T00:00:00.000Z" }
              : null;
          }
          throw new Error(`Unexpected first() query: ${sql}`);
        },
        async all() {
          if (auditEventsTableMissing && /FROM audit_events/.test(sql)) throw new Error("no such table: audit_events");
          if (/FROM admin_audit_events/.test(sql)) {
            if (onAuditBinds) onAuditBinds(this.args, sql);
            return { results: auditRows };
          }
          if (/FROM roles/.test(sql)) return { results: [] };
          return { results: [] };
        },
        async run() {
          return { success: true };
        }
      };
    }
  };
}

function adminRequest(path = "/api/admin/workflows", headers = { cookie: "htv_session=test-session" }) {
  return new Request(`https://hackthevalley.org${path}`, { headers });
}

function noSessionDb() {
  return {
    prepare() {
      return {
        bind(...args) { this.args = args; return this; },
        async first() { return null; },
        async all() { return { results: [] }; },
        async run() { return { success: true }; }
      };
    }
  };
}

test("admin HTML declares the non-editorial workflow command surface and loads /api/admin/workflows", () => {
  const html = readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
  assert.match(html, /id="workflow-command-surface"/);
  assert.match(html, /Workflow map/);
  assert.match(html, /function loadWorkflows/);
  assert.match(html, /api\("\/api\/admin\/workflows"\)/);
  assert.match(html, /loadWorkflows\(\)/);
  assert.match(html, /catch \(error\)[\s\S]*return null;/);

  const start = html.indexOf("id=\"workflow-command-surface\"");
  const end = html.indexOf("id=\"events-admin\"", start);
  const workflowHtml = html.slice(start, end);
  assert.match(workflowHtml, /Live operator areas first/);
  assert.match(workflowHtml, /Editorial and outbound messaging work stays out of this surface/);
  assert.doesNotMatch(workflowHtml, /blog|campaign|email blast/i);
});

test("workflow endpoint requires an admin session role", async () => {
  const noSession = await getWorkflows({
    request: adminRequest("/api/admin/workflows", {}),
    env: { HTV_DB: adminDb() },
    params: {}
  });
  assert.equal(noSession.status, 401);

  const forbidden = await getWorkflows({
    request: adminRequest(),
    env: { HTV_DB: adminDb({ role: null }) },
    params: {}
  });
  assert.equal(forbidden.status, 403);
});

test("workflow endpoint rejects bootstrap-token access without a session role", async () => {
  const bootstrapHeaders = { authorization: "Bearer bootstrap-secret" };
  const env = {
    HTV_DB: noSessionDb(),
    HTV_ADMIN_TOKEN: "bootstrap-secret",
    HTV_ADMIN_BOOTSTRAP_TOKEN_ENABLED: "1"
  };

  const workflows = await getWorkflows({
    request: adminRequest("/api/admin/workflows", bootstrapHeaders),
    env,
    params: {}
  });
  assert.equal(workflows.status, 403);

  const audit = await getAudit({
    request: adminRequest("/api/admin/audit", bootstrapHeaders),
    env,
    params: {}
  });
  assert.equal(audit.status, 403);
});

test("workflow endpoint returns only non-editorial sections and gated command metadata", async () => {
  const response = await getWorkflows({
    request: adminRequest(),
    env: { HTV_DB: adminDb() },
    params: {}
  });
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.ok, true);
  assert.deepEqual(body.sections.map((section) => section.id), ["events", "participation", "projects", "badges", "audit"]);
  assert.deepEqual(body.domains, ["events", "participation", "projects", "badges", "audit"]);
  assert.equal(body.sections.some((section) => ["content", "campaigns"].includes(section.id)), false);

  const commands = body.sections.flatMap((section) => section.commands);
  assert.ok(commands.length > 10);
  assert.ok(commands.every((command) => command.id && command.label && command.method && command.pathTemplate && command.domain && command.capability));
  assert.ok(commands.some((command) => command.readOnly === true));
  assert.ok(commands.some((command) => command.readOnly === false));
  assert.ok(commands.filter((command) => command.danger).every((command) => command.approvalRequired === true && command.readOnly === false && command.method === "GATED"));
  assert.ok(commands.filter((command) => !command.readOnly).every((command) => command.approvalRequired === true));

  const serialized = JSON.stringify(body).toLowerCase();
  assert.doesNotMatch(serialized, /blog|contentitem|campaign|email blast/);
});

test("worker routes /api/admin/workflows through the session-admin endpoint", async () => {
  const response = await worker.fetch(adminRequest(), { HTV_DB: adminDb() }, {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.sections.find((section) => section.id === "audit")?.commands[0].pathTemplate.startsWith("/api/admin/audit"), true);
});

test("admin audit endpoint is read-only, admin-gated, clamps limits, and maps rows safely", async () => {
  let observedBinds = null;
  const response = await getAudit({
    request: adminRequest("/api/admin/audit?limit=500&action=badge.award&scope_type=badge_award&target_user_id=usr_1"),
    env: {
      HTV_DB: adminDb({
        auditRows: [{
          id: "audit_1",
          action: "badge.award",
          actor_user_id: "usr_admin",
          target_user_id: "usr_1",
          target_email: "builder@example.com",
          role: null,
          scope_type: "badge_award",
          scope_id: "award_1",
          metadata_json: JSON.stringify({ targetType: "badge_award", targetId: "award_1", badgeSlug: "shared-demo" }),
          created_at: "2026-06-23T12:00:00.000Z"
        }],
        onAuditBinds(args, sql) {
          assert.match(sql, /FROM audit_events/);
          assert.match(sql, /FROM admin_audit_events/);
          observedBinds = args;
        }
      })
    },
    params: {}
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.filters.limit, 100);
  assert.equal(body.filters.action, "badge.award");
  assert.equal(body.filters.scopeType, "badge_award");
  assert.equal(body.filters.targetUserId, "usr_1");
  assert.deepEqual(observedBinds, ["badge.award", "badge.award", "badge_award", "badge_award", "usr_1", "usr_1", "usr_1", 100]);
  assert.equal(body.events[0].targetType, "badge_award");
  assert.equal(body.events[0].metadata.badgeSlug, "shared-demo");

  const unauthenticated = await getAudit({
    request: adminRequest("/api/admin/audit", {}),
    env: { HTV_DB: adminDb() },
    params: {}
  });
  assert.equal(unauthenticated.status, 401);
});

test("admin audit endpoint falls back to legacy rows while the generic audit migration rolls out", async () => {
  const response = await getAudit({
    request: adminRequest("/api/admin/audit?target_user_id=usr_legacy"),
    env: {
      HTV_DB: adminDb({
        auditEventsTableMissing: true,
        auditRows: [{
          id: "audit_legacy",
          action: "grant_admin",
          actor_user_id: "usr_admin",
          target_user_id: "usr_legacy",
          target_email: "legacy@example.com",
          role: "admin",
          scope_type: "global",
          scope_id: "*",
          metadata_json: JSON.stringify({ source: "admin-role-manager" }),
          created_at: "2026-06-23T12:00:00.000Z"
        }]
      })
    },
    params: {}
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.events.length, 1);
  assert.equal(body.events[0].targetType, "user");
  assert.equal(body.events[0].targetId, "usr_legacy");
  assert.equal(body.events[0].targetEmail, "legacy@example.com");
});

test("admin workflow surface helper is deterministic and excludes delegated domains", () => {
  const body = adminWorkflowSurface();
  assert.deepEqual(body.sections.map((section) => section.id), ["events", "participation", "projects", "badges", "audit"]);
  const serialized = JSON.stringify(body).toLowerCase();
  assert.doesNotMatch(serialized, /blog|campaign|email blast|contentitem/);
  assert.match(serialized, /approval required|approvalrequired/);
});
