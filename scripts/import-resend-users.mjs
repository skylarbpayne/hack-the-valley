#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import crypto from "node:crypto";

const apiKey = process.env.RESEND_API_KEY;
const audienceId = process.env.RESEND_AUDIENCE_ID;
const dbBinding = process.env.HTV_D1_BINDING || "HTV_DB";
// Default command shape: wrangler d1 execute HTV_DB --remote --file <generated.sql>

if (!apiKey) {
  console.error("RESEND_API_KEY is required.");
  process.exit(1);
}

function userId() {
  return `usr_${crypto.randomUUID().replaceAll("-", "")}`;
}

function sqlString(value) {
  if (value === undefined || value === null || value === "") return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function resend(path) {
  const response = await fetch(`https://api.resend.com${path}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "hack-the-valley-resend-user-import/1.0"
    }
  });
  if (!response.ok) {
    throw new Error(`Resend request failed ${response.status}: ${await response.text()}`);
  }
  return await response.json();
}

async function listContacts() {
  const contacts = [];
  let after = null;
  for (;;) {
    const params = new URLSearchParams({ limit: "100" });
    if (after) params.set("after", after);
    const path = audienceId
      ? `/audiences/${encodeURIComponent(audienceId)}/contacts?${params}`
      : `/contacts?${params}`;
    const data = await resend(path);
    const page = data.data || data.contacts || [];
    contacts.push(...page);
    after = data.next || data.next_cursor || data.pagination?.next;
    if (!after || page.length === 0) break;
  }
  return contacts;
}

function contactEmail(contact) {
  return String(contact.email || contact.email_address || "").trim().toLowerCase();
}

function contactName(contact) {
  const first = contact.first_name || contact.firstName || "";
  const last = contact.last_name || contact.lastName || "";
  const full = `${first} ${last}`.trim();
  return contact.name || full || null;
}

const contacts = await listContacts();
const now = new Date().toISOString();
const rows = [];
const seen = new Set();
for (const contact of contacts) {
  const email = contactEmail(contact);
  if (!email || seen.has(email)) continue;
  seen.add(email);
  rows.push(`(${sqlString(userId())}, ${sqlString(email)}, ${sqlString(contactName(contact))}, ${sqlString(contact.first_name || contact.firstName)}, ${sqlString(contact.last_name || contact.lastName)}, NULL, NULL, ${sqlString(JSON.stringify({ resend_id: contact.id || null, source: "resend-import" }))}, ${sqlString(now)}, ${sqlString(now)})`);
}

if (!rows.length) {
  console.log("No Resend contacts found to import.");
  process.exit(0);
}

const sql = `INSERT INTO users (id, email, name, first_name, last_name, phone, school, metadata_json, created_at, updated_at)\nVALUES\n${rows.join(",\n")}\nON CONFLICT(email) DO UPDATE SET\n  name = COALESCE(excluded.name, users.name),\n  first_name = COALESCE(excluded.first_name, users.first_name),\n  last_name = COALESCE(excluded.last_name, users.last_name),\n  metadata_json = COALESCE(excluded.metadata_json, users.metadata_json),\n  updated_at = excluded.updated_at;\n`;

const dir = mkdtempSync(join(tmpdir(), "htv-resend-users-"));
const sqlPath = join(dir, "import-users.sql");
writeFileSync(sqlPath, sql);
try {
  const command = `wrangler d1 execute ${dbBinding} --remote --file ${sqlPath}`;
  const result = spawnSync("npx", command.split(" "), { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
  console.log(`Imported/updated ${rows.length} Resend contacts into users.`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
