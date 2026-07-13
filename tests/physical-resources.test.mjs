import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import worker from "../worker.js";

const ADMIN_COOKIE = "htv_session=test-session";

function request(path, { method = "GET", body = null, cookie = ADMIN_COOKIE, headers = {} } = {}) {
  const finalHeaders = { ...headers };
  if (cookie) finalHeaders.cookie = cookie;
  if (body !== null && !finalHeaders["content-type"]) finalHeaders["content-type"] = "application/json";
  return new Request(`https://hackthevalley.org${path}`, {
    method,
    headers: finalHeaders,
    body: body === null ? undefined : JSON.stringify(body)
  });
}

function createPhysicalResourceDb({ role = "admin", session = true } = {}) {
  const state = {
    resources: [],
    checkouts: [],
    audit: [],
    users: [
      { id: "usr_admin", email: "admin@example.com", name: "Admin User" },
      { id: "usr_builder", email: "builder@example.com", name: "Builder Person" }
    ]
  };

  function resourceRow(id) {
    const resource = state.resources.find((item) => item.id === id);
    if (!resource) return null;
    const checkout = state.checkouts.find((item) => item.resource_id === id && !item.returned_at);
    return projectResourceRow(resource, checkout);
  }

  function projectResourceRow(resource, checkout = null) {
    const holder = checkout?.holder_user_id ? state.users.find((user) => user.id === checkout.holder_user_id) : null;
    return {
      ...resource,
      photo_url: resource.photo_url || null,
      checkout_id: checkout?.id || null,
      holder_user_id: checkout?.holder_user_id || null,
      holder_name: checkout?.holder_name || null,
      holder_email: checkout?.holder_email || null,
      holder_display_name: holder?.name || checkout?.holder_name || null,
      holder_display_email: holder?.email || checkout?.holder_email || null,
      checked_out_at: checkout?.checked_out_at || null,
      due_at: checkout?.due_at || null,
      checked_out_by_user_id: checkout?.checked_out_by_user_id || null,
      checkout_notes: checkout?.notes || null
    };
  }

  function projectCheckoutRow(checkout) {
    if (!checkout) return null;
    const holder = checkout.holder_user_id ? state.users.find((user) => user.id === checkout.holder_user_id) : null;
    return {
      ...checkout,
      holder_display_name: holder?.name || checkout.holder_name || null,
      holder_display_email: holder?.email || checkout.holder_email || null
    };
  }

  const db = {
    state,
    prepare(sql) {
      return {
        args: [],
        bind(...args) {
          this.args = args;
          return this;
        },
        async first() {
          if (/FROM user_sessions/.test(sql)) {
            return session ? {
              id: "usr_admin",
              email: "admin@example.com",
              name: "Admin User",
              session_id: "ses_admin",
              session_expires_at: "2099-01-01T00:00:00.000Z"
            } : null;
          }
          if (/FROM roles/.test(sql)) {
            return role ? { role, scope_type: "global", scope_id: "*", created_at: "2026-01-01T00:00:00.000Z" } : null;
          }
          if (/FROM physical_resources r/.test(sql) && /WHERE r\.id = \?/.test(sql)) {
            return resourceRow(this.args[0]);
          }
          if (/SELECT \* FROM physical_resource_checkouts/.test(sql)) {
            return state.checkouts.find((item) => item.resource_id === this.args[0] && !item.returned_at) || null;
          }
          if (/FROM physical_resource_checkouts c/.test(sql) && /WHERE c\.id = \?/.test(sql)) {
            return projectCheckoutRow(state.checkouts.find((item) => item.id === this.args[0]));
          }
          throw new Error(`Unexpected first query: ${sql}`);
        },
        async all() {
          if (/FROM physical_resources r/.test(sql)) {
            return { results: state.resources.map((resource) => projectResourceRow(resource, state.checkouts.find((item) => item.resource_id === resource.id && !item.returned_at))) };
          }
          if (/FROM physical_resource_checkouts c/.test(sql) && /WHERE c\.resource_id = \?/.test(sql)) {
            return { results: state.checkouts.filter((item) => item.resource_id === this.args[0]).map(projectCheckoutRow) };
          }
          if (/FROM roles/.test(sql)) return { results: [] };
          return { results: [] };
        },
        async run() {
          if (/INSERT INTO physical_resources/.test(sql)) {
            const [id, name, category, inventory_code, asset_tag, serial_number, description, location, condition, status, notes, metadata_json, created_at, updated_at, created_by_user_id, updated_by_user_id] = this.args;
            state.resources.push({ id, name, category, inventory_code, asset_tag, serial_number, description, location, condition, status, notes, photo_storage_key: null, photo_url: null, photo_original_filename: null, photo_content_type: null, photo_bytes: null, photo_uploaded_at: null, photo_uploaded_by_user_id: null, metadata_json, created_at, updated_at, created_by_user_id, updated_by_user_id });
            return { success: true };
          }
          if (/UPDATE physical_resources\s+SET name =/.test(sql)) {
            const [name, category, inventory_code, asset_tag, serial_number, description, location, condition, status, notes, metadata_json, updated_at, updated_by_user_id, id] = this.args;
            const resource = state.resources.find((item) => item.id === id);
            Object.assign(resource, { name, category, inventory_code, asset_tag, serial_number, description, location, condition, status, notes, metadata_json, updated_at, updated_by_user_id });
            return { success: true };
          }
          if (/UPDATE physical_resources SET status = 'checked_out'/.test(sql)) {
            const [updated_at, updated_by_user_id, id] = this.args;
            const resource = state.resources.find((item) => item.id === id);
            Object.assign(resource, { status: "checked_out", updated_at, updated_by_user_id });
            return { success: true };
          }
          if (/UPDATE physical_resources SET status = \?/.test(sql)) {
            const [status, updated_at, updated_by_user_id, id] = this.args;
            const resource = state.resources.find((item) => item.id === id);
            Object.assign(resource, { status, updated_at, updated_by_user_id });
            return { success: true };
          }
          if (/UPDATE physical_resources\s+SET status = 'retired'/.test(sql)) {
            const [updated_at, updated_by_user_id, notes, id] = this.args;
            const resource = state.resources.find((item) => item.id === id);
            Object.assign(resource, { status: "retired", updated_at, updated_by_user_id, notes: notes || resource.notes });
            return { success: true };
          }
          if (/INSERT INTO physical_resource_checkouts/.test(sql)) {
            const [id, resource_id, holder_user_id, holder_name, holder_email, checked_out_at, due_at, checked_out_by_user_id, notes, created_at, updated_at] = this.args;
            state.checkouts.push({ id, resource_id, holder_user_id, holder_name, holder_email, checked_out_at, due_at, returned_at: null, checked_out_by_user_id, returned_by_user_id: null, notes, return_notes: null, created_at, updated_at });
            return { success: true };
          }
          if (/UPDATE physical_resource_checkouts\s+SET returned_at/.test(sql)) {
            const [returned_at, returned_by_user_id, return_notes, updated_at, id] = this.args;
            const checkout = state.checkouts.find((item) => item.id === id && !item.returned_at);
            Object.assign(checkout, { returned_at, returned_by_user_id, return_notes, updated_at });
            return { success: true };
          }
          if (/UPDATE physical_resources\s+SET photo_storage_key/.test(sql)) {
            const [photo_storage_key, photo_url, photo_original_filename, photo_content_type, photo_bytes, photo_uploaded_at, photo_uploaded_by_user_id, updated_at, updated_by_user_id, id] = this.args;
            const resource = state.resources.find((item) => item.id === id);
            Object.assign(resource, { photo_storage_key, photo_url, photo_original_filename, photo_content_type, photo_bytes, photo_uploaded_at, photo_uploaded_by_user_id, updated_at, updated_by_user_id });
            return { success: true };
          }
          if (/INSERT INTO audit_events/.test(sql)) {
            const [id, action, actor_user_id, target_type, target_id, scope_type, scope_id, metadata_json, created_at] = this.args;
            state.audit.push({ id, action, actor_user_id, target_type, target_id, scope_type, scope_id, metadata_json, created_at });
            return { success: true };
          }
          if (/INSERT INTO admin_audit_events/.test(sql)) return { success: true };
          return { success: true };
        }
      };
    }
  };
  return db;
}

