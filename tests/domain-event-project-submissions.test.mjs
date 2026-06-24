import test from "node:test";
import assert from "node:assert/strict";

import {
  listEventProjectReviewSubmissions,
  listEventProjectSubmissions,
  listOrganizerEventProjectSubmissions,
  listPublicProjects,
  setEventProjectSubmissionStatus,
  submitEventInstanceProjectSubmission,
  submitOwnedProjectToEvent,
  submitProjectToEvent
} from "../functions/_lib/domain/submissions.js";

function createSubmissionDomainDb() {
  const statements = [];
  const submissions = new Map();
  const projects = new Map([
    ["prj_show", { id: "prj_show", slug: "show", title: "Show Project", team_name: "Show Team", canonical_submission_id: "sub_show" }]
  ]);
  const members = [{ project_id: "prj_show", user_id: "usr_maya", email: "maya@example.com", role: "owner" }];
  const publicRows = [
    { event_slug: "hack-the-valley-2026", status: "showcased", project_id: "prj_show", slug: "show", title: "Show Project", team_name: "Show Team", description: "Public", tracks_json: "[]" },
    { event_slug: "hack-the-valley-2026", status: "hidden", project_id: "prj_hidden", slug: "hidden", title: "Hidden Project", team_name: "Hidden Team", description: "Hidden", tracks_json: "[]" },
    { event_slug: "hack-the-valley-2026", status: "rejected", project_id: "prj_rejected", slug: "rejected", title: "Rejected Project", team_name: "Rejected Team", description: "Rejected", tracks_json: "[]" }
  ];

  return {
    statements,
    submissions,
    projects,
    members,
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) {
          this.args = args;
          statements.push(this);
          return this;
        },
        async run() {
          if (/INSERT INTO projects/.test(sql)) {
            const [id, slug, title, teamName, description, repoUrl, demoUrl, tracksJson, canonicalSubmissionId, createdAt, updatedAt] = this.args;
            const existing = [...projects.values()].find((project) => project.slug === slug);
            const project = existing || { id, slug, created_at: createdAt };
            Object.assign(project, { title, team_name: teamName, description, repo_url: repoUrl, demo_url: demoUrl, tracks_json: tracksJson, canonical_submission_id: canonicalSubmissionId, updated_at: updatedAt });
            projects.set(project.id, project);
            return { success: true };
          }
          if (/INSERT INTO event_project_submissions/.test(sql)) {
            const [id, eventSlug, eventInstanceId, projectId, submissionId, status, source, createdAt, updatedAt] = this.args;
            const row = submissions.get(id) || { id, created_at: createdAt };
            Object.assign(row, { event_slug: eventSlug, event_instance_id: eventInstanceId, project_id: projectId, submission_id: submissionId, status, source, updated_at: updatedAt });
            submissions.set(id, row);
            return { success: true };
          }
          if (/UPDATE event_project_submissions/.test(sql) && /WHERE id = \?/.test(sql)) {
            const [status, updatedAt, id] = this.args;
            const row = submissions.get(id);
            Object.assign(row, { status, updated_at: updatedAt });
            return { success: true };
          }
          if (/UPDATE project_members/.test(sql)) return { success: true };
          throw new Error(`Unexpected run query: ${sql}`);
        },
        async first() {
          if (/SELECT \* FROM users WHERE id/.test(sql)) return this.args[0] === "usr_maya" ? { id: "usr_maya", email: "maya@example.com", name: "Maya Rivera" } : null;
          if (/FROM projects p\s+JOIN project_members pm/.test(sql)) {
            const [projectId, userId, email] = this.args;
            const member = members.find((row) => row.project_id === projectId && (row.user_id === userId || row.email?.toLowerCase() === String(email).toLowerCase()));
            return member ? projects.get(projectId) : null;
          }
          if (/FROM event_project_submissions\s+WHERE event_slug = \? AND project_id = \?/.test(sql)) {
            const [eventSlug, projectId] = this.args;
            return [...submissions.values()].find((row) => row.event_slug === eventSlug && row.project_id === projectId) || null;
          }
          if (/FROM event_project_submissions eps\s+JOIN projects p/.test(sql) && /WHERE eps.id = \?/.test(sql)) {
            const row = submissions.get(this.args[0]);
            return row ? { ...row, title: "Show Project", team_name: "Show Team" } : null;
          }
          if (/SELECT \* FROM projects WHERE slug/.test(sql)) return [...projects.values()].find((project) => project.slug === this.args[0]) || null;
          if (/SELECT \* FROM projects WHERE id/.test(sql)) return projects.get(this.args[0]) || null;
          throw new Error(`Unexpected first query: ${sql}`);
        },
        async all() {
          if (/FROM event_project_submissions eps\s+JOIN projects p/.test(sql) && /s.id AS submission_id/.test(sql) && /ORDER BY lower\(p.title\)/.test(sql)) {
            return { results: [{
              event_project_submission_id: "eps_show",
              event_slug: "hack-the-valley-2026",
              event_instance_id: "inst_htv_2026",
              project_id: "prj_show",
              submission_id: "sub_show",
              title: "Show Project",
              team_name: "Show Team",
              status: "accepted",
              contact_email: "private@example.com",
              payload_json: JSON.stringify({ admin_notes: "private" })
            }] };
          }
          if (/FROM event_project_submissions eps\s+JOIN projects p/.test(sql) && /LEFT JOIN event_project_awards/.test(sql)) {
            const excludeHidden = /eps.status NOT IN \('hidden', 'rejected'\)/.test(sql);
            return { results: publicRows.filter((row) => !excludeHidden || !["hidden", "rejected"].includes(row.status)) };
          }
          throw new Error(`Unexpected all query: ${sql}`);
        }
      };
      return statement;
    }
  };
}

