import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const doc = readFileSync(new URL("../docs/domain-model.md", import.meta.url), "utf8");

const requiredConcepts = [
  "Person",
  "EventSeries",
  "EventInstance",
  "Participation",
  "Project",
  "EventProjectSubmission",
  "Badge",
  "BadgeAward",
  "PhysicalResource",
  "ContentItem",
  "Campaign",
  "AudienceSegment",
  "MessageDraft",
  "MessageDelivery",
  "AuditEvent"
];

function sectionAfterHeading(heading) {
  const headingPattern = new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
  const match = doc.match(headingPattern);
  assert.ok(match, `Missing ## ${heading} section`);

  const sectionStart = match.index + match[0].length;
  const nextHeading = doc.slice(sectionStart).search(/^##\s+/m);
  return nextHeading === -1
    ? doc.slice(sectionStart)
    : doc.slice(sectionStart, sectionStart + nextHeading);
}

function tableRowsAfterHeading(heading) {
  return sectionAfterHeading(heading)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"))
    .filter((line) => !/^\|\s*-+\s*\|/.test(line))
    .slice(1)
    .map((line) => line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim().replace(/^`|`$/g, "")));
}

test("domain vocabulary documents every required concept", () => {
  const rows = tableRowsAfterHeading("Domain vocabulary");
  const concepts = new Set(rows.map(([concept]) => concept));

  for (const concept of requiredConcepts) {
    assert.ok(concepts.has(concept), `Missing domain vocabulary row for ${concept}`);
  }

  for (const row of rows) {
    assert.equal(row.length, 4, `Vocabulary row should have 4 cells: ${row.join(" | ")}`);
    assert.ok(row[1], `${row[0]} needs a meaning`);
    assert.ok(row[2], `${row[0]} needs ownership/rules`);
    assert.ok(row[3], `${row[0]} needs current representation`);
  }
});

test("storage compatibility table maps every concept to current implementation and migration status", () => {
  const rows = tableRowsAfterHeading("Storage compatibility table");
  const byConcept = new Map(rows.map((row) => [row[0], row]));

  for (const concept of requiredConcepts) {
    const row = byConcept.get(concept);
    assert.ok(row, `Missing storage compatibility row for ${concept}`);
    assert.equal(row.length, 3, `Storage row should have 3 cells for ${concept}`);
    assert.match(row[1], /`[^`]+`/, `${concept} should name current tables, files, or routes`);
    assert.match(row[2], /Milestone 0|current|today|represented|first-class|compatible/i, `${concept} should state migration status`);
  }
});

test("message and campaign concepts remain approval gated", () => {
  const vocabulary = new Map(tableRowsAfterHeading("Domain vocabulary").map((row) => [row[0], row]));
  const approvalGates = sectionAfterHeading("Approval gates and no-production-mutation rule").toLowerCase();

  assert.match(vocabulary.get("Campaign").join(" "), /approval/i);
  assert.match(approvalGates, /campaign/);
  assert.match(approvalGates, /messagedraft/);
  assert.match(approvalGates, /messagedelivery/);
  assert.match(approvalGates, /approval-gated/);

  for (const guardedAction of [
    "create `functions/_lib/domain/*`",
    "change routes",
    "deploy",
    "run migrations",
    "mutate production data"
  ]) {
    assert.ok(
      approvalGates.includes(guardedAction),
      `Approval gates should guard against: ${guardedAction}`
    );
  }
});