async function json(response) {
  return await response.json();
}

test("physical resource migration and admin UI are present without public exposure", () => {
  const migration = readFileSync(new URL("../migrations/0024_physical_resources_inventory.sql", import.meta.url), "utf8");
  const adminHtml = readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");

  assert.match(migration, /CREATE TABLE IF NOT EXISTS physical_resources/);
  assert.match(migration, /inventory_code TEXT UNIQUE/);
  assert.match(migration, /photo_storage_key TEXT/);
  assert.match(migration, /photo_url TEXT/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS physical_resource_checkouts/);
  assert.match(migration, /idx_physical_resource_checkouts_one_active/);
  assert.match(migration, /WHERE returned_at IS NULL/);

  assert.match(adminHtml, /id="physical-resources-admin"/);
  assert.match(adminHtml, /Inventory ID/);
  assert.match(adminHtml, /Stable resource URL/);
  assert.match(adminHtml, /name="photo_file"/);
  assert.match(adminHtml, /capture="environment"/);
  assert.match(adminHtml, /\/api\/admin\/physical-resources/);
  assert.match(adminHtml, /\/resources\//);
  assert.doesNotMatch(adminHtml, /\/api\/physical-resources/);
});

test("physical resource stable URL route preserves the resource id through admin login/create flow", async () => {
  const response = await worker.fetch(request("/resources/pres_label_123456", { cookie: null }), {}, {});
  assert.equal(response.status, 302);
  const location = response.headers.get("location");
  assert.ok(location);
  assert.match(location, /^https:\/\/hackthevalley\.org\/admin\?/);
  assert.match(location, /resource_id=pres_label_123456/);
  assert.match(location, /#physical-resource-form$/);
});

test("physical resource creation accepts caller-generated URL-safe ids without app-specific prefixes", async () => {
  const db = createPhysicalResourceDb();
  const env = { HTV_DB: db };
  const response = await worker.fetch(request("/api/admin/physical-resources", {
    method: "POST",
    body: { id: "HTV-Projector-Label-001", name: "HTV Projector" }
  }), env, {});
  assert.equal(response.status, 201);
  const created = await json(response);
  assert.equal(created.resource.id, "htv-projector-label-001");
  assert.equal(created.resource.stableUrlPath, "/resources/htv-projector-label-001");
});

test("physical resources API requires a signed-in admin session and rejects bootstrap-only access", async () => {
  const noSession = await worker.fetch(request("/api/admin/physical-resources", { cookie: null }), { HTV_DB: createPhysicalResourceDb() }, {});
  assert.equal(noSession.status, 401);

  const noRole = await worker.fetch(request("/api/admin/physical-resources"), { HTV_DB: createPhysicalResourceDb({ role: null }) }, {});
  assert.equal(noRole.status, 403);

  const bootstrap = await worker.fetch(request("/api/admin/physical-resources", {
    cookie: null,
    headers: { authorization: "Bearer bootstrap-secret" }
  }), {
    HTV_DB: createPhysicalResourceDb({ session: false }),
    HTV_ADMIN_TOKEN: "bootstrap-secret",
    HTV_ADMIN_BOOTSTRAP_TOKEN_ENABLED: "1"
  }, {});
  assert.equal(bootstrap.status, 403);
});

test("physical resources CRUD and checkouts use trusted admin actor provenance", async () => {
  const db = createPhysicalResourceDb();
  const env = { HTV_DB: db };

  const uncheckedHistoryCreate = await worker.fetch(request("/api/admin/physical-resources", {
    method: "POST",
    body: { name: "History bypass", status: "checked_out" }
  }), env, {});
  assert.equal(uncheckedHistoryCreate.status, 400);
  assert.equal(db.state.resources.length, 0);

  const createdResponse = await worker.fetch(request("/api/admin/physical-resources", {
    method: "POST",
    body: {
      id: "pres_label_123456",
      name: "HTV Projector",
      category: "AV",
      inventory_code: "HTV-INV-001",
      asset_tag: "HTV-AV-001",
      location: "Storage",
      actor_user_id: "usr_forged"
    }
  }), env, {});
  assert.equal(createdResponse.status, 201);
  const created = await json(createdResponse);
  assert.equal(created.resource.id, "pres_label_123456");
  assert.equal(created.resource.stableUrlPath, "/resources/pres_label_123456");
  assert.equal(created.resource.name, "HTV Projector");
  assert.equal(created.resource.inventoryCode, "HTV-INV-001");
  assert.equal(created.resource.createdByUserId, "usr_admin");
  assert.equal(db.state.resources[0].created_by_user_id, "usr_admin");
  assert.equal(db.state.audit.at(-1).actor_user_id, "usr_admin");
  assert.match(db.state.audit.at(-1).metadata_json, /admin-physical-resources/);

  const id = created.resource.id;
  const updateResponse = await worker.fetch(request(`/api/admin/physical-resources/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { location: "Mesh closet", updated_by_user_id: "usr_forged" }
  }), env, {});
  assert.equal(updateResponse.status, 200);
  const updated = await json(updateResponse);
  assert.equal(updated.resource.location, "Mesh closet");
  assert.equal(updated.resource.updatedByUserId, "usr_admin");


  const storedPhotos = new Map();
  const photoResponse = await worker.fetch(new Request(`https://hackthevalley.org/api/admin/physical-resources/${encodeURIComponent(id)}/photo?filename=projector.png`, {
    method: "POST",
    headers: { cookie: ADMIN_COOKIE, "content-type": "image/png", "content-length": "12" },
    body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
  }), {
    ...env,
    SUBMISSIONS_MEDIA: {
      async put(key, body, options) { storedPhotos.set(key, { body, options }); },
      async get(key) {
        const stored = storedPhotos.get(key);
        if (!stored) return null;
        return { body: new Uint8Array([1, 2, 3]), writeHttpMetadata(headers) { headers.set("content-type", stored.options.httpMetadata.contentType); } };
      }
    }
  }, {});
  assert.equal(photoResponse.status, 200);
  const photoJson = await json(photoResponse);
  assert.match(photoJson.resource.photoUrl, new RegExp(`/api/admin/physical-resources/${id}/photo`));
  assert.equal(photoJson.resource.photoContentType, "image/png");
  assert.equal(photoJson.resource.photoUploadedByUserId, "usr_admin");
  assert.equal(storedPhotos.size, 1);

  const photoGetResponse = await worker.fetch(request(`/api/admin/physical-resources/${encodeURIComponent(id)}/photo`), {
    ...env,
    SUBMISSIONS_MEDIA: {
      async get(key) {
        const stored = storedPhotos.get(key);
        return stored ? { body: new Uint8Array([1, 2, 3]), writeHttpMetadata(headers) { headers.set("content-type", stored.options.httpMetadata.contentType); } } : null;
      }
    }
  }, {});
  assert.equal(photoGetResponse.status, 200);
  assert.equal(photoGetResponse.headers.get("content-type"), "image/png");
  assert.equal(photoGetResponse.headers.get("x-content-type-options"), "nosniff");

  const uncheckedHistoryPatch = await worker.fetch(request(`/api/admin/physical-resources/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { status: "checked_out" }
  }), env, {});
  assert.equal(uncheckedHistoryPatch.status, 400);
  assert.equal(db.state.resources[0].status, "available");

  const checkoutResponse = await worker.fetch(request(`/api/admin/physical-resources/${encodeURIComponent(id)}/checkouts`, {
    method: "POST",
    body: { holder_email: "builder@example.com", notes: "For demo night", checked_out_by_user_id: "usr_forged" }
  }), env, {});
  assert.equal(checkoutResponse.status, 201);
  const checkout = await json(checkoutResponse);
  assert.equal(checkout.resource.status, "checked_out");
  assert.equal(checkout.checkout.holderEmail, "builder@example.com");
  assert.equal(checkout.checkout.checkedOutByUserId, "usr_admin");
  assert.equal(db.state.checkouts[0].checked_out_by_user_id, "usr_admin");

  const activeStatusPatch = await worker.fetch(request(`/api/admin/physical-resources/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { status: "available" }
  }), env, {});
  assert.equal(activeStatusPatch.status, 409);
  assert.equal(db.state.resources[0].status, "checked_out");

  const doubleCheckout = await worker.fetch(request(`/api/admin/physical-resources/${encodeURIComponent(id)}/checkouts`, {
    method: "POST",
    body: { holder_name: "Another Builder" }
  }), env, {});
  assert.equal(doubleCheckout.status, 409);

  const returnResponse = await worker.fetch(request(`/api/admin/physical-resources/${encodeURIComponent(id)}/checkouts`, {
    method: "POST",
    body: { action: "return", return_notes: "Back in case", returned_by_user_id: "usr_forged" }
  }), env, {});
  assert.equal(returnResponse.status, 200);
  const returned = await json(returnResponse);
  assert.equal(returned.resource.status, "available");
  assert.equal(returned.checkout.returnedByUserId, "usr_admin");
  assert.equal(db.state.checkouts[0].returned_by_user_id, "usr_admin");

  const historyResponse = await worker.fetch(request(`/api/admin/physical-resources/${encodeURIComponent(id)}/checkouts`), env, {});
  assert.equal(historyResponse.status, 200);
  const history = await json(historyResponse);
  assert.equal(history.count, 1);
  assert.equal(history.checkouts[0].returnNotes, "Back in case");

  const duplicateCreate = await worker.fetch(request("/api/admin/physical-resources", {
    method: "POST",
    body: { id, name: "Duplicate label" }
  }), env, {});
  assert.equal(duplicateCreate.status, 200);
  const duplicateResult = await json(duplicateCreate);
  assert.equal(duplicateResult.existing, true);
  assert.equal(duplicateResult.resource.id, id);
  assert.equal(db.state.resources.length, 1);

  const invalidIdCreate = await worker.fetch(request("/api/admin/physical-resources", {
    method: "POST",
    body: { id: "../../bad", name: "Bad label" }
  }), env, {});
  assert.equal(invalidIdCreate.status, 400);

  const retiredResponse = await worker.fetch(request(`/api/admin/physical-resources/${encodeURIComponent(id)}`, { method: "DELETE" }), env, {});
  assert.equal(retiredResponse.status, 200);
  const retired = await json(retiredResponse);
  assert.equal(retired.resource.status, "retired");
});

test("physical resource inventory is not exposed through public API routes", async () => {
  const env = { HTV_DB: createPhysicalResourceDb() };
  const publicList = await worker.fetch(request("/api/physical-resources", { cookie: null }), env, {});
  assert.equal(publicList.status, 404);

  const publicDetail = await worker.fetch(request("/api/physical-resources/pres_1", { cookie: null }), env, {});
  assert.equal(publicDetail.status, 404);
});