test("submitProjectToEvent creates an event-specific submission link", async () => {
  const db = createSubmissionDomainDb();
  const submission = await submitProjectToEvent(db, {
    projectId: "prj_show",
    eventSlug: "hack-the-valley-2026",
    eventInstanceId: "inst_htv_2026",
    submissionId: "sub_show",
    source: "admin"
  });

  assert.equal(submission.status, "submitted");
  assert.equal(submission.project_id, "prj_show");
  assert.equal(submission.event_project_submission_id, submission.id);
  assert.match(db.statements.map((statement) => statement.sql).join("\n"), /INSERT INTO event_project_submissions/);
});

test("submitOwnedProjectToEvent forces participant submissions to submitted status", async () => {
  const db = createSubmissionDomainDb();
  const result = await submitOwnedProjectToEvent(db, "usr_maya", "prj_show", {
    event_slug: "hack-the-valley-2026",
    event_instance_id: "inst_htv_2026",
    status: "winner"
  });

  assert.equal(result.submission.status, "submitted");
  assert.equal([...db.submissions.values()][0].status, "submitted");
});

test("submitOwnedProjectToEvent cannot restore hidden or rejected organizer decisions", async () => {
  const db = createSubmissionDomainDb();
  await submitProjectToEvent(db, { projectId: "prj_show", eventSlug: "hack-the-valley-2026", eventInstanceId: "inst_htv_2026" });
  db.submissions.values().next().value.status = "rejected";

  await assert.rejects(
    () => submitOwnedProjectToEvent(db, "usr_maya", "prj_show", { event_slug: "hack-the-valley-2026", status: "submitted" }),
    /closed by an organizer/
  );
  assert.equal(db.submissions.values().next().value.status, "rejected");
});

test("setEventProjectSubmissionStatus updates showcase status without editing the durable project", async () => {
  const db = createSubmissionDomainDb();
  const submission = await submitProjectToEvent(db, { projectId: "prj_show", eventSlug: "hack-the-valley-2026", eventInstanceId: "inst_htv_2026" });
  const hidden = await setEventProjectSubmissionStatus(db, { submissionId: submission.id, status: "hidden", actor: "admin" });

  assert.equal(hidden.status, "hidden");
  const sql = db.statements.map((statement) => statement.sql).join("\n");
  assert.match(sql, /UPDATE event_project_submissions/);
  assert.doesNotMatch(sql, /UPDATE projects/);
  await assert.rejects(
    () => setEventProjectSubmissionStatus(db, { submissionId: submission.id, status: "deleted" }),
    /Unsupported project submission status/
  );
});

test("listEventProjectSubmissions returns event rows without private contact fields", async () => {
  const db = createSubmissionDomainDb();
  const rows = await listEventProjectSubmissions(db, { eventSlug: "hack-the-valley-2026", eventInstanceId: "inst_htv_2026" });

  assert.equal(rows[0].title, "Show Project");
  assert.equal(rows[0].submission_id, "sub_show");
  assert.equal(Object.hasOwn(rows[0], "contact_email"), false);
});

test("event project route boundaries keep review and organizer list filters explicit", async () => {
  const reviewDb = createSubmissionDomainDb();
  await listEventProjectReviewSubmissions(reviewDb, { eventSlug: "hack-the-valley-2026" });
  assert.doesNotMatch(reviewDb.statements.at(-1).sql, /eps\.status != 'hidden'/);

  const organizerDb = createSubmissionDomainDb();
  await listOrganizerEventProjectSubmissions(organizerDb, { eventSlug: "hack-the-valley-2026", eventInstanceId: "inst_htv_2026" });
  assert.match(organizerDb.statements.at(-1).sql, /eps\.status != 'hidden'/);
});

test("event project submission boundary derives provenance from route context", async () => {
  const db = createSubmissionDomainDb();
  const project = await submitEventInstanceProjectSubmission(db, {
    eventSlug: "hack-the-valley-2026",
    eventInstanceId: "inst_htv_2026",
    source: "Organizer User",
    input: {
      title: "Route Boundary Demo",
      team_name: "Boundary Team",
      status: "accepted",
      source: "request-body-should-not-win"
    }
  });

  const row = [...db.submissions.values()].find((submission) => submission.project_id === project.id);
  assert.equal(row.status, "accepted");
  assert.equal(row.source, "organizer_user");
  assert.notEqual(row.source, "request-body-should-not-win");
});

test("listPublicProjects hides rejected or hidden event submissions but not the project model", async () => {
  const db = createSubmissionDomainDb();
  const rows = await listPublicProjects(db, { eventSlug: "hack-the-valley-2026" });

  assert.deepEqual(rows.map((row) => row.title), ["Show Project"]);
  assert.match(db.statements.at(-1).sql, /eps.status NOT IN \('hidden', 'rejected'\)/);
  const withHidden = await listPublicProjects(db, { eventSlug: "hack-the-valley-2026", includeHidden: true });
  assert.deepEqual(withHidden.map((row) => row.title), ["Show Project", "Hidden Project", "Rejected Project"]);
});
