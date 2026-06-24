import test from "node:test";
import assert from "node:assert/strict";

import {
  getPublicProject,
  listEventProjectReviewSubmissions,
  listEventProjectSubmissions,
  listOrganizerEventProjectSubmissions,
  listPublicProjects,
  setEventProjectSubmissionStatus,
  updateEventProjectSubmissionStatus,
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
    { event_slug: "hack-the-valley-2026", status: "showcased", project_id: "prj_show", slug: "show", title: "Show Project", team_name: "Show Team", description: "Public", repo_url: "https://github.com/example/show", demo_url: "https://show.example.com", tracks_json: "[]" },
    { event_slug: "hack-hours", status: "showcased", project_id: "prj_other", slug: "other", title: "Other Event Project", team_name: "Other Team", description: "Other", repo_url: "javascript:alert(document.domain)", demo_url: "data:text/html,<script>alert(1)</script>", tracks_json: "[]" },
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
          if (/FROM event_project_submissions eps\s+JOIN projects p/.test(sql) && /eps.event_slug = \? AND eps.event_instance_id = \? AND eps.project_id = \?/.test(sql)) {
            const [eventSlug, eventInstanceId, projectId] = this.args;
            const row = [...submissions.values()].find((item) => item.event_slug === eventSlug && item.event_instance_id === eventInstanceId && item.project_id === projectId);
            return row ? { ...row, title: projects.get(projectId)?.title || "Show Project", team_name: projects.get(projectId)?.team_name || "Show Team" } : null;
          }
          if (/FROM event_project_submissions eps\s+JOIN projects p/.test(sql) && /WHERE eps.id = \?/.test(sql)) {
            const [id, eventSlug, projectId] = this.args;
            const row = submissions.get(id);
            if (!row) return null;
            if (/eps\.event_slug = \?/.test(sql) && row.event_slug !== eventSlug) return null;
            if (/eps\.project_id = \?/.test(sql) && row.project_id !== projectId) return null;
            return { ...row, title: "Show Project", team_name: "Show Team" };
          }
          if (/SELECT \* FROM projects WHERE slug/.test(sql)) return [...projects.values()].find((project) => project.slug === this.args[0]) || null;
          if (/SELECT \* FROM projects WHERE id/.test(sql)) return projects.get(this.args[0]) || null;
          if (/FROM event_project_submissions eps\s+JOIN projects p/.test(sql) && /p\.slug = \?/.test(sql) && /eps\.status NOT IN \('hidden', 'rejected'\)/.test(sql)) {
            const [eventSlug, projectSlug] = this.args;
            const row = publicRows.find((item) => item.event_slug === eventSlug && item.slug === projectSlug && !["hidden", "rejected"].includes(item.status));
            return row ? {
              ...row,
              repo_url: row.repo_url,
              demo_url: row.demo_url,
              tracks_json: JSON.stringify(["AI", "Education"]),
              awards_json: JSON.stringify([{ award_slug: "overall", award_title: "Overall Winner", award_rank: 1, prize_amount_cents: 50000 }]),
              hero_uploads_json: JSON.stringify([{ key: "submissions/show-team/private-key.png", kind: "image", filename: "show.png", contentType: "image/png" }]),
              contact_email: "private@example.com",
              payload_json: JSON.stringify({ admin_notes: "private" })
            } : null;
          }
          throw new Error(`Unexpected first query: ${sql}`);
        },
        async all() {
          if (/FROM event_project_submissions eps\s+JOIN projects p/.test(sql) && /ORDER BY eps\.created_at DESC/.test(sql)) {
            const [eventSlug, projectId] = this.args;
            return { results: [...submissions.values()]
              .filter((row) => row.event_slug === eventSlug && row.project_id === projectId)
              .slice(0, 2)
              .map((row) => ({ ...row, title: "Show Project", team_name: "Show Team" })) };
          }
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
            const filteredByEvent = /eps\.event_slug = \?/.test(sql) ? publicRows.filter((row) => row.event_slug === this.args[0]) : publicRows;
            return { results: filteredByEvent.filter((row) => !excludeHidden || !["hidden", "rejected"].includes(row.status)) };
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

test("updateEventProjectSubmissionStatus scopes project status changes to one event instance", async () => {
  const db = createSubmissionDomainDb();
  const first = await submitProjectToEvent(db, { projectId: "prj_show", eventSlug: "hack-the-valley-2026", eventInstanceId: "inst_htv_2026_week_1" });
  const second = await submitProjectToEvent(db, { projectId: "prj_show", eventSlug: "hack-the-valley-2026", eventInstanceId: "inst_htv_2026_week_2" });

  const hidden = await updateEventProjectSubmissionStatus(db, {
    eventSlug: "hack-the-valley-2026",
    eventInstanceId: "inst_htv_2026_week_2",
    projectId: "prj_show",
    status: "hidden",
    actor: "usr_admin"
  });

  assert.equal(hidden.id, second.id);
  assert.equal(db.submissions.get(first.id).status, "submitted");
  assert.equal(db.submissions.get(second.id).status, "hidden");
  await assert.rejects(
    () => updateEventProjectSubmissionStatus(db, { eventSlug: "hack-the-valley-2026", projectId: "prj_show", status: "hidden" }),
    /eventInstanceId or eventProjectSubmissionId is required/
  );

  const uniqueDb = createSubmissionDomainDb();
  const only = await submitProjectToEvent(uniqueDb, { projectId: "prj_show", eventSlug: "hack-the-valley-2026", eventInstanceId: "inst_htv_2026_week_1" });
  const legacyHidden = await updateEventProjectSubmissionStatus(uniqueDb, { eventSlug: "hack-the-valley-2026", projectId: "prj_show", status: "hidden" });
  assert.equal(legacyHidden.id, only.id);
  assert.equal(uniqueDb.submissions.get(only.id).status, "hidden");

  await assert.rejects(
    () => updateEventProjectSubmissionStatus(db, { eventSlug: "hack-the-valley-2026", projectId: "prj_other", submissionId: second.id, status: "hidden" }),
    /Event project submission not found/
  );
  assert.equal(db.submissions.get(second.id).status, "hidden");
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
  assert.equal(rows[0].public_url, "/projects/hack-the-valley-2026/show/");
  const allPublic = await listPublicProjects(db);
  assert.deepEqual(allPublic.map((row) => row.title), ["Show Project", "Other Event Project"]);
  assert.equal(allPublic[1].repo_url, null);
  assert.equal(allPublic[1].demo_url, null);
  const publicListSql = db.statements.at(-2).sql;
  assert.match(publicListSql, /eps.status NOT IN \('hidden', 'rejected'\)/);
  assert.match(publicListSql, /eps2.status IN \('showcased', 'winner'\)/);
  assert.doesNotMatch(db.statements.at(-1).sql, /eps\.event_slug = \?/);
  const withHidden = await listPublicProjects(db, { eventSlug: "hack-the-valley-2026", includeHidden: true });
  assert.deepEqual(withHidden.map((row) => row.title), ["Show Project", "Hidden Project", "Rejected Project"]);
});

test("getPublicProject returns one canonical privacy-safe public project detail", async () => {
  const db = createSubmissionDomainDb();
  const project = await getPublicProject(db, { eventSlug: "hack-the-valley-2026", projectSlug: "show" });

  assert.equal(project.title, "Show Project");
  assert.equal(project.public_url, "/projects/hack-the-valley-2026/show/");
  assert.deepEqual(project.tracks, ["AI", "Education"]);
  assert.equal(project.awards[0].title, "Overall Winner");
  assert.equal(project.awards[0].prize_amount_cents, undefined);
  assert.equal(project.hero_media.url, "/api/projects/media?event=hack-the-valley-2026&project=show");
  assert.equal(project.hero_media.key, undefined);
  assert.equal(project.contact_email, undefined);
  assert.equal(project.payload_json, undefined);
  assert.doesNotMatch(JSON.stringify(project), /private@example\.com|admin_notes|50000|prize_amount_cents|private-key/);

  const hidden = await getPublicProject(db, { eventSlug: "hack-the-valley-2026", projectSlug: "hidden" });
  assert.equal(hidden, null);
  assert.match(db.statements.at(-1).sql, /eps\.status NOT IN \('hidden', 'rejected'\)/);

  const unsafeLinks = await getPublicProject(db, { eventSlug: "hack-hours", projectSlug: "other" });
  assert.equal(unsafeLinks.repo_url, null);
  assert.equal(unsafeLinks.demo_url, null);
});
